import React from "react";
import { ArrowLeft } from "lucide-react";
import type { TraceResponse, TraceSpan } from "../api/types";
import { buildLoopContextMap, loopExplanation } from "./loopContext";
import { buildTokenModelChart, sessionMaxForMetric, sessionSumForMetric } from "./tokenModelChart";
import type { TokenMetric } from "./tokenHeatmap";
import { distinctModels, modelColor, shortModelName } from "./modelLane";

interface Props {
  trace: TraceResponse;
  selectedEventId: number | null;
  playheadTimestamp: string | null;
  onSelect: (eventId: number) => void;
}

type DistributionMode = "raw" | "compressed" | "normalized";
type LegendFilterKey = "user_turn" | "assistant" | "tool" | "subagent_event" | "system" | "loop";

const TRACK_WIDTH = 900;
const LANE_HEIGHT = 28;
const CHART_HEIGHT = 88;
const MIN_BRUSH_WIDTH = 6;
const BATCH_GAP_PX = 5;
const BATCH_MIN_SPANS = 6;

const formatTokens = (value: number): string => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${value}`;
};

const formatUsd = (value: number): string => {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
};

const LEGEND_ITEMS: Array<{ key: LegendFilterKey; label: string }> = [
  { key: "user_turn", label: "User turn" },
  { key: "assistant", label: "Assistant" },
  { key: "tool", label: "Tool call/result" },
  { key: "subagent_event", label: "Subagent" },
  { key: "system", label: "System / tool error" },
  { key: "loop", label: "Loop span" },
];

const DISTRIBUTION_OPTIONS: Array<{ value: DistributionMode; label: string }> = [
  { value: "raw", label: "Raw time" },
  { value: "compressed", label: "Compressed gaps" },
  { value: "normalized", label: "Event order" },
];

interface BrushWindow {
  start: number;
  end: number;
}

interface DraftBrush {
  startX: number;
  endX: number;
}

interface DrillEntry {
  batchId: string;
  label: string;
  previousBrush: BrushWindow | null;
}

interface ProjectedSpan extends TraceSpan {
  startMs: number;
  endMs: number;
  startCoord: number;
  endCoord: number;
  anchorCoord: number;
}

interface LoopRegion {
  id: string;
  firstEventId: number;
  spans: ProjectedSpan[];
  startCoord: number;
  endCoord: number;
}

interface SpanLayout {
  span: ProjectedSpan;
  left: number;
  width: number;
  right: number;
}

interface SpanBatch {
  id: string;
  spans: ProjectedSpan[];
  left: number;
  width: number;
  kindClass: string;
}

interface TraceProjection {
  domainEnd: number;
  spans: ProjectedSpan[];
  projectTime: (ms: number) => number;
  projectEvent: (eventId: number) => number | null;
}

function toMs(ts: string | null): number | null {
  if (!ts) return null;
  const v = Date.parse(ts);
  return Number.isNaN(v) ? null : v;
}

function spanStartMs(span: TraceSpan, fallback: number): number {
  return toMs(span.start_ts) ?? fallback;
}

function spanEndMs(span: TraceSpan, fallback: number): number {
  return toMs(span.end_ts) ?? spanStartMs(span, fallback);
}

function isSameLoopRun(a: TraceSpan, b: TraceSpan): boolean {
  if (a.loop_run_id && b.loop_run_id) return a.loop_run_id === b.loop_run_id;
  return a.is_loop && b.is_loop && a.lane === b.lane && a.tool_name === b.tool_name;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 0) {
    return (ordered[middle - 1] + ordered[middle]) / 2;
  }
  return ordered[middle];
}

function createCompressedProjector(points: number[]): (value: number) => number {
  const ordered = [...new Set(points)].sort((a, b) => a - b);
  if (ordered.length < 2) {
    return () => 0;
  }

  const gaps = ordered
    .slice(1)
    .map((point, index) => point - ordered[index])
    .filter((gap) => gap > 0);

  if (gaps.length === 0) {
    return () => 0;
  }

  const baselineGap = Math.max(median(gaps), 1);
  const visibleGapCap = Math.max(baselineGap * 4, 30_000);
  const overflowFactor = 0.18;
  const compressed = [0];

  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index] - ordered[index - 1];
    const shortenedGap = gap <= visibleGapCap
      ? gap
      : visibleGapCap + (gap - visibleGapCap) * overflowFactor;
    compressed.push(compressed[index - 1] + shortenedGap);
  }

  return (value: number) => {
    if (value <= ordered[0]) return 0;

    for (let index = 1; index < ordered.length; index += 1) {
      const left = ordered[index - 1];
      const right = ordered[index];
      if (value <= right) {
        if (right === left) return compressed[index];
        const ratio = (value - left) / (right - left);
        return compressed[index - 1] + ratio * (compressed[index] - compressed[index - 1]);
      }
    }

    return compressed[compressed.length - 1];
  };
}

function buildProjection(trace: TraceResponse, distributionMode: DistributionMode): TraceProjection {
  const fallbackStart = toMs(trace.first_ts) ?? 0;
  const fallbackEnd = toMs(trace.last_ts) ?? fallbackStart + 1;
  const baseSpans = trace.spans
    .map((span) => {
      const startMs = spanStartMs(span, fallbackStart);
      return {
        ...span,
        startMs,
        endMs: spanEndMs(span, fallbackStart),
      };
    })
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.event_id - b.event_id);

  const sessionStart = baseSpans.length > 0
    ? Math.min(fallbackStart, ...baseSpans.map((span) => span.startMs))
    : fallbackStart;
  const sessionEnd = baseSpans.length > 0
    ? Math.max(fallbackEnd, ...baseSpans.map((span) => span.endMs), sessionStart + 1)
    : Math.max(fallbackEnd, sessionStart + 1);

  if (distributionMode === "normalized") {
    const spans = baseSpans.map<ProjectedSpan>((span, index) => ({
      ...span,
      startCoord: index,
      endCoord: index + 0.72,
      anchorCoord: index + 0.36,
    }));
    const domainEnd = Math.max(spans.length, 1);
    const eventAnchors = new Map(spans.map((span) => [span.event_id, span.anchorCoord]));

    return {
      domainEnd,
      spans,
      projectEvent: (eventId: number) => eventAnchors.get(eventId) ?? null,
      projectTime: (ms: number) => {
        if (spans.length === 0) return 0;
        if (ms <= spans[0].startMs) return spans[0].anchorCoord;

        for (let index = 1; index < spans.length; index += 1) {
          const previous = spans[index - 1];
          const current = spans[index];
          if (ms <= current.startMs) {
            if (current.startMs === previous.startMs) return current.anchorCoord;
            const ratio = (ms - previous.startMs) / (current.startMs - previous.startMs);
            return clamp(previous.anchorCoord + ratio * (current.anchorCoord - previous.anchorCoord), 0, domainEnd);
          }
        }

        return spans[spans.length - 1].anchorCoord;
      },
    };
  }

  const projectTime = distributionMode === "compressed"
    ? createCompressedProjector([sessionStart, sessionEnd, ...baseSpans.flatMap((span) => [span.startMs, span.endMs])])
    : (value: number) => value - sessionStart;

  const spans = baseSpans.map<ProjectedSpan>((span) => ({
    ...span,
    startCoord: projectTime(span.startMs),
    endCoord: projectTime(span.endMs),
    anchorCoord: projectTime(span.startMs),
  }));
  const eventAnchors = new Map(spans.map((span) => [span.event_id, span.anchorCoord]));
  const domainEnd = Math.max(projectTime(sessionEnd), 1);

  return {
    domainEnd,
    spans,
    projectEvent: (eventId: number) => eventAnchors.get(eventId) ?? null,
    projectTime: (ms: number) => clamp(projectTime(ms), 0, domainEnd),
  };
}

/**
 * Group loop spans within a lane into runs (>= 2 events) so each run can be
 * marked with a single background region. Every span still renders individually;
 * the region is only a contextual highlight, never a replacement.
 */
function buildLoopRegions(spans: ProjectedSpan[]): LoopRegion[] {
  const byRunId = new Map<string, ProjectedSpan[]>();
  const looseRuns: ProjectedSpan[][] = [];
  let current: ProjectedSpan[] | null = null;

  for (const span of spans) {
    if (!span.is_loop) {
      current = null;
      continue;
    }
    if (span.loop_run_id) {
      const run = byRunId.get(span.loop_run_id) ?? [];
      run.push(span);
      byRunId.set(span.loop_run_id, run);
      current = null;
      continue;
    }
    if (current && isSameLoopRun(current[current.length - 1], span)) {
      current.push(span);
    } else {
      current = [span];
      looseRuns.push(current);
    }
  }

  const runs: Array<{ id: string; spans: ProjectedSpan[] }> = [
    ...Array.from(byRunId.entries()).map(([id, runSpans]) => ({ id, spans: runSpans })),
    ...looseRuns.map((runSpans) => ({
      id: `loop-${runSpans[0].lane}-${runSpans[0].event_id}-${runSpans[runSpans.length - 1].event_id}`,
      spans: runSpans,
    })),
  ];

  return runs
    .filter((run) => run.spans.length > 1)
    .map((run) => {
      const ordered = [...run.spans].sort((a, b) => a.startCoord - b.startCoord);
      return {
        id: run.id,
        firstEventId: ordered[0].event_id,
        spans: ordered,
        startCoord: ordered[0].startCoord,
        endCoord: Math.max(...ordered.map((item) => item.endCoord)),
      };
    });
}

function spanIntersectsWindow(span: ProjectedSpan, windowStart: number, windowEnd: number): boolean {
  return span.endCoord >= windowStart && span.startCoord <= windowEnd;
}

function regionIntersectsWindow(region: LoopRegion, windowStart: number, windowEnd: number): boolean {
  return region.endCoord >= windowStart && region.startCoord <= windowEnd;
}

function batchKindClass(spans: ProjectedSpan[]): string {
  const kinds = new Set(spans.map((span) => span.kind));
  if (kinds.size === 1) return `k-${spans[0].kind}`;
  if (spans.some((span) => span.kind === "subagent_event")) return "k-subagent_event";
  if (spans.some((span) => span.kind === "tool_call" || span.kind === "tool_result")) return "k-tool_call";
  if (spans.some((span) => span.kind === "assistant")) return "k-assistant";
  if (spans.some((span) => span.kind === "user_turn")) return "k-user_turn";
  return "k-mixed";
}

function batchTitle(spans: ProjectedSpan[]): string {
  const counts = new Map<string, number>();
  for (const span of spans) {
    counts.set(span.kind, (counts.get(span.kind) ?? 0) + 1);
  }
  const summary = Array.from(counts.entries())
    .map(([kind, count]) => `${kind.replace("_", " ")} ${count}`)
    .join(", ");
  const first = spans[0].event_id;
  const last = spans[spans.length - 1].event_id;
  return `${spans.length} events (${summary}) - events ${first}-${last} - click to drill in`;
}

function buildSpanBatches(spans: ProjectedSpan[], layoutForSpan: (span: ProjectedSpan) => { left: number; width: number }): SpanBatch[] {
  const layouts = spans
    .map((span) => ({ span, ...layoutForSpan(span) }))
    .map((layout) => ({ ...layout, right: layout.left + layout.width }))
    .sort((a, b) => a.left - b.left || a.span.event_id - b.span.event_id);
  const groups: SpanBatch[] = [];
  let current: SpanLayout[] = [];
  let currentRight = -Infinity;

  const flush = () => {
    if (current.length === 0) return;

    if (current.length < BATCH_MIN_SPANS) {
      for (const layout of current) {
        groups.push({
          id: layout.span.id,
          spans: [layout.span],
          left: layout.left,
          width: layout.width,
          kindClass: `k-${layout.span.kind}`,
        });
      }
      current = [];
      currentRight = -Infinity;
      return;
    }

    const left = Math.min(...current.map((layout) => layout.left));
    const right = Math.max(...current.map((layout) => layout.right));
    const batchSpans = current.map((layout) => layout.span);
    groups.push({
      id: `batch-${batchSpans[0].lane}-${batchSpans[0].event_id}-${batchSpans[batchSpans.length - 1].event_id}-${batchSpans.length}`,
      spans: batchSpans,
      left,
      width: Math.max(right - left, 4),
      kindClass: batchKindClass(batchSpans),
    });
    current = [];
    currentRight = -Infinity;
  };

  for (const layout of layouts) {
    if (current.length === 0 || layout.left <= currentRight + BATCH_GAP_PX) {
      current.push(layout);
      currentRight = Math.max(currentRight, layout.right);
    } else {
      flush();
      current.push(layout);
      currentRight = layout.right;
    }
  }

  flush();
  return groups;
}

function spanMatchesFilter(span: ProjectedSpan, filter: LegendFilterKey): boolean {
  if (filter === "tool") return span.kind === "tool_call" || span.kind === "tool_result";
  if (filter === "loop") return span.is_loop;
  return span.kind === filter;
}

function TraceView({ trace, selectedEventId, playheadTimestamp, onSelect }: Props) {
  const [distributionMode, setDistributionMode] = React.useState<DistributionMode>("compressed");
  const [tokenMetric, setTokenMetric] = React.useState<TokenMetric>("total");
  const [useLogScale, setUseLogScale] = React.useState(true);
  const [activeFilters, setActiveFilters] = React.useState<Set<LegendFilterKey>>(() => new Set());
  const [batchDenseEvents, setBatchDenseEvents] = React.useState(true);
  const [expandedBatches, setExpandedBatches] = React.useState<Set<string>>(() => new Set());
  const [drillStack, setDrillStack] = React.useState<DrillEntry[]>([]);
  const [brush, setBrush] = React.useState<BrushWindow | null>(null);
  const [draftBrush, setDraftBrush] = React.useState<DraftBrush | null>(null);
  const brushStartX = React.useRef<number | null>(null);
  const projection = React.useMemo(() => buildProjection(trace, distributionMode), [trace, distributionMode]);
  const loopContexts = React.useMemo(() => buildLoopContextMap(trace.spans), [trace.spans]);
  const visibleSpans = React.useMemo(() => {
    if (activeFilters.size === 0) return projection.spans;
    return projection.spans.filter((span) => (
      Array.from(activeFilters).some((filter) => spanMatchesFilter(span, filter))
    ));
  }, [activeFilters, projection.spans]);
  const fullSpan = Math.max(projection.domainEnd, 1);
  const windowStart = brush?.start ?? 0;
  const windowEnd = brush?.end ?? fullSpan;
  const windowSpan = Math.max(windowEnd - windowStart, 1);

  React.useEffect(() => {
    setActiveFilters(new Set());
    setExpandedBatches(new Set());
    setDrillStack([]);
    setBrush(null);
    setDraftBrush(null);
    brushStartX.current = null;
  }, [trace.session_id]);

  React.useEffect(() => {
    setExpandedBatches(new Set());
    setDrillStack([]);
    setBrush(null);
    setDraftBrush(null);
    brushStartX.current = null;
  }, [distributionMode]);

  const xForDomain = (value: number): number => ((value - windowStart) / windowSpan) * TRACK_WIDTH;
  const xForOverview = (value: number): number => (value / fullSpan) * TRACK_WIDTH;

  const geometry = (entryStart: number, entryEnd: number) => {
    const rawLeft = xForDomain(entryStart);
    const rawRight = Math.max(xForDomain(entryEnd), rawLeft + 4);
    const left = Math.min(TRACK_WIDTH - 3, Math.max(0, rawLeft));
    const right = Math.min(TRACK_WIDTH, Math.max(rawRight, left + 3));
    return { left, width: Math.max(right - left, 3) };
  };

  const xToDomain = (value: number): number => (value / TRACK_WIDTH) * fullSpan;

  // The chart reflects whole-session usage, so it reads all spans (not the legend-filtered visibleSpans).
  const tokenSessionMax = sessionMaxForMetric(projection.spans, tokenMetric);
  // Headline readout: the additive session sum (total = input + output), not the per-message peak.
  const tokenSessionSum = sessionSumForMetric(projection.spans, tokenMetric);
  const tokenChart = buildTokenModelChart(
    projection.spans,
    xForDomain,
    TRACK_WIDTH,
    CHART_HEIGHT,
    tokenMetric,
    tokenSessionMax,
    useLogScale,
  );
  const modelList = distinctModels(projection.spans);

  const mouseX = (event: React.MouseEvent<SVGSVGElement>): number => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = bounds.width || TRACK_WIDTH;
    const left = bounds.left || 0;
    return Math.min(TRACK_WIDTH, Math.max(0, ((event.clientX - left) / width) * TRACK_WIDTH));
  };

  const handleBrushMouseDown = (event: React.MouseEvent<SVGSVGElement>) => {
    event.preventDefault();
    const currentX = mouseX(event);
    brushStartX.current = currentX;
    setDraftBrush({ startX: currentX, endX: currentX });
  };

  const handleBrushMouseMove = (event: React.MouseEvent<SVGSVGElement>) => {
    if (brushStartX.current === null) return;
    setDraftBrush({ startX: brushStartX.current, endX: mouseX(event) });
  };

  const handleBrushMouseUp = (event: React.MouseEvent<SVGSVGElement>) => {
    if (brushStartX.current === null) return;
    const from = brushStartX.current;
    const to = mouseX(event);
    brushStartX.current = null;
    setDraftBrush(null);

    if (Math.abs(to - from) < MIN_BRUSH_WIDTH) {
      setBrush(null);
      setDrillStack([]);
      const clickCoord = xToDomain(to);
      let nearest: ProjectedSpan | null = null;
      let nearestDist = Infinity;
      for (const span of projection.spans) {
        const dist = Math.abs(span.anchorCoord - clickCoord);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = span;
        }
      }
      if (nearest) onSelect(nearest.event_id);
      return;
    }

    const nextStart = Math.min(xToDomain(from), xToDomain(to));
    const nextEnd = Math.max(xToDomain(from), xToDomain(to));
    setDrillStack([]);
    setBrush({ start: nextStart, end: nextEnd });
  };

  const handleBrushMouseLeave = () => {
    brushStartX.current = null;
    setDraftBrush(null);
  };

  const toggleFilter = (key: LegendFilterKey) => {
    setActiveFilters((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const brushRect = draftBrush
    ? {
      x: Math.min(draftBrush.startX, draftBrush.endX),
      width: Math.abs(draftBrush.endX - draftBrush.startX),
    }
    : brush
      ? {
        x: (brush.start / fullSpan) * TRACK_WIDTH,
        width: ((brush.end - brush.start) / fullSpan) * TRACK_WIDTH,
      }
      : null;

  const playheadCoord = React.useMemo(() => {
    if (selectedEventId !== null) {
      const selectedCoord = projection.projectEvent(selectedEventId);
      if (selectedCoord !== null) return selectedCoord;
    }

    const playheadMs = toMs(playheadTimestamp);
    if (playheadMs === null) return null;
    return projection.projectTime(playheadMs);
  }, [playheadTimestamp, projection, selectedEventId]);

  const lanePlayheadX =
    playheadCoord !== null && playheadCoord >= windowStart && playheadCoord <= windowEnd
      ? xForDomain(playheadCoord)
      : null;

  const minimapPlayheadX = playheadCoord !== null ? xForOverview(playheadCoord) : null;
  const currentDrill = drillStack[drillStack.length - 1] ?? null;

  const drillIntoBatch = (batch: SpanBatch) => {
    const startCoord = Math.min(...batch.spans.map((span) => span.startCoord));
    const endCoord = Math.max(...batch.spans.map((span) => span.endCoord));
    const contentSpan = Math.max(endCoord - startCoord, fullSpan * 0.01, 1);
    const padding = Math.max(contentSpan * 0.65, fullSpan * 0.015);
    let start = clamp(startCoord - padding, 0, fullSpan);
    let end = clamp(endCoord + padding, 0, fullSpan);
    const minWindow = Math.min(fullSpan, Math.max(contentSpan * 2.25, fullSpan * 0.04));

    if (end - start < minWindow) {
      const center = (startCoord + endCoord) / 2;
      start = clamp(center - minWindow / 2, 0, fullSpan);
      end = clamp(start + minWindow, 0, fullSpan);
      start = clamp(end - minWindow, 0, fullSpan);
    }

    setExpandedBatches((current) => {
      const next = new Set(current);
      next.add(batch.id);
      return next;
    });
    setDrillStack((current) => [
      ...current,
      {
        batchId: batch.id,
        label: `x${batch.spans.length} events`,
        previousBrush: brush,
      },
    ]);
    setBrush({ start, end });
  };

  const stepBackDrill = () => {
    const last = drillStack[drillStack.length - 1];
    if (!last) return;
    setBrush(last.previousBrush);
    setExpandedBatches((expanded) => {
      const next = new Set(expanded);
      next.delete(last.batchId);
      return next;
    });
    setDrillStack((current) => current.slice(0, -1));
  };

  const renderSpan = (span: ProjectedSpan) => {
    const { left, width } = geometry(span.startCoord, span.endCoord);
    const selected = span.event_id === selectedEventId;
    const loopContext = loopContexts.get(span.event_id);
    const title = loopContext
      ? loopExplanation(loopContext)
      : `${span.kind.replace("_", " ")} event ${span.event_id}`;
    return (
      <g key={span.id} onClick={() => onSelect(span.event_id)}>
        <title>{title}</title>
        <rect
          data-event-id={span.event_id}
          x={left}
          y={6}
          width={width}
          height={LANE_HEIGHT - 12}
          rx={3}
          className={`trace-span k-${span.kind} ${selected ? "is-selected" : ""}`}
          style={{ cursor: "pointer" }}
        />
      </g>
    );
  };

  const renderBatch = (batch: SpanBatch) => {
    const selected = batch.spans.some((span) => span.event_id === selectedEventId);
    const title = batchTitle(batch.spans);
    const label = `x${batch.spans.length}`;
    const labelX = batch.left + batch.width / 2;
    const showLabel = batch.width >= 24;
    const handleDrill = () => drillIntoBatch(batch);
    return (
      <g
        key={batch.id}
        role="button"
        tabIndex={0}
        data-trace-batch={batch.id}
        data-batch-size={batch.spans.length}
        data-batch-event-ids={batch.spans.map((span) => span.event_id).join(",")}
        className={`trace-batch ${batch.kindClass} ${selected ? "is-selected" : ""}`}
        onClick={handleDrill}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          handleDrill();
        }}
      >
        <title>{title}</title>
        <rect
          x={batch.left}
          y={4}
          width={batch.width}
          height={LANE_HEIGHT - 8}
          rx={5}
        />
        {showLabel && (
          <text x={labelX} y={LANE_HEIGHT / 2 + 4} textAnchor="middle">
            {label}
          </text>
        )}
      </g>
    );
  };

  const renderLoopRegion = (region: LoopRegion) => {
    const { left, width } = geometry(region.startCoord, region.endCoord);
    const selected = region.spans.some((span) => span.event_id === selectedEventId);
    const context = loopContexts.get(region.firstEventId);
    return (
      <g
        key={region.id}
        data-loop-region={region.id}
        data-loop-count={region.spans.length}
        className="trace-loop-band"
        onClick={() => onSelect(region.firstEventId)}
      >
        <title>{context ? loopExplanation(context) : `loop \u00d7${region.spans.length}`}</title>
        <rect
          x={left}
          y={3}
          width={width}
          height={LANE_HEIGHT - 6}
          rx={5}
          className={`trace-loopband ${selected ? "is-selected" : ""}`}
        />
      </g>
    );
  };

  return (
    <div className="trace-view" data-distribution-mode={distributionMode} data-drill-depth={drillStack.length}>
      <div className="trace-toolbar">
        <div className="trace-legend" aria-label="Trace visualization legend">
          {LEGEND_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`trace-legend-filter ${activeFilters.has(item.key) ? "active" : ""}`}
              aria-pressed={activeFilters.has(item.key)}
              onClick={() => toggleFilter(item.key)}
              title={activeFilters.has(item.key) ? `Hide ${item.label}` : `Show only ${item.label}`}
            >
              <i className={`sw sw-${item.key}`} />
              {item.label}
            </button>
          ))}
          <span><i className="trace-selected-swatch" /> Selected event</span>
        </div>
        <label className="trace-mode-select">
          <span>Spacing</span>
          <select aria-label="Timeline spacing" value={distributionMode} onChange={(event) => setDistributionMode(event.target.value as DistributionMode)}>
            {DISTRIBUTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="trace-batch-toggle">
          <input
            type="checkbox"
            checked={batchDenseEvents}
            onChange={(event) => {
              setBatchDenseEvents(event.target.checked);
              setExpandedBatches(new Set());
              setDrillStack([]);
            }}
          />
          <span>Group dense</span>
        </label>
        {currentDrill && (
          <div className="trace-drill-controls">
            <button type="button" className="trace-drill-back" onClick={stepBackDrill}>
              <ArrowLeft size={13} />
              Back
            </button>
            <span>{currentDrill.label}</span>
          </div>
        )}
      </div>

      <div className="trace-minimap" aria-label="Event Timeline">
        <span className="lane-label">Event Timeline</span>
        <svg
          width="100%"
          height="26"
          viewBox={`0 0 ${TRACK_WIDTH} 26`}
          preserveAspectRatio="none"
          onMouseDown={handleBrushMouseDown}
          onMouseMove={handleBrushMouseMove}
          onMouseUp={handleBrushMouseUp}
          onMouseLeave={handleBrushMouseLeave}
          onDoubleClick={() => {
            setBrush(null);
            setDrillStack([]);
          }}
        >
          <rect className="trace-minimap-base" width={TRACK_WIDTH} height={26} />
          {visibleSpans.map((span) => (
            <line
              key={`m-${span.id}`}
              x1={xForOverview(span.anchorCoord)}
              x2={xForOverview(span.anchorCoord)}
              y1={2}
              y2={24}
              className={`mini-tick ${span.is_loop ? "k-loop" : `k-${span.kind}`}`}
            />
          ))}
          {brushRect && brushRect.width > 0 && (
            <rect className="trace-brush" x={brushRect.x} y={1} width={brushRect.width} height={24} />
          )}
          {minimapPlayheadX !== null && (
            <line className="trace-playhead" data-playhead="minimap" x1={minimapPlayheadX} x2={minimapPlayheadX} y1={0} y2={26} />
          )}
        </svg>
      </div>

      <div className="trace-lanes">
        {trace.lanes.map((lane) => {
          const laneSpans = visibleSpans
            .filter((span) => span.lane === lane.lane_id)
            .filter((span) => spanIntersectsWindow(span, windowStart, windowEnd));
          const laneBatches = batchDenseEvents
            ? buildSpanBatches(laneSpans, (span) => geometry(span.startCoord, span.endCoord))
            : laneSpans.map((span) => {
              const { left, width } = geometry(span.startCoord, span.endCoord);
              return {
                id: span.id,
                spans: [span],
                left,
                width,
                kindClass: `k-${span.kind}`,
              };
            });
          const laneRegions = buildLoopRegions(laneSpans)
            .filter((region) => regionIntersectsWindow(region, windowStart, windowEnd));
          return (
            <div className="trace-lane" key={lane.lane_id}>
              <span className={`lane-label ${lane.kind}`}>{lane.label}</span>
              <svg className="lane-track" width="100%" height={LANE_HEIGHT} viewBox={`0 0 ${TRACK_WIDTH} ${LANE_HEIGHT}`} preserveAspectRatio="none">
                {laneRegions.map(renderLoopRegion)}
                {laneBatches.map((batch) => {
                  const expanded = batch.spans.length === 1
                    || expandedBatches.has(batch.id)
                    || batch.spans.some((span) => span.event_id === selectedEventId);
                  return expanded ? (
                    <React.Fragment key={batch.id}>
                      {batch.spans.map(renderSpan)}
                    </React.Fragment>
                  ) : renderBatch(batch);
                })}
                {lanePlayheadX !== null && (
                  <line className="trace-playhead" data-playhead={`lane-${lane.lane_id}`} x1={lanePlayheadX} x2={lanePlayheadX} y1={0} y2={LANE_HEIGHT} />
                )}
              </svg>
            </div>
          );
        })}
      </div>

      <div className="trace-token-chart">
        <div className="trace-chart-main">
          <div className="trace-chart-gutter">
            <label className="trace-token-metric">
              <span>Tokens</span>
              <select aria-label="Token metric" value={tokenMetric} onChange={(event) => setTokenMetric(event.target.value as TokenMetric)}>
                <option value="total">Total</option>
                <option value="input">Input</option>
                <option value="output">Output</option>
              </select>
            </label>
            {trace.cost?.available && (
              <span
                className="trace-cost"
                title={
                  trace.cost.unpriced_models.length > 0
                    ? `Estimated from pricing.csv · excludes unpriced model(s): ${trace.cost.unpriced_models.join(", ")}`
                    : "Estimated session cost from pricing.csv"
                }
              >
                {formatUsd(trace.cost.usd)}
                {trace.cost.unpriced_models.length > 0 && <sup>*</sup>}
              </span>
            )}
            {tokenSessionSum > 0 && (
              <span
                className="trace-token-total"
                title={`${tokenMetric} tokens across the visible trace session`}
              >
                {`${formatTokens(tokenSessionSum)} ${tokenMetric} tokens`}
              </span>
            )}
          </div>
          <div className="trace-chart-plot">
            <svg
              className="trace-chart-track"
              width="100%"
              height={CHART_HEIGHT}
              viewBox={`0 0 ${TRACK_WIDTH} ${CHART_HEIGHT}`}
              preserveAspectRatio="none"
              aria-label="Token usage by model"
            >
              {tokenChart.segments.map((segment) => (
                <g key={segment.firstEventId}>
                  <path d={segment.areaPath} fill={modelColor(segment.model, modelList)} fillOpacity={0.3} />
                  <path d={segment.linePath} fill="none" stroke={modelColor(segment.model, modelList)} strokeWidth={1.5} />
                </g>
              ))}
              {tokenChart.segments.length === 0 &&
                tokenChart.points.map((point) => (
                  <circle key={point.event_id} cx={point.x} cy={point.y} r={3} fill={modelColor(point.model, modelList)} />
                ))}
              {lanePlayheadX !== null && (
                <line className="trace-playhead" data-playhead="chart" x1={lanePlayheadX} x2={lanePlayheadX} y1={0} y2={CHART_HEIGHT} />
              )}
              {tokenChart.points.map((point) => (
                <rect
                  key={`hit-${point.event_id}`}
                  data-point-event={point.event_id}
                  x={Math.max(0, point.x - 5)}
                  y={0}
                  width={10}
                  height={CHART_HEIGHT}
                  fill="transparent"
                >
                  <title>{`${point.value.toLocaleString()} ${tokenMetric} tokens · ${shortModelName(point.model)}${point.ts ? ` · ${new Date(point.ts).toLocaleTimeString()}` : ""}`}</title>
                </rect>
              ))}
            </svg>
            {tokenChart.points.length === 0 && <span className="trace-chart-empty">No token data</span>}
          </div>
        </div>
        <div className="trace-chart-footer">
          <div className="trace-chart-footer-inner">
            {modelList.length > 0 && (
              <div className="trace-model-legend trace-model-legend-bottom">
                {modelList.map((model) => (
                  <span key={model} className="trace-model-chip">
                    <i style={{ background: modelColor(model, modelList) }} />
                    {shortModelName(model)}
                  </span>
                ))}
              </div>
            )}
            <label className="trace-chart-toggle">
              <input type="checkbox" checked={useLogScale} onChange={(event) => setUseLogScale(event.target.checked)} />
              <span>Log scale</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TraceView;
