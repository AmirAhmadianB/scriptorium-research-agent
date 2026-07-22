# Compliance — read before touching sources.yaml

This system touches two legally sensitive things: licensed scholarly content
and professors' personal collections. Both have clean paths; take them.

## 1. Publisher content: crawl nothing you log into

University database subscriptions (ScienceDirect, SpringerLink, IEEE Xplore,
Wiley, Web of Science, Scopus) are governed by license agreements that
prohibit systematic downloading and automated harvesting. Crawling them
through EZproxy/Shibboleth with institutional credentials is the classic way
a *whole campus* loses access while the publisher investigates — the risk is
borne by everyone at the university, not just this project. That is why
`sources.yaml` ships with those domains in `crawl.blocked_domains` and the
/sources skill refuses to add them.

The compliant routes, in order of preference:
1. **Open scholarly graph** — OpenAlex, Crossref, Semantic Scholar, arXiv,
   PubMed/PMC, Unpaywall, CORE. Metadata + abstracts for nearly everything,
   legal OA full text for a large and growing fraction. This alone powers
   trends, discovery, and most drafting grounding.
2. **Publisher TDM APIs** — Elsevier, Springer Nature, Wiley and others offer
   text-and-data-mining APIs keyed to the institution's subscription. Ask the
   UVic Libraries scholarly-communications / e-resources team what TDM clauses
   the current licenses contain and request keys; wire them into the
   `apis.publisher_tdm` block. Canada's fair-dealing TDM exception helps for
   research purposes but does not override contract terms — the license wins.
3. **Per-item, human-in-the-loop** — a professor manually saves a PDF they are
   licensed to read into their `library-inbox/` folder. Individual scholarly
   use; the system just organizes what a human lawfully obtained.

## 2. Professors' collections: consent, scope, residency

UVic is a BC public body, so personal information handling falls under BC
FIPPA (private-sector partners: PIPEDA). Practical rules built into the code:
- **Opt-in per professor.** A connector activates only with that professor's
  own credentials (Zotero read-only key, Mendeley official API, or their own
  inbox folder). Never scrape another person's local Mendeley database —
  brittle and against Elsevier's ToS; the official API or an exported folder
  are the supported paths.
- **Scoping.** Everything ingested carries `professor_id`; `is_private` items
  (unpublished drafts, in-review manuscripts) never appear in cross-professor
  search or trend statistics.
- **Residency.** Keep the database and any stored PDFs on Canadian
  infrastructure (DigitalOcean Toronto or on-prem). Anthropic API calls send
  text for processing under API terms (not used for training by default);
  for unpublished manuscripts, get the professor's explicit OK before any
  agent reads them, and consider the university's research-security guidance.
- **Before campus-wide rollout**, one conversation each with: the Library
  (TDM licensing), the Privacy Office (FIPPA assessment), and Research
  Services (they may already license Pivot-RP — complement, don't duplicate).

## 3. Authorship integrity

Drafting agents are grounded and audited (citation keys must exist; no
invented results; [[CONFIRM]] placeholders) but the human remains the author.
Tri-agency and journal policies on AI assistance are evolving — check the
current NSERC/SSHRC/CIHR guidance and target-journal policy at submission
time, and disclose tool use where required.
