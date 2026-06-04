import React from "react";
import type { TimelineItem } from "../api/types";
import { ACCENT_COLOR } from "../analytics/chartGeometry";
import { buildToolUsage } from "./sessionAnalytics";

interface Props {
  items: TimelineItem[];
  loading?: boolean;
}

// Top-5 tool calls by tool_name, rendered as horizontal bars. Colors come from
// the shared analytics palette so the look matches the cost page.
export default function ToolUsageTile({ items, loading }: Props) {
  const rows = React.useMemo(() => buildToolUsage(items, 5), [items]);
  const max = rows.length ? rows[0].count : 0;

  return (
    <section className="tile session-tile">
      <h2>Tool usage</h2>
      {loading ? (
        <div className="session-tile-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="session-tile-empty">No tool calls</div>
      ) : (
        <div className="tool-bars">
          {rows.map((row) => (
            <div className="tu-row" key={row.name}>
              <div className="tu-label" title={row.name}>{row.name}</div>
              <div className="tu-track">
                <div
                  className="tu-fill"
                  style={{
                    width: `${max > 0 ? Math.max(6, (row.count / max) * 100) : 0}%`,
                    background: ACCENT_COLOR,
                  }}
                />
              </div>
              <div className="tu-count">{row.count}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
