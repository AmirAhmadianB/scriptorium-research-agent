"""Sprint 3 Pass 1 gate: stores import and run with zero rdagent.* imports;
a smoke test adds and searches a document and adds and traverses a node.
Uses the real local embedding provider (fastembed, in-process ONNX, no
network) — fast enough for the fast test suite, no live-LLM call involved."""
from __future__ import annotations
import tempfile
from pathlib import Path

from scriptorium_ingest.knowledge.vector_store import Document, PDVectorBase
from scriptorium_ingest.knowledge.graph import UndirectedGraph, UndirectedNode


def test_vector_store_add_and_search():
    vb = PDVectorBase()
    vb.add(Document(content="reflection electron holography of semiconductor surfaces", label="topic"))
    vb.add(Document(content="tax policy reform in developing economies", label="topic"))

    docs, scores = vb.search("electron holography surface metrology", topk_k=1)
    assert len(docs) == 1
    assert "holography" in docs[0].content
    assert scores[0] > 0


def test_vector_store_persists_round_trip():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "vb.dill"
        vb = PDVectorBase(path=path)
        vb.add(Document(content="phase retrieval via gradient descent", label="topic"))
        vb.dump()

        reloaded = PDVectorBase(path=path)
        assert reloaded.shape()[0] == 1


def test_graph_add_node_and_traverse():
    graph = UndirectedGraph()
    a = UndirectedNode(content="electron ptychography", label="topic")
    b = UndirectedNode(content="phase retrieval", label="topic")
    c = UndirectedNode(content="semiconductor metrology", label="topic")

    graph.add_node(a, neighbor=b)   # a -- b
    graph.add_node(b, neighbor=c)   # b -- c  (a and c are 2 hops apart, no direct edge)

    assert graph.size() == 3
    one_hop = graph.get_nodes_within_steps(graph.get_node(a.id), steps=1)
    assert {n.content for n in one_hop} == {"phase retrieval"}

    two_hop = graph.get_nodes_within_steps(graph.get_node(a.id), steps=2)
    assert {n.content for n in two_hop} == {"phase retrieval", "semiconductor metrology"}


def test_graph_nodes_intersection_finds_structural_gap():
    """The brief's structural-gap primitive: a node reachable within n steps
    of TWO different starting clusters, with no direct edge between the
    clusters themselves."""
    graph = UndirectedGraph()
    cluster_a = UndirectedNode(content="electron holography", label="topic")
    cluster_b = UndirectedNode(content="deep learning phase retrieval", label="topic")
    bridge = UndirectedNode(content="learned priors for imaging", label="topic")

    graph.add_node(cluster_a, neighbor=bridge)
    graph.add_node(cluster_b, neighbor=bridge)
    # cluster_a and cluster_b are NOT directly connected — only via `bridge`.

    intersection = graph.get_nodes_intersection(
        [graph.get_node(cluster_a.id), graph.get_node(cluster_b.id)], steps=1,
    )
    assert {n.content for n in intersection} == {"learned priors for imaging"}


def test_graph_persists_round_trip():
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / "graph.dill"
        graph = UndirectedGraph(path=path)
        a = UndirectedNode(content="node a", label="topic")
        b = UndirectedNode(content="node b", label="topic")
        graph.add_node(a, neighbor=b)
        graph.dump()

        reloaded = UndirectedGraph(path=path)
        assert reloaded.size() == 2
        neighbors = reloaded.get_node(a.id).neighbors
        assert {n.content for n in neighbors} == {"node b"}
