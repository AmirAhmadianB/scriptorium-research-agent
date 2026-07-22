"""Entity graph — Sprint 3 Pass 1's genuinely new capability (no existing
analog in this repo; see docs/RD-AGENT-EXTRACTION-PASS0.md). Adapted from
microsoft/RD-Agent's components/knowledge_management/graph.py (MIT — see
../NOTICE), trimmed of the RD-Agent-specific visualization helpers
(coordinate layout functions) this project has no use for.

get_nodes_intersection is the brief's "gap-finding upgrade": nodes reachable
within n steps of TWO or more well-studied topic clusters, but with no
direct edge between the clusters themselves, are candidate structural gaps
(Swanson-style undiscovered linkages) — a stronger signal than asking an
LLM to free-associate a gap. Sprint 3 Pass 4 wires this into gap proposal."""
from __future__ import annotations
import logging
from pathlib import Path
from collections import deque
from typing import Any, NoReturn, Union

from .persistence import KnowledgeBase
from .vector_store import KnowledgeMetaData, PDVectorBase, VectorBase, cosine

logger = logging.getLogger("scriptorium_ingest.knowledge")

Node = KnowledgeMetaData


class UndirectedNode(Node):
    def __init__(self, content: str = "", label: str = "", embedding: Any = None, appendix: Any = None) -> None:
        super().__init__(content, label, embedding)
        self.neighbors: set["UndirectedNode"] = set()
        self.appendix = appendix
        assert isinstance(content, str), "content must be a string"

    def add_neighbor(self, node: "UndirectedNode") -> None:
        self.neighbors.add(node)
        node.neighbors.add(self)

    def remove_neighbor(self, node: "UndirectedNode") -> None:
        if node in self.neighbors:
            self.neighbors.remove(node)
            node.neighbors.remove(self)

    def get_neighbors(self) -> set["UndirectedNode"]:
        return self.neighbors

    def __str__(self) -> str:
        return f"UndirectedNode(id={self.id}, label={self.label}, content={self.content[:100]!r})"

    __repr__ = __str__


class Graph(KnowledgeBase):
    def __init__(self, path: str | Path | None = None) -> None:
        self.nodes: dict[str, Node] = {}
        super().__init__(path=path)

    def size(self) -> int:
        return len(self.nodes)

    def get_node(self, node_id: str) -> Node | None:
        return self.nodes.get(node_id)

    def add_node(self, **kwargs: Any) -> NoReturn:
        raise NotImplementedError

    def get_all_nodes(self) -> list[Node]:
        return list(self.nodes.values())

    def get_all_nodes_by_label_list(self, label_list: list[str]) -> list[Node]:
        return [node for node in self.nodes.values() if node.label in label_list]

    def find_node(self, content: str, label: str) -> Node | None:
        for node in self.nodes.values():
            if node.content == content and node.label == label:
                return node
        return None

    def __str__(self) -> str:
        return f"Graph(nodes={len(self.nodes)})"


class UndirectedGraph(Graph):
    """Undirected entity graph. One instance per professor, persisted to
    data/knowledge/<professorId>/graph.dill (see knowledge/store.py)."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.vector_base: VectorBase = PDVectorBase()
        super().__init__(path=path)

    def __str__(self) -> str:
        return f"UndirectedGraph(nodes={len(self.nodes)})"

    def add_node(
        self,
        node: UndirectedNode,
        neighbor: UndirectedNode | None = None,
    ) -> None:
        node = self._resolve_or_register(node)
        if neighbor is not None:
            neighbor = self._resolve_or_register(neighbor)
            node.add_neighbor(neighbor)

    def _resolve_or_register(self, node: UndirectedNode) -> UndirectedNode:
        if tmp := self.get_node(node.id):
            return tmp
        if tmp := self.find_node(content=node.content, label=node.label):
            return tmp
        node.create_embedding()
        self.vector_base.add(document=node)
        self.nodes[node.id] = node
        return node

    def add_nodes(self, node: UndirectedNode, neighbors: list[UndirectedNode]) -> None:
        if not neighbors:
            self.add_node(node)
        else:
            for neighbor in neighbors:
                self.add_node(node, neighbor=neighbor)

    def get_node(self, node_id: str) -> UndirectedNode | None:
        return self.nodes.get(node_id)

    def get_nodes_within_steps(
        self,
        start_node: UndirectedNode,
        steps: int = 1,
        constraint_labels: list[str] | None = None,
        *,
        block: bool = False,
    ) -> list[UndirectedNode]:
        """Nodes whose graph distance from start_node is <= steps (n-hop
        traversal — the brief's 'iterative discovery' primitive)."""
        visited: set[UndirectedNode] = set()
        queue = deque([(start_node, 0)])
        result: list[UndirectedNode] = []

        while queue:
            node, current_steps = queue.popleft()
            if current_steps > steps:
                break
            if node not in visited:
                visited.add(node)
                result.append(node)
                for neighbor in sorted(self.get_node(node.id).neighbors, key=lambda x: x.content):
                    if neighbor not in visited and not (block and neighbor.label not in (constraint_labels or [])):
                        queue.append((neighbor, current_steps + 1))

        if constraint_labels:
            result = [n for n in result if n.label in constraint_labels]
        if start_node in result:
            result.remove(start_node)
        return result

    def get_nodes_intersection(
        self,
        nodes: list[UndirectedNode],
        steps: int = 1,
        constraint_labels: list[str] | None = None,
    ) -> list[UndirectedNode]:
        """Nodes reachable within `steps` of EVERY node in `nodes` — i.e.
        sitting between two-or-more topic clusters with no direct edge
        between them. Structural gap candidates (Swanson linkages)."""
        assert len(nodes) >= 2, "nodes length must be >= 2"
        intersection: list[UndirectedNode] | None = None
        for node in nodes:
            within = self.get_nodes_within_steps(node, steps=steps, constraint_labels=constraint_labels)
            intersection = within if intersection is None else self.intersection(intersection, within)
        return intersection or []

    def semantic_search(
        self,
        node: Union[UndirectedNode, str],
        similarity_threshold: float = 0.0,
        topk_k: int | None = None,
        constraint_labels: list[str] | None = None,
    ) -> list[UndirectedNode]:
        if isinstance(node, str):
            node = UndirectedNode(content=node)
        docs, _scores = self.vector_base.search(
            content=node.content, topk_k=topk_k, similarity_threshold=similarity_threshold,
            constraint_labels=constraint_labels,
        )
        return [self.get_node(doc.id) for doc in docs if self.get_node(doc.id) is not None]

    def query_by_content(
        self,
        content: str | list[str],
        topk_k: int = 5,
        step: int = 1,
        constraint_labels: list[str] | None = None,
        similarity_threshold: float = 0.0,
    ) -> list[UndirectedNode]:
        """Search by content similarity, then expand each hit by `step`
        graph hops — content match plus structural context."""
        contents = [content] if isinstance(content, str) else content
        res: list[UndirectedNode] = []
        for query in contents:
            for hit in self.semantic_search(query, topk_k=topk_k, similarity_threshold=similarity_threshold):
                for n in self.get_nodes_within_steps(hit, steps=step, constraint_labels=constraint_labels):
                    if n not in res:
                        res.append(n)
                if hit not in res:
                    res.append(hit)
                if len(res) >= topk_k:
                    break
        return res[:topk_k]

    @staticmethod
    def intersection(nodes1: list[UndirectedNode], nodes2: list[UndirectedNode]) -> list[UndirectedNode]:
        return [n for n in nodes1 if n in nodes2]

    @staticmethod
    def cal_distance(node1: UndirectedNode, node2: UndirectedNode) -> float:
        return cosine(node1.embedding, node2.embedding)
