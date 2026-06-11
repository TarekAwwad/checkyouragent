import React from "react";
import type { ContextThread } from "../../api/types";
import { packLanes } from "./streamGeometry";
import { formatTokens, formatUsd } from "./ContextEconomics";

const LANE_WIDTH = 360;
const MIN_TOKENS_SHOWN = 100;

export default function BallastLanes({
  thread,
  highlightEventId,
  costAvailable,
}: {
  thread: ContextThread;
  highlightEventId: number | null;
  costAvailable: boolean;
}) {
  const callCount = thread.calls.length;
  const lanes = React.useMemo(
    () => packLanes(
      thread.contributors.filter((c) => c.est_tokens >= MIN_TOKENS_SHOWN),
      callCount,
    ),
    [thread, callCount],
  );
  const x = (turn: number) => (turn / Math.max(1, callCount - 1)) * LANE_WIDTH;

  return (
    <div className="ballast-lanes" role="list" aria-label="Context contributors">
      {lanes.map((lane) => (
        <div
          key={lane.id}
          role="listitem"
          className={`ballast-lane ${lane.eventId === highlightEventId ? "is-highlighted" : ""}`}
        >
          <span className="ballast-label" title={lane.label}>{lane.label}</span>
          <svg viewBox={`0 0 ${LANE_WIDTH} 24`} preserveAspectRatio="none">
            <rect
              x={x(lane.x0)}
              width={Math.max(2, x(lane.x1) - x(lane.x0))}
              y={(24 - lane.thickness) / 2}
              height={lane.thickness}
              rx={2}
              className={`lane-${lane.kind}`}
            >
              <title>
                {lane.label}: {formatTokens(lane.tokens)} carried turns {lane.x0}–{lane.x1}
                {costAvailable ? `, ${formatUsd(lane.accruedUsd)} tax` : ""}
              </title>
            </rect>
          </svg>
          <span className="ballast-meta">
            {formatTokens(lane.tokens)}
            {costAvailable && ` · ${formatUsd(lane.accruedUsd)}`}
          </span>
        </div>
      ))}
    </div>
  );
}
