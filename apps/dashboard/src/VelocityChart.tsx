/** Pass 1.5g — keyword-velocity chart. Field-adaptive by construction: the
 * series are whatever keywords are in the CURRENT Research Focus profile
 * (via GET /api/trends, which reuses the Pass 1.5e trends pipeline), so
 * this never needs a code change to plot a different domain. Plain inline
 * SVG (no chart library) — the dataset is small (<=5 series, a handful of
 * years), so a dependency isn't justified. Palette: dataviz skill's
 * validated categorical slots, skipping the hues this app's own design
 * system already reserves as status colors (amber = agent activity, oxide
 * = deadline urgency). */
import React, { useEffect, useState } from "react";
import { onFocusChanged } from "./focusEvents.js";

type Velocity = { by_year: Record<string, number>; slope_per_year: number };
type TrendsResponse = {
  window_years: number; paper_count: number;
  keyword_velocity: Record<string, Velocity>;
  error?: string;
};

// Slots 1, 2, 4, 5, 7 of the dataviz skill's validated categorical palette
// (blue, aqua, green, violet, magenta) — 3, 6, 8 (yellow/red/orange) skipped
// as adjacent to this app's reserved amber/oxide status hues.
const SERIES_COLORS = ["#2a78d6", "#1baf7a", "#008300", "#4a3aa7", "#e87ba4"];

export default function VelocityChart() {
  const [data, setData] = useState<TrendsResponse | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);

  useEffect(() => {
    function loadTrends() {
      fetch("/api/trends").then(r => r.json()).then(setData).catch(() => setData(null));
    }
    loadTrends();
    // Sprint 2 Pass 1 (comment 3): the server already rebuilds keyword_velocity
    // from the CURRENT focus keywords on every request (Pass 1.5e) — the bug
    // was this component never asking again after its initial mount. There is
    // no separate "cache keyed only by time" to clear: state is fully replaced
    // by whatever the fresh response contains, so a removed keyword's series
    // disappears and a new keyword's series appears automatically.
    return onFocusChanged(loadTrends);
  }, []);

  if (!data) return null;

  const keywords = Object.keys(data.keyword_velocity);
  if (keywords.length === 0) {
    return (
      <div className="panel span12 velocity-chart">
        <h2>Keyword velocity</h2>
        <p className="hint">
          {data.paper_count === 0
            ? "No Research Focus set yet, and no papers in the corpus yet."
            : "No corpus papers currently match your Research Focus keywords in this window."}
        </p>
      </div>
    );
  }

  const years = Array.from(
    new Set(keywords.flatMap(k => Object.keys(data.keyword_velocity[k].by_year).map(Number))),
  ).sort((a, b) => a - b);
  const maxCount = Math.max(1, ...keywords.flatMap(k => Object.values(data.keyword_velocity[k].by_year)));

  const W = 640, H = 220, PAD_L = 34, PAD_B = 24, PAD_T = 12, PAD_R = 108;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const xFor = (year: number) => years.length <= 1 ? PAD_L
    : PAD_L + ((year - years[0]) / (years[years.length - 1] - years[0])) * plotW;
  const yFor = (count: number) => PAD_T + plotH - (count / maxCount) * plotH;

  return (
    <div className="panel span12 velocity-chart">
      <div className="velocity-header">
        <h2>Keyword velocity — last {data.window_years} years</h2>
        <button className="link-btn" onClick={() => setShowTable(s => !s)}>
          {showTable ? "Show chart" : "Show table"}
        </button>
      </div>

      {showTable ? (
        <table className="velocity-table">
          <thead><tr><th>Keyword</th>{years.map(y => <th key={y} className="mono">{y}</th>)}<th className="mono">slope/yr</th></tr></thead>
          <tbody>
            {keywords.map((k, i) => (
              <tr key={k}>
                <td><span className="swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />{k}</td>
                {years.map(y => <td key={y} className="mono">{data.keyword_velocity[k].by_year[y] ?? 0}</td>)}
                <td className="mono">{data.keyword_velocity[k].slope_per_year}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Keyword velocity over time" className="velocity-svg">
          {/* recessive gridlines */}
          {[0, 0.5, 1].map(f => (
            <line key={f} x1={PAD_L} x2={W - PAD_R} y1={PAD_T + plotH * (1 - f)} y2={PAD_T + plotH * (1 - f)}
              stroke="var(--hairline)" strokeWidth={1} />
          ))}
          {/* axis */}
          <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--hairline)" strokeWidth={1} />
          {years.map(y => (
            <text key={y} x={xFor(y)} y={H - 6} fontSize={10} textAnchor="middle" fill="var(--ink)" opacity={0.6}>{y}</text>
          ))}
          <text x={4} y={PAD_T + 4} fontSize={10} fill="var(--ink)" opacity={0.6}>{maxCount}</text>
          <text x={4} y={PAD_T + plotH} fontSize={10} fill="var(--ink)" opacity={0.6}>0</text>

          {(() => {
            const series = keywords.map((k, i) => {
              const color = SERIES_COLORS[i % SERIES_COLORS.length];
              const pts = years.map(y => ({ x: xFor(y), y: yFor(data.keyword_velocity[k].by_year[y] ?? 0), year: y, count: data.keyword_velocity[k].by_year[y] ?? 0 }));
              const path = pts.map((p, idx) => `${idx === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
              return { k, color, pts, path, last: pts[pts.length - 1] };
            });
            // Declutter end-of-line labels: sort by their natural y, then push
            // any that are closer than one line-height apart further down —
            // otherwise close-valued series (e.g. two lines both ending near
            // the same count) print overlapping text (see anti-patterns.md).
            const MIN_GAP = 12;
            const labelOrder = [...series].sort((a, b) => a.last.y - b.last.y);
            let prevY = -Infinity;
            const labelY = new Map<string, number>();
            for (const s of labelOrder) {
              const y = Math.max(s.last.y, prevY + MIN_GAP);
              labelY.set(s.k, y);
              prevY = y;
            }
            return series.map(({ k, color, pts, path, last }) => (
              <g key={k}>
                <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
                {pts.map(p => (
                  <circle key={p.year} cx={p.x} cy={p.y} r={4} fill={color}
                    onMouseEnter={() => setHover({ x: p.x, y: p.y, label: `${k}: ${p.count} (${p.year})` })}
                    onMouseLeave={() => setHover(null)} />
                ))}
                <text x={last.x + 6} y={(labelY.get(k) ?? last.y) + 3} fontSize={9} fill={color}>
                  {k.length > 14 ? `${k.slice(0, 13)}…` : k}
                  <title>{k}</title>
                </text>
              </g>
            ));
          })()}

          {hover && (
            <g transform={`translate(${Math.min(hover.x + 8, W - 140)},${Math.max(hover.y - 10, 12)})`}>
              <rect width={132} height={18} rx={3} fill="var(--graphite)" opacity={0.92} />
              <text x={6} y={13} fontSize={10} fill="#fff">{hover.label}</text>
            </g>
          )}
        </svg>
      )}

      {/* legend — always present for >=2 series, independent of the end-of-line labels */}
      <div className="velocity-legend">
        {keywords.map((k, i) => (
          <span key={k} className="legend-item">
            <span className="swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />{k}
          </span>
        ))}
      </div>
    </div>
  );
}
