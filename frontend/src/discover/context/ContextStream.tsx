import React from "react";
import type { ContextThread } from "../../api/types";
import { buildStreamBands, stackedPaths } from "./streamGeometry";
import { formatTokens } from "./ContextEconomics";

const WIDTH = 560;
const HEIGHT = 180;
const MAX_BANDS = 8;

const KIND_CLASS: Record<string, string> = {
  baseline: "stream-baseline",
  tool_result: "stream-tool",
  user: "stream-user",
  assistant_output: "stream-assistant",
  attachment: "stream-attachment",
  unattributed: "stream-unattributed",
  other: "stream-other",
};

export default function ContextStream({
  thread,
  highlightEventId,
}: {
  thread: ContextThread;
  highlightEventId: number | null;
}) {
  const bands = React.useMemo(() => buildStreamBands(thread, MAX_BANDS), [thread]);
  const paths = React.useMemo(() => stackedPaths(bands, WIDTH, HEIGHT), [bands]);
  // Highlights the band for the finding's contributor. A contributor bucketed
  // into the "other" band (ranked past MAX_BANDS) won't glow here — the ballast
  // lane below still highlights it, so the evidence is never lost.
  const highlightId = highlightEventId === null
    ? null
    : thread.contributors.find((c) => c.event_id === highlightEventId)?.id ?? null;
  const callCount = thread.calls.length;
  const compactions = thread.epochs
    .filter((epoch) => epoch.ended_by === "compaction")
    .map((epoch) => epoch.end_turn);

  return (
    <figure className="context-stream">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Context composition over ${callCount} turns, peak ${formatTokens(
          Math.max(...thread.calls.map((c) => c.context_tokens), 0),
        )}`}
      >
        {paths.map((path) => (
          <path
            key={path.id}
            d={path.d}
            className={`${KIND_CLASS[path.kind] ?? "stream-other"} ${
              highlightId === path.id ? "is-highlighted" : ""
            }`}
          >
            <title>Stream band: {path.label}</title>
          </path>
        ))}
        {compactions.map((turn) => (
          <line
            key={turn}
            x1={(turn / Math.max(1, callCount - 1)) * WIDTH}
            x2={(turn / Math.max(1, callCount - 1)) * WIDTH}
            y1={0}
            y2={HEIGHT}
            className="stream-compaction"
          >
            <title>Compaction after turn {turn}</title>
          </line>
        ))}
      </svg>
      <figcaption className="discover-muted">
        Band area ≈ carry cost: a band's tokens are re-paid on every turn it spans.
      </figcaption>
    </figure>
  );
}
