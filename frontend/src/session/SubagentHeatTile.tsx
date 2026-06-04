import React from "react";
import type { Subagent } from "../api/types";
import { buildSubagentHeat, type SubagentHeatCell } from "./sessionAnalytics";

interface Props {
  subagents: Subagent[];
  wide?: boolean;
  firstEventIds?: Map<string, number>;
  onSelectSubagent?: (agentId: string) => void;
}

function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "unknown";
}

function tooltipFor(cell: SubagentHeatCell, firstEventId: number | undefined): string {
  const label = cell.name || cell.agentType || cell.description || "Subagent";
  return [
    `${cell.label}: ${label}`,
    `agent_id: ${cell.agentId}`,
    `${cell.events.toLocaleString()} events`,
    `first seen: ${formatTimestamp(cell.firstTs)}`,
    `last seen: ${formatTimestamp(cell.lastTs)}`,
    cell.toolUseId ? `tool_use_id: ${cell.toolUseId}` : null,
    firstEventId ? `opens event ${firstEventId}` : "no timeline event found",
  ].filter(Boolean).join(" - ");
}

// A1/A2/... are chronological labels by first seen time. Heat intensity still
// reflects each subagent's event volume relative to the busiest subagent.
export default function SubagentHeatTile({ subagents, wide, firstEventIds, onSelectSubagent }: Props) {
  const model = React.useMemo(() => buildSubagentHeat(subagents), [subagents]);

  return (
    <section className={`tile session-tile${wide ? " tile-full" : ""}`}>
      <h2>Subagents - {model.count}</h2>
      <div className="agent-heat">
        <div className="heat-summary">
          {/* <div className="heat-big">{model.count}</div> */}
          <div className="heat-sub">
            {`${model.totalEvents.toLocaleString()} events total`}
          </div>
        </div>
        <div className="heat-grid">
          {model.cells.map((cell) => {
            const firstEventId = firstEventIds?.get(cell.agentId);
            const title = tooltipFor(cell, firstEventId);
            return (
              <button
                key={cell.id}
                type="button"
                className={`heat-cell lvl-${cell.level}`}
                title={title}
                aria-label={title}
                aria-disabled={!firstEventId}
                onClick={() => firstEventId && onSelectSubagent?.(cell.agentId)}
              >
                {cell.label}
              </button>
            );
          })}
        </div>
        <div className="heat-legend card-bottom-legend">
          <span><i className="heat-leg-3" /> high</span>
          <span><i className="heat-leg-2" /> med</span>
          <span><i className="heat-leg-1" /> low</span>
        </div>
      </div>
    </section>
  );
}
