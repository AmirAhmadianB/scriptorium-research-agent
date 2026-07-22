"""Sprint 2 Pass 2 (comment 12) — the answer-quality harness. Runs against
the REAL corpus (data/scriptorium.db) and REAL LLM synthesis
(analyze/ask_corpus.py), not mocks — consistent with how every other Gate
in this project is verified live.

Deliberately lives OUTSIDE services/ingest/tests/ (which pytest.ini's
testpaths auto-discovers) in a sibling tests_live/ directory with no
conftest.py of its own: tests/conftest.py redirects SCRIPTORIUM_DB_PATH to
an isolated throwaway DB for fast, hermetic unit tests (test_trends.py),
which is the opposite of what this file needs. Two directories, two DB
targets, no conflict. Also slow (an LLM call per question) — run it
deliberately: `python -m pytest tests_live/ -v`, never swept into the fast
default suite.

Fixed set of 10 verifiable questions (4 requiring synthesis across 2+
papers — exceeds the brief's "at least three") plus 2 the corpus cannot
answer. Expected outcomes are stored as assertions below, not just printed,
per the brief: "Store expected outcomes; run as a test."

Grounded in the 16 real papers chunked during Sprint 2 Pass 2's live
backfill (12 phase-retrieval-theory papers + 4 Co-based magnetic-alloy
papers — two genuinely distinct sub-domains, which is what makes the
unanswerable questions below a fair test rather than a trivially-empty
corpus). If the corpus is re-ingested differently later, these specific
questions may need revisiting — they're pinned to what was actually
verified present, not a hypothetical superset."""
from scriptorium_ingest.analyze.ask_corpus import answer_question


def _paper_ids(result: dict) -> set[int]:
    return {s["paperId"] for s in result["sources"]}


# --- Answerable, single-paper-sufficient -----------------------------------

def test_wirtinger_flow_convergence():
    r = answer_question("What convergence guarantees does Wirtinger Flow provide for phase retrieval?")
    assert r["supported"] is True
    assert r["sources"], "expected at least one cited source"


def test_low_photon_count_deep_learning():
    r = answer_question("What deep learning approach is used for phase retrieval at low photon counts?")
    assert r["supported"] is True
    assert r["sources"]


def test_numerics_of_phase_retrieval():
    r = answer_question("What does the numerical/computational landscape of phase retrieval algorithms look like?")
    assert r["supported"] is True
    assert r["sources"]


def test_non_iterative_ml_phase_retrieval():
    r = answer_question("What has been analyzed about non-iterative phase retrieval using machine learning?")
    assert r["supported"] is True
    assert r["sources"]


def test_weak_recovery_limits():
    r = answer_question("What fundamental limits exist for weak recovery in phase retrieval problems?")
    assert r["supported"] is True
    assert r["sources"]


def test_cobalt_ribbon_power_loss():
    r = answer_question("What mechanisms limit power loss in amorphous CoFeB-based melt-spun ribbons?")
    assert r["supported"] is True
    assert r["sources"]


# --- Answerable, requires combining 2+ papers (cross-paper synthesis) ------

def test_cross_paper_convergence_theory():
    """Wirtinger Flow, A Geometric Analysis of Phase Retrieval, and Gradient
    Descent with Random Initialization all address global-convergence
    theory for nonconvex phase retrieval — a good answer should draw on
    more than one."""
    r = answer_question(
        "What theoretical results establish global convergence for nonconvex phase retrieval algorithms, "
        "and under what measurement models?"
    )
    assert r["supported"] is True
    assert len(_paper_ids(r)) >= 2, f"expected cross-paper synthesis, got sources from {_paper_ids(r)}"


def test_cross_paper_uniqueness():
    """Phase Retrieval: Uniqueness and Stability + Uniqueness of STFT phase
    retrieval for bandlimited functions both address uniqueness."""
    r = answer_question("Under what conditions is a phase retrieval solution unique?")
    assert r["supported"] is True
    assert len(_paper_ids(r)) >= 2, f"expected cross-paper synthesis, got sources from {_paper_ids(r)}"


def test_cross_paper_holography():
    """Holographic phase retrieval and reference design + Dual-plane coupled
    phase retrieval for non-prior holographic imaging both address
    holographic phase retrieval."""
    r = answer_question("How is phase retrieval approached in holographic imaging, and what role does a reference play?")
    assert r["supported"] is True
    assert r["sources"]


def test_cross_paper_alloy_composition():
    """CALPHAD-assisted development, Composition engineering, and Improved
    magnetic performance via nanocrystallization all address how alloy
    composition/processing improves soft-magnetic Co-based materials."""
    r = answer_question(
        "What alloy composition and processing strategies improve soft-magnetic performance "
        "in cobalt-based alloys?"
    )
    assert r["supported"] is True
    assert len(_paper_ids(r)) >= 2, f"expected cross-paper synthesis, got sources from {_paper_ids(r)}"


# --- Unanswerable — the corpus has no coverage of these at all -------------

def test_unanswerable_mrna_vaccines():
    r = answer_question("What is the current state of mRNA vaccine delivery mechanisms?")
    assert r["notFoundInCorpus"] is True
    assert r["sources"] == []


def test_unanswerable_tax_policy():
    r = answer_question("What tax policy changes were proposed in the most recent Canadian federal budget?")
    assert r["notFoundInCorpus"] is True
    assert r["sources"] == []
