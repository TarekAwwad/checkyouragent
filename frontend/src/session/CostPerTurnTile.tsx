import React from "react";
import type { TimelineItem, TraceSpan } from "../api/types";
import { ACCENT_COLOR, DANGER_COLOR, formatTokens, formatUsd } from "../analytics/chartGeometry";
import { buildTurnCosts } from "./sessionAnalytics";

interface Props {
  items: TimelineItem[];
  spans: TraceSpan[];
  costUsd: number;
  costAvailable: boolean;
  loading?: boolean;
}

// Per-turn cost bars. Turns come from groupTurns; per-turn weight is summed from
// trace span tokens. When session pricing is available the bars read in USD,
// otherwise they fall back to per-turn token volume (labelled). Spike turns
// (mean + 1σ) render in var(--err).
export default function CostPerTurnTile({ items, spans, costUsd, costAvailable, loading }: Props) {
  const model = React.useMemo(
    () => buildTurnCosts(items, spans, costUsd, costAvailable, 6),
    [items, spans, costUsd, costAvailable],
  );
  const hasData = model.rows.some((row) => row.value > 0);
  const format = (value: number) => (model.priced ? formatUsd(value) : formatTokens(Math.round(value)));

  return (
    <section className="tile session-tile">
      <h2>Cost per turn</h2>
      {loading ? (
        <div className="session-tile-empty">Loading…</div>
      ) : !hasData ? (
        <div className="session-tile-empty">No turn data</div>
      ) : (
        <>
          <div className="cpt-bars">
            {model.rows.map((row) => (
              <div className="cpt-row" key={row.label}>
                <div className="cpt-label">{row.label}</div>
                <div className="cpt-track">
                  <div
                    className={`cpt-fill${row.spike ? " spike" : ""}`}
                    style={{
                      width: `${model.maxValue > 0 ? Math.max(4, (row.value / model.maxValue) * 100) : 0}%`,
                      background: row.spike ? DANGER_COLOR : ACCENT_COLOR,
                    }}
                  />
                </div>
                <div className={`cpt-val${row.spike ? " spike" : ""}`}>{format(row.value)}</div>
              </div>
            ))}
          </div>
          {!model.priced && <p className="session-tile-note">token volume (no pricing)</p>}
        </>
      )}
    </section>
  );
}
