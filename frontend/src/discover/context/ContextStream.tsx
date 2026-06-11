import React from "react";
import type { ContextThread } from "../../api/types";
import { buildStreamBands, stackedPaths } from "./streamGeometry";
import { formatTokens, formatUsd } from "./ContextEconomics";
import { useChartTooltip } from "./chartTooltip";

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

const KIND_LABELS: Record<string, string> = {
  baseline: "Baseline",
  tool_result: "Tool results",
  user: "User",
  assistant_output: "Assistant",
  attachment: "Attachments",
  unattributed: "Unattributed",
  other: "Other",
};

export default function ContextStream({
  thread,
  highlightEventId,
  counterfactual,
  costAvailable,
  hoverId,
  onHover,
}: {
  thread: ContextThread;
  highlightEventId: number | null;
  counterfactual?: number[] | null;
  costAvailable?: boolean;
  hoverId?: string | null;
  onHover?: (id: string | null) => void;
}) {
  const bands = React.useMemo(() => buildStreamBands(thread, MAX_BANDS), [thread]);
  const paths = React.useMemo(() => stackedPaths(bands, WIDTH, HEIGHT), [bands]);
  const { ref, show, hide, tooltip } = useChartTooltip<HTMLDivElement>();
  // Highlights the band for the finding's contributor. A contributor bucketed
  // into the "other" band (ranked past MAX_BANDS) won't glow here — the ballast
  // lane below still highlights it, so the evidence is never lost.
  const highlightId = highlightEventId === null
    ? null
    : thread.contributors.find((c) => c.event_id === highlightEventId)?.id ?? null;
  const callCount = thread.calls.length;
  const peak = Math.max(...thread.calls.map((c) => c.context_tokens), 0);
  const compactions = thread.epochs
    .filter((epoch) => epoch.ended_by === "compaction")
    .map((epoch) => epoch.end_turn);
  const kinds = Array.from(new Set(bands.map((band) => band.kind)));
  // Hover wins over the inspected finding for emphasis; either one dims the rest.
  const focusId = hoverId ?? highlightId;

  const bandTooltip = (event: React.MouseEvent, id: string, label: string) => {
    const contributor = thread.contributors.find((c) => c.id === id);
    const lines: string[] = [];
    if (contributor) {
      lines.push(`${formatTokens(contributor.est_tokens)} · turns ${contributor.entry_turn}–${contributor.end_turn}`);
      if (costAvailable) lines.push(`${formatUsd(contributor.accrued_usd)} carry tax`);
    }
    show(event, label, lines);
  };

  const cfPath = React.useMemo(() => {
    if (!counterfactual || counterfactual.length !== callCount || callCount < 2 || peak <= 0) {
      return null;
    }
    const x = (i: number) => (i / (callCount - 1)) * WIDTH;
    const y = (tokens: number) => HEIGHT - (tokens / peak) * HEIGHT;
    return `M${counterfactual.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" L")}`;
  }, [counterfactual, callCount, peak]);

  return (
    <figure className={`context-stream${focusId !== null ? " has-focus" : ""}`}>
      <figcaption className="stream-head">
        <span
          className="stream-title"
          title="Band area ≈ carry cost: a band's tokens are re-paid on every turn it spans."
        >
          Context composition
        </span>
        <span className="stream-peak">peak {formatTokens(peak)}</span>
      </figcaption>
      <div className="chart-tooltip-host" ref={ref}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Context composition over ${callCount} turns, peak ${formatTokens(peak)}`}
        >
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1={0}
              x2={WIDTH}
              y1={HEIGHT * fraction}
              y2={HEIGHT * fraction}
              className="stream-grid"
            />
          ))}
          {paths.map((path) => (
            <path
              key={path.id}
              d={path.d}
              className={[
                KIND_CLASS[path.kind] ?? "stream-other",
                highlightId === path.id ? "is-highlighted" : "",
                focusId === null ? "" : focusId === path.id ? "is-focused" : "is-dimmed",
              ].filter(Boolean).join(" ")}
              onMouseMove={(event) => {
                bandTooltip(event, path.id, path.label);
                onHover?.(path.id);
              }}
              onMouseLeave={() => {
                hide();
                onHover?.(null);
              }}
            />
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
          {cfPath && <path d={cfPath} className="stream-counterfactual" />}
        </svg>
        {tooltip}
      </div>
      <div className="stream-axis" aria-hidden={true}>
        <span>turn 0</span>
        <span>turn {Math.max(0, callCount - 1)}</span>
      </div>
      <div className="stream-legend" aria-hidden={true}>
        {kinds.map((kind) => (
          <span key={kind}>
            <svg width={9} height={9}>
              <rect width={9} height={9} rx={2} className={KIND_CLASS[kind] ?? "stream-other"} />
            </svg>
            {KIND_LABELS[kind] ?? kind}
          </span>
        ))}
        {compactions.length > 0 && (
          <span>
            <i className="stream-compaction-swatch" />
            Compaction
          </span>
        )}
        {cfPath && (
          <span>
            <i className="stream-counterfactual-swatch" />
            If fixed (est.)
          </span>
        )}
      </div>
    </figure>
  );
}
