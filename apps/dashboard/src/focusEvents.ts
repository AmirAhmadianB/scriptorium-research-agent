/** Sprint 2 Pass 1 — the missing piece behind comments 1/2/3: every
 * dashboard component fetched its data once on mount (`useEffect(fn, [])`)
 * and never again, so editing Research Focus never visibly changed
 * anything short of a full page reload — even though the API routes
 * themselves were already genuinely reactive server-side (Pass 1.4/1.5).
 * This is the missing client-side signal: ResearchFocus.tsx fires
 * `emitFocusChanged()` after every successful commit; any component that
 * should react to a focus change calls `onFocusChanged(refetch)` alongside
 * its mount-time fetch. A plain window CustomEvent, not a React Context,
 * because the components involved (App's header/radar, VelocityChart,
 * ResearchFocus) don't share a common ancestor worth threading props
 * through for this. */
const FOCUS_CHANGED_EVENT = "scriptorium:focus-changed";

export function emitFocusChanged(): void {
  window.dispatchEvent(new CustomEvent(FOCUS_CHANGED_EVENT));
}

/** Returns an unsubscribe function — call it from a useEffect cleanup. */
export function onFocusChanged(handler: () => void): () => void {
  window.addEventListener(FOCUS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(FOCUS_CHANGED_EVENT, handler);
}

/** Sprint 2 Pass 3 — same pattern, different trigger: CrawlSourceRegistry
 * fires this after adding/crawling a source so App.tsx's funding list
 * (from /api/overview, fetched once on mount like everything else was
 * before Pass 1) picks up newly-crawled rows without a page reload. */
const DATA_CHANGED_EVENT = "scriptorium:data-changed";

export function emitDataChanged(): void {
  window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT));
}

export function onDataChanged(handler: () => void): () => void {
  window.addEventListener(DATA_CHANGED_EVENT, handler);
  return () => window.removeEventListener(DATA_CHANGED_EVENT, handler);
}
