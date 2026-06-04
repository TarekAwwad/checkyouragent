import React from "react";
import type { TimelineItem } from "../api/types";
import { ACCENT_COLOR, WARNING_COLOR, DANGER_COLOR, INFO_COLOR } from "../analytics/chartGeometry";
import type { LoopContext } from "../trace/loopContext";
import { buildDensity } from "./sessionAnalytics";

interface Props {
  items: TimelineItem[];
  loopContexts?: Map<number, LoopContext>;
  loading?: boolean;
}

const VIEW_W = 600;
const VIEW_H = 150;
const BASE_Y = 138;
const TOP_Y = 14;
const EVENT_COLOR = ACCENT_COLOR;
const LOOP_COLOR = WARNING_COLOR;
const ERROR_COLOR = DANGER_COLOR;

// Area chart of event count over session time. It uses the same chart shell as
// the cost page Spend over time graph, with overlays for error and loop points.
export default function EventDensityTile({ items, loopContexts, loading }: Props) {
  const model = React.useMemo(() => buildDensity(items, loopContexts, 32), [items, loopContexts]);

  const points = React.useMemo(() => {
    const n = model.buckets.length;
    const step = n > 1 ? VIEW_W / (n - 1) : 0;
    const range = BASE_Y - TOP_Y;
    return model.buckets.map((bucket, index) => {
      const x = n > 1 ? index * step : VIEW_W / 2;
      const ratio = model.maxCount > 0 ? bucket.count / model.maxCount : 0;
      const y = BASE_Y - ratio * range;
      return { x, y, bucket };
    });
  }, [model]);

  const linePath = React.useMemo(() => {
    if (points.length === 0) return "";
    return `M ${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ")}`;
  }, [points]);

  const areaPath = React.useMemo(() => {
    if (points.length === 0) return "";
    const last = points[points.length - 1];
    return `${linePath} L ${last.x.toFixed(1)},${VIEW_H} L ${points[0].x.toFixed(1)},${VIEW_H} Z`;
  }, [linePath, points]);

  const xLabels = React.useMemo(() => {
    if (model.durationMinutes <= 0) return [] as { x: number; label: string }[];
    const ticks = [0, 0.33, 0.66, 1];
    return ticks.map((t) => ({
      x: t * VIEW_W,
      label: `${Math.round(t * model.durationMinutes)}m`,
    }));
  }, [model.durationMinutes]);

  const yTicks = React.useMemo(() => {
    const max = Math.max(model.maxCount, 1);
    return [max, max / 2, 0].map((value) => ({
      y: BASE_Y - (value / max) * (BASE_Y - TOP_Y),
      label: Number.isInteger(value) ? String(value) : value.toFixed(1),
    }));
  }, [model.maxCount]);

  const gradientId = React.useId();

  return (
    <section className="tile session-tile">
      <h2>Event density</h2>
      {loading ? (
        <div className="session-tile-empty">Loading...</div>
      ) : model.total === 0 ? (
        <div className="session-tile-empty">No events</div>
      ) : (
        <div className="sot event-density-chart">
          <div className="sot-plot event-density-plot">
            <svg className="sot-svg" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" role="img" aria-label="Event density over time">
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={EVENT_COLOR} stopOpacity="0.28" />
                  <stop offset="100%" stopColor={EVENT_COLOR} stopOpacity="0" />
                </linearGradient>
              </defs>
              {yTicks.map((tick) => (
                <line key={tick.y} x1={0} y1={tick.y} x2={VIEW_W} y2={tick.y} className="sot-grid" />
              ))}
              {areaPath && <path d={areaPath} fill={`url(#${gradientId})`} />}
              {linePath && <path d={linePath} fill="none" className="event-density-line" style={{ stroke: EVENT_COLOR }} />}
              {points
                .filter((p) => p.bucket.hasLoop)
                .map((p) => (
                  <g key={`loop-${p.bucket.index}`} data-marker="loop">
                    <line x1={p.x} y1={p.y} x2={p.x} y2={VIEW_H} className="event-density-mark-loop" style={{ stroke: LOOP_COLOR }} />
                    <circle cx={p.x} cy={p.y} r={3.2} className="event-density-dot-loop" style={{ fill: LOOP_COLOR }} />
                  </g>
                ))}
              {points
                .filter((p) => p.bucket.hasError)
                .map((p) => (
                  <g key={`err-${p.bucket.index}`} data-marker="error">
                    <line x1={p.x} y1={p.y} x2={p.x} y2={VIEW_H} className="event-density-mark-error" style={{ stroke: ERROR_COLOR }} />
                    <circle cx={p.x} cy={p.y} r={3.2} className="event-density-dot-error" style={{ fill: ERROR_COLOR }} />
                  </g>
                ))}
            </svg>
            {yTicks.map((tick) => (
              <span className="sot-ylabel" key={tick.y} style={{ top: `${(tick.y / VIEW_H) * 100}%` }}>
                {tick.label}
              </span>
            ))}
          </div>
          {xLabels.length > 0 && (
            <div className="sot-xaxis">
              {xLabels.map((tick) => (
                <span key={tick.label + tick.x}>{tick.label}</span>
              ))}
            </div>
          )}
          <div className="chip-legend card-bottom-legend">
            <span><i style={{ background: EVENT_COLOR }} />events</span>
            <span><i style={{ background: ERROR_COLOR, borderRadius: "999px" }} />error</span>
            <span><i style={{ background: LOOP_COLOR, borderRadius: "999px" }} />loop</span>
          </div>
        </div>
      )}
    </section>
  );
}
