/** Sprint 5 Pass 6 (comment 13) — the ONLY place this dashboard converts
 * between the drafter's plain-text format (proposal_orchestrator.py's
 * [[Title]] markers, [[CITATION NEEDED — ...]] / [[CONFIRM: ...]] honest-
 * gap markers, and bold/italic markdown — see .claude/agents/proposal-
 * writer.md) and TipTap's document JSON. Mirrors the backend's citation
 * classification exactly (proposal_orchestrator.py's _render_citations):
 * a [[...]] that starts with "CITATION NEEDED" or "CONFIRM" is a plain
 * honest-gap marker (left as ordinary editable text), everything else
 * becomes an atomic citation node. */
export type JSONNode = { type: string; attrs?: Record<string, any>; content?: JSONNode[]; text?: string; marks?: any[] };

const CITE_MARKER = /\[\[([^[\]]{1,300})]]/g;
const HONEST_GAP_RE = /^(CITATION NEEDED|CONFIRM)\b/i;

function citationKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Left-to-right inline tokenizer: [[Title]] citations, **bold**,
 * *italic*, plain text. Not a general markdown parser — matches exactly
 * what the drafter actually emits (DRAFT_PROMPT + proposal-writer.md). */
function parseInline(text: string, pool: Record<string, any>): JSONNode[] {
  const nodes: JSONNode[] = [];
  let i = 0;
  const pushText = (s: string, marks: any[] = []) => {
    if (!s) return;
    nodes.push(marks.length ? { type: "text", text: s, marks } : { type: "text", text: s });
  };

  while (i < text.length) {
    const rest = text.slice(i);
    const citeMatch = rest.match(/^\[\[([^[\]]{1,300})]]/);
    if (citeMatch) {
      const title = citeMatch[1].trim();
      if (HONEST_GAP_RE.test(title)) {
        pushText(citeMatch[0]);
      } else {
        const resolved = citationKey(title) in pool;
        nodes.push({ type: "citation", attrs: { title, resolved } });
      }
      i += citeMatch[0].length;
      continue;
    }
    const boldMatch = rest.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      pushText(boldMatch[1], [{ type: "bold" }]);
      i += boldMatch[0].length;
      continue;
    }
    const italicMatch = rest.match(/^\*(.+?)\*/);
    if (italicMatch) {
      pushText(italicMatch[1], [{ type: "italic" }]);
      i += italicMatch[0].length;
      continue;
    }
    // Advance to the next special character (or end of string).
    const nextSpecial = rest.slice(1).search(/\[\[|\*/);
    const chunkLen = nextSpecial === -1 ? rest.length : nextSpecial + 1;
    pushText(rest.slice(0, chunkLen));
    i += chunkLen;
  }
  return nodes;
}

/** text -> TipTap doc JSON. Blocks: '#'/'##'/'###' lines are headings;
 * consecutive non-blank lines are one paragraph; blank lines separate
 * paragraphs (mirrors export_proposal.py's _split_blocks loosely enough
 * that what you see in the editor is what gets exported). */
export function textToDoc(text: string, pool: Record<string, any>): JSONNode {
  const content: JSONNode[] = [];
  const lines = text.split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      content.push({ type: "paragraph", content: parseInline(para.join(" "), pool) });
      para = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      content.push({ type: "heading", attrs: { level: h[1].length }, content: parseInline(h[2], pool) });
      continue;
    }
    para.push(line);
  }
  flush();
  if (!content.length) content.push({ type: "paragraph", content: [] });
  return { type: "doc", content };
}

/** TipTap doc JSON -> plain text (the inverse of textToDoc; feeds
 * autosave/export). Citation nodes serialize back to their EXACT
 * [[Title]] marker — this is what keeps them resolvable against the
 * server's citablePool after a round trip through the editor. */
export function docToText(doc: JSONNode): string {
  const blocks: string[] = [];
  for (const node of doc.content ?? []) {
    if (node.type === "heading") {
      const level = node.attrs?.level ?? 1;
      blocks.push("#".repeat(level) + " " + inlineToText(node.content ?? []));
    } else if (node.type === "paragraph") {
      blocks.push(inlineToText(node.content ?? []));
    }
  }
  return blocks.join("\n\n");
}

function inlineToText(nodes: JSONNode[]): string {
  return nodes.map(n => {
    if (n.type === "citation") return `[[${n.attrs?.title ?? ""}]]`;
    if (n.type === "text") {
      const isBold = n.marks?.some((m: any) => m.type === "bold");
      const isItalic = n.marks?.some((m: any) => m.type === "italic");
      const t = n.text ?? "";
      if (isBold) return `**${t}**`;
      if (isItalic) return `*${t}*`;
      return t;
    }
    return "";
  }).join("");
}

/** Live, client-side citation numbering — mirrors
 * proposal_orchestrator.py's _render_citations exactly (first appearance
 * order), seeded with priorSectionCitationKeys so THIS section's numbers
 * continue from where earlier sections (in plan order) left off. Recomputed
 * fresh on every call (never cached), so "renumber consistently" holds by
 * construction, same reasoning as the Python side. */
export function computeNumbering(doc: JSONNode, priorKeys: string[]): Map<string, number> {
  const numbers = new Map<string, number>();
  priorKeys.forEach((key, i) => numbers.set(key, i + 1));
  let next = priorKeys.length + 1;
  const walk = (nodes: JSONNode[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n.type === "citation") {
        const key = citationKey(n.attrs?.title ?? "");
        if (!numbers.has(key)) { numbers.set(key, next); next += 1; }
      }
      if (n.content) walk(n.content);
    }
  };
  walk(doc.content);
  return numbers;
}

/** Client-side preview only — mirrors proposal_orchestrator.py's
 * _ieee_entry. The AUTHORITATIVE reference list is still computed
 * server-side at export time (export_proposal.py -> compile_document ->
 * _render_citations); this is just so the editor can show a live,
 * correctly-ordered reference list without a network round-trip on every
 * keystroke. */
export function formatIEEE(n: number, src: any): string {
  // Defensive: a citablePool entry's `authors` should always be a parsed
  // array by the time it reaches the browser, but a raw sql`` query
  // bypassing Drizzle's JSON deserialization (a real bug found and fixed
  // server-side — see routes/proposal.ts) can leave it as a JSON string,
  // and an already-persisted session's stored citablePool won't retroactively
  // pick up that fix. One malformed citation must never crash the whole
  // editor (no error boundary wraps this render) — parse defensively,
  // degrade to "no authors listed" rather than throwing, either way.
  let authors: any[] = [];
  if (Array.isArray(src?.authors)) {
    authors = src.authors;
  } else if (typeof src?.authors === "string" && src.authors.trim()) {
    try { const parsed = JSON.parse(src.authors); if (Array.isArray(parsed)) authors = parsed; } catch { /* leave empty */ }
  }
  let authorStr = "";
  if (authors.length) {
    const names = authors.slice(0, 6).map(a => (typeof a === "string" ? a : a?.name)).filter(Boolean);
    authorStr = names.join(", ") + (authors.length > 6 ? " et al." : "");
  }
  const bits: string[] = [];
  if (authorStr) bits.push(`${authorStr},`);
  bits.push(`"${src?.title ?? "Untitled"},"`);
  if (src?.venue) bits.push(`${src.venue},`);
  if (src?.year) bits.push(`${src.year}.`);
  if (src?.doi) bits.push(`doi: ${src.doi}.`);
  else if (src?.url) bits.push(`[Online]. Available: ${src.url}`);
  return `[${n}] ` + bits.join(" ");
}

/** Scans raw [[Title]]-marker text (NOT parsed into a doc) for citation
 * keys in first-appearance order — used by ProposalTab.tsx to seed a
 * section's starting citation numbers from every section BEFORE it in
 * plan order, so numbering continues correctly across sections without
 * a full doc parse for sections that aren't currently open in an editor. */
export function extractCitationKeysInOrder(text: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const match of text.matchAll(CITE_MARKER)) {
    const title = match[1].trim();
    if (HONEST_GAP_RE.test(title)) continue;
    const key = citationKey(title);
    if (!seen.has(key)) { seen.add(key); keys.push(key); }
  }
  return keys;
}

export { citationKey };
