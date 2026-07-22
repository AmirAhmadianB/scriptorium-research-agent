/** Sprint 6: the Literature Radar's "New in the field" recency window.
 * Pure/DB-free so the cutoff math itself is unit-testable — mirrors the
 * computeStale() pattern in routes/radar.ts. */

/** ISO YYYY-MM-DD `monthsBack` calendar months before `now`. A paper
 * qualifies for the radar's "new" feed if its published_date is >= this —
 * which already covers "or has a future/in-press date" too, since any
 * future date is trivially >= a cutoff in the past. */
export function recencyCutoffIso(now: Date, monthsBack = 3): string {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  return cutoff.toISOString().slice(0, 10);
}
