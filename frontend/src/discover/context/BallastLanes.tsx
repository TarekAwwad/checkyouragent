import React from "react";
import type { ContextThread } from "../../api/types";
import { packLanes } from "./streamGeometry";
import { formatTokens, formatUsd } from "./ContextEconomics";
import { useChartTooltip } from "./chartTooltip";

const LANE_WIDTH = 360;
const MIN_TOKENS_SHOWN = 100;
const TOP_LANES = 10;

export default function BallastLanes({
  thread,
  highlightEventId,
  costAvailable,
  hoverId,
  onHover,
}: {
  thread: ContextThread;
  highlightEventId: number | null;
  costAvailable: boolean;
  hoverId?: string | null;
  onHover?: (id: string | null) => void;
}) {
  const callCount = thread.calls.length;
  const [showAll, setShowAll] = React.useState(false);
  const { ref, show, hide, tooltip } = useChartTooltip<HTMLDivElement>();
  const lanes = React.useMemo(
    () => packLanes(
      thread.contributors.filter((c) => c.est_tokens >= MIN_TOKENS_SHOWN),
      callCount,
    ),
    [thread, callCount],
  );
  // Heaviest first: the list answers "what is weighing this session down?",
  // while each bar's horizontal span still encodes when it lived in context.
  const sorted = React.useMemo(
    () => lanes.slice().sort((a, b) => b.tokens - a.tokens),
    [lanes],
  );
  let visible = showAll ? sorted : sorted.slice(0, TOP_LANES);
  if (highlightEventId !== null && !visible.some((lane) => lane.eventId === highlightEventId)) {
    const highlighted = sorted.find((lane) => lane.eventId === highlightEventId);
    if (highlighted) visible = [...visible, highlighted];
  }
  const x = (turn: number) => (turn / Math.max(1, callCount - 1)) * LANE_WIDTH;

  return (
    <div className="ballast-lanes">
      <div className="stream-head">
        <span
          className="stream-title"
          title="Each bar spans the turns a contributor stayed in context; thickness scales with its size."
        >
          Heaviest contributors
        </span>
        {sorted.length > TOP_LANES && (
          <span className="stream-peak">
            {visible.length} of {sorted.length}
          </span>
        )}
      </div>
      <div className="ballast-lane ballast-axis" aria-hidden={true}>
        <span className="ballast-label">Contributor</span>
        <span className="ballast-axis-scale">
          <i>turn 0</i>
          <i>turn {Math.max(0, callCount - 1)}</i>
        </span>
        <span className="ballast-meta">{costAvailable ? "carried · tax" : "carried"}</span>
      </div>
      <div className="ballast-lane-list chart-tooltip-host" role="list" aria-label="Context contributors" ref={ref}>
        {visible.map((lane) => (
          <div
            key={lane.id}
            role="listitem"
            className={[
              "ballast-lane",
              lane.eventId !== null && lane.eventId === highlightEventId ? "is-highlighted" : "",
              hoverId === lane.id ? "is-hovered" : "",
            ].filter(Boolean).join(" ")}
            onMouseMove={(event) => {
              const lines = [`${formatTokens(lane.tokens)} · turns ${lane.x0}–${lane.x1}`];
              if (costAvailable) lines.push(`${formatUsd(lane.accruedUsd)} carry tax`);
              show(event, lane.label, lines);
              onHover?.(lane.id);
            }}
            onMouseLeave={() => {
              hide();
              onHover?.(null);
            }}
          >
            <span className="ballast-label" title={lane.label}>{lane.label}</span>
            <svg viewBox={`0 0 ${LANE_WIDTH} 24`} preserveAspectRatio="none">
              <rect x={0} width={LANE_WIDTH} y={10} height={4} rx={2} className="lane-track" />
              <rect
                x={x(lane.x0)}
                width={Math.max(2, x(lane.x1) - x(lane.x0))}
                y={(24 - lane.thickness) / 2}
                height={lane.thickness}
                rx={2}
                className={`lane-${lane.kind}`}
              />
            </svg>
            <span className="ballast-meta">
              {formatTokens(lane.tokens)}
              {costAvailable && ` · ${formatUsd(lane.accruedUsd)}`}
            </span>
          </div>
        ))}
        {tooltip}
      </div>
      {sorted.length > TOP_LANES && (
        <button type="button" className="ballast-toggle" onClick={() => setShowAll((v) => !v)}>
          {showAll ? `Show top ${TOP_LANES}` : `Show all ${sorted.length} contributors`}
        </button>
      )}
    </div>
  );
}
