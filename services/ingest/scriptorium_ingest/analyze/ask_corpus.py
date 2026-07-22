"""Sprint 2 Pass 2 (comment 12) — 'Ask the corpus', rebuilt as
retrieval-then-synthesis. Pass 2.2/2.3 already built genuine semantic
retrieval (analyze/corpus_ingest.py's query_corpus) with real chunking and
embeddings — the defect was that the feature stopped there, returning raw
ranked snippets instead of an actual answer. This module adds the missing
synthesis step on top of that SAME retrieval (imported, not reimplemented):
a grounded, per-claim-attributed answer, explicit cross-paper synthesis
when multiple sources are needed, and an honest decline when the corpus
doesn't actually support an answer instead of guessing from general
knowledge.

Run: python -m scriptorium_ingest.analyze.ask_corpus --question "..." [--professor default] [--k 8]
"""
from __future__ import annotations

import argparse
import json
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from ..llm.dispatch import complete
from ..config import task_model
from ..db import conn, describe_current_research_focus
from .corpus_ingest import query_corpus

# Empirical floor for BAAI/bge-small-en-v1.5 cosine similarity: below this,
# a "top hit" is lexically/topically unrelated noise, not just a weak
# match — the honest-decline path (comment 12: "not found in corpus"
# instead of a confident wrong answer) depends on this, not on the LLM
# noticing the evidence is irrelevant after the fact.
NOT_FOUND_SCORE_FLOOR = 0.30

ANSWER_PROMPT = """Answer the researcher's question using ONLY the evidence passages below \
— never rely on outside/general knowledge, even if you happen to know the \
answer. In the "answer" text, cite every factual claim inline ONLY as \
(Paper Title, section) — the paper's real title in quotes, never a paperId \
number, never a bracket index; those are for the separate usedPaperIds \
field below, not for prose a researcher will read. If two or more \
DIFFERENT papers are needed, synthesize across them explicitly (e.g. \
"Combining \\"Paper A\\" and \\"Paper B\\", ..."). If the passages do not \
actually answer the question, say so plainly — do not guess.

Research group's focus: {goal}

Question: {question}

Evidence passages (each tagged with its paperId for YOUR bookkeeping only —
never write "paperId" or its number in the answer text itself):
{passages}

Return ONLY a JSON object:
{{"answer": string, "supported": boolean, "usedPaperIds": [int, ...]}}
"usedPaperIds" must list the "paperId" value (not a position/index) of every
paper actually drawn on — this is the ONLY place paperId numbers belong.
"supported" must be false — with "answer" explaining what's missing, not an
attempted answer — if the passages don't actually address the question."""


def answer_question(question: str, professor_id: str = "default", k: int = 8) -> dict:
    hits = query_corpus(question, professor_id, k)

    if not hits or hits[0]["score"] < NOT_FOUND_SCORE_FLOOR:
        return {
            "answer": None, "supported": False, "notFoundInCorpus": True,
            "sources": [],
            "reason": "No sufficiently relevant passages were found in the corpus for this question.",
        }

    relevant = [h for h in hits if h["score"] >= NOT_FOUND_SCORE_FLOOR]
    passages = "\n\n".join(
        f"(paperId={h['paperId']}) \"{h['paperTitle']}\" ({h.get('sectionHead') or 'excerpt'}): {h['snippet'][:600]}"
        for h in relevant
    )
    with conn() as c:
        goal = describe_current_research_focus(c, professor_id)

    prompt = ANSWER_PROMPT.format(goal=goal, question=question, passages=passages)
    cfg = task_model("knowledge_curation")
    text = complete(prompt, model=cfg["model"])
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    parsed = json.loads(text)

    supported = bool(parsed.get("supported", False))
    used_ids = set(parsed.get("usedPaperIds") or [])
    # If the model didn't name specific paperIds, OR named ones that don't
    # match any retrieved hit (e.g. still confused paperId with a display
    # index despite the prompt), fall back to all retrieved sources rather
    # than silently showing none — attribution should degrade gracefully,
    # never disappear.
    source_hits = [h for h in relevant if h["paperId"] in used_ids]
    if not source_hits:
        source_hits = relevant
    sources = [
        {"paperId": h["paperId"], "paperTitle": h["paperTitle"], "sectionHead": h.get("sectionHead"),
         "snippet": h["snippet"], "score": h["score"]}
        for h in source_hits
    ]

    return {
        "answer": parsed.get("answer", ""),
        "supported": supported,
        "notFoundInCorpus": not supported,
        "sources": sources if supported else [],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--question", required=True)
    ap.add_argument("--professor", default="default")
    ap.add_argument("--k", type=int, default=8)
    args = ap.parse_args()
    print(json.dumps(answer_question(args.question, args.professor, args.k), indent=2))


if __name__ == "__main__":
    main()
