import { metricValue } from "./tokenHeatmap";
import type { TokenMetric } from "./tokenHeatmap";

export interface ChartPointInput {
  event_id: number;
  anchorCoord: number;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  start_ts?: string | null;
}

export interface ChartPoint {
  x: number;
  y: number;
  value: number;
  model: string;
  event_id: number;
  ts: string | null;
}

export interface ChartSegment {
  areaPath: string;
  linePath: string;
  model: string;
  firstEventId: number;
}

export interface TokenModelChart {
  points: ChartPoint[];
  segments: ChartSegment[];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const round = (value: number): number => Math.round(value * 100) / 100;

/** Peak value of the chosen metric across model-bearing spans; 0 if none. */
export function sessionMaxForMetric(spans: ChartPointInput[], metric: TokenMetric): number {
  let max = 0;
  for (const span of spans) {
    if (!span.model) continue;
    const value = metricValue(span, metric);
    if (value > max) max = value;
  }
  return max;
}

/**
 * Sum of the chosen metric across model-bearing spans (the same spans the chart plots).
 * Unlike {@link sessionMaxForMetric}, this is additive: the "total" sum equals the "input"
 * sum plus the "output" sum, which is what the headline token readout should show.
 */
export function sessionSumForMetric(spans: ChartPointInput[], metric: TokenMetric): number {
  let sum = 0;
  for (const span of spans) {
    if (!span.model) continue;
    sum += metricValue(span, metric);
  }
  return sum;
}

function makeSegment(runPoints: ChartPoint[], model: string, chartHeight: number): ChartSegment {
  const coords = runPoints.map((p) => `${round(p.x)},${round(p.y)}`);
  const linePath = `M ${coords.join(" L ")}`;
  const first = runPoints[0];
  const last = runPoints[runPoints.length - 1];
  const areaPath =
    `M ${round(first.x)},${chartHeight} ` +
    runPoints.map((p) => `L ${round(p.x)},${round(p.y)}`).join(" ") +
    ` L ${round(last.x)},${chartHeight} Z`;
  return { areaPath, linePath, model, firstEventId: first.event_id };
}

/**
 * Build a model-colored area chart from the spans. Each model-bearing span with
 * non-zero usage for the chosen metric is a point: x from `xForDomain(anchorCoord)`
 * clamped to the visible `[0, trackWidth]` window, y from the chosen metric on a
 * `[0, sessionMax]` scale (peak at the top). Consecutive points are joined into area
 * segments; each segment covers one contiguous run of the same active model (the
 * left point of each edge sets the color), so adjacent runs meet at the switch.
 */
export function buildTokenModelChart(
  spans: ChartPointInput[],
  xForDomain: (coord: number) => number,
  trackWidth: number,
  chartHeight: number,
  metric: TokenMetric,
  sessionMax: number,
  useLogScale = true,
): TokenModelChart {
  const ordered = spans
    .filter((span): span is ChartPointInput & { model: string } => Boolean(span.model) && metricValue(span, metric) > 0)
    .slice()
    .sort((a, b) => a.anchorCoord - b.anchorCoord);

  const denom = sessionMax > 0 ? (useLogScale ? Math.log1p(sessionMax) : sessionMax) : 0;
  const points: ChartPoint[] = ordered.map((span) => {
    const value = metricValue(span, metric);
    const ratio = denom > 0
      ? (useLogScale ? Math.log1p(value) / denom : value / denom)
      : 0;
    return {
      x: clamp(xForDomain(span.anchorCoord), 0, trackWidth),
      y: chartHeight - ratio * chartHeight,
      value,
      model: span.model,
      event_id: span.event_id,
      ts: span.start_ts ?? null,
    };
  });

  const segments: ChartSegment[] = [];
  let start = 0; // index of the first edge in the current run
  for (let i = 0; i < points.length - 1; i += 1) {
    const isLastEdge = i === points.length - 2;
    const edgeColorChanges = !isLastEdge && points[i].model !== points[i + 1].model;
    if (isLastEdge || edgeColorChanges) {
      // Boundary point (i+1) joins both this segment and the next so the filled areas meet cleanly.
      const runPoints = points.slice(start, i + 2); // points start..i+1 inclusive
      segments.push(makeSegment(runPoints, points[start].model, chartHeight));
      start = i + 1;
    }
  }

  return { points, segments };
}
