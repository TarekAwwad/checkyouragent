import React from "react";
import type { CostAnalyticsResponse, OverTimeBucket } from "../api/types";
import {
  ACCENT_COLOR,
  buildSpendArea,
  displayModelName,
  formatUsd,
  orderedModels,
  FALLBACK_COLOR,
} from "./chartGeometry";
import { formatCostPeriod } from "./costPeriods";

interface Props {
  payload: CostAnalyticsResponse;
  colors: Record<string, string>;
  selectedBucket?: string | null;
  onSelectBucket?: (bucket: string) => void;
}

const W = 600;
const H = 150;

type DisplayMode = "total" | "model";

function coverageLabel(bucket: OverTimeBucket): string {
  if (bucket.session_count === 0) return "no sessions";
  if (bucket.priced_session_count === bucket.session_count) {
    return `${bucket.session_count} session${bucket.session_count === 1 ? "" : "s"} priced`;
  }
  return `${bucket.priced_session_count} of ${bucket.session_count} sessions priced`;
}

function costLabel(bucket: OverTimeBucket): string {
  return `${bucket.costs_are_lower_bound ? "≥" : ""}${formatUsd(bucket.total_usd)}`;
}

function plotTop(y: number): string {
  const ratio = y / H;
  return `calc(12px + ${ratio * 100}% - ${ratio * 12}px)`;
}

export default function SpendOverTime({
  payload,
  colors,
  selectedBucket,
  onSelectBucket,
}: Props) {
  const [mode, setMode] = React.useState<DisplayMode>("total");
  const [isolatedModel, setIsolatedModel] = React.useState<string | null>(null);
  const [hoveredBucket, setHoveredBucket] = React.useState<string | null>(null);
  const [localSelectedBucket, setLocalSelectedBucket] = React.useState<string | null>(null);
  const fullOrder = orderedModels(payload.by_model);
  const effectiveIsolation = isolatedModel && fullOrder.includes(isolatedModel) ? isolatedModel : null;

  React.useEffect(() => {
    if (isolatedModel && !effectiveIsolation) setIsolatedModel(null);
  }, [isolatedModel, effectiveIsolation]);

  const heading = (
    <div className="session-visual-heading sot-heading">
      <h2>Spend over time</h2>
      <div className="heat-metric-control" role="radiogroup" aria-label="Spend display">
        <span className="heat-metric-label">View</span>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "total"}
          onClick={() => setMode("total")}
        >
          Total spend
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "model"}
          onClick={() => setMode("model")}
        >
          Spend by model
        </button>
      </div>
    </div>
  );

  if (payload.over_time.length === 0) {
    return (
      <div className="sot">
        {heading}
        <div className="empty-state">No spend in range.</div>
        <div className="sot-legend-slot" aria-hidden="true" />
      </div>
    );
  }
  const order = effectiveIsolation ? [effectiveIsolation] : fullOrder;
  const chartBuckets = mode === "total"
    ? payload.over_time.map((bucket) => ({ ...bucket, per_model: { total: bucket.total_usd } }))
    : payload.over_time;
  const chartOrder = mode === "total" ? ["total"] : order;
  const area = buildSpendArea(chartBuckets, chartOrder, W, H);
  const controlled = selectedBucket !== undefined;
  const effectiveSelected = controlled ? selectedBucket : localSelectedBucket;
  const activeBucketKey = hoveredBucket ?? effectiveSelected;
  const activeBucket = payload.over_time.find((bucket) => bucket.bucket === activeBucketKey) ?? null;
  const activePoint = area.points.find((point) => point.bucket === activeBucketKey) ?? null;
  const periods = new Map(payload.over_time.map((bucket) => [bucket.bucket, bucket]));
  const selectBucket = (bucket: string) => {
    const next = effectiveSelected === bucket ? null : bucket;
    if (!controlled) setLocalSelectedBucket(next);
    onSelectBucket?.(bucket);
  };

  return (
    <div className="sot">
      {heading}
      <div className="sot-plot">
        <span className="sot-axis-title sot-axis-title-y">Estimated cost (USD)</span>
        <svg className="sot-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Spend over time">
          {area.yTicks.map((t) => (
            <line key={t.y} className="sot-grid" x1={0} y1={t.y} x2={W} y2={t.y} />
          ))}
          {area.paths.map((p) => (
            <g key={p.model}>
              <path
                d={p.areaPath}
                fill={p.model === "total" ? ACCENT_COLOR : colors[p.model] ?? FALLBACK_COLOR}
                fillOpacity={p.model === "total" ? 0.16 : 0.2}
              />
              <path
                data-series={p.model}
                d={p.linePath}
                fill="none"
                stroke={p.model === "total" ? ACCENT_COLOR : colors[p.model] ?? FALLBACK_COLOR}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>
        {area.yTicks.map((t) => (
          <span className="sot-ylabel" key={t.y} style={{ top: plotTop(t.y) }}>{t.label}</span>
        ))}
        {area.points.map((point, index) => {
          const bucket = payload.over_time[index];
          const before = index === 0 ? 0 : (area.points[index - 1].x + point.x) / 2;
          const after = index === area.points.length - 1 ? W : (point.x + area.points[index + 1].x) / 2;
          return (
            <button
              type="button"
              key={bucket.bucket}
              className={`sot-hit${effectiveSelected === bucket.bucket ? " is-selected" : ""}`}
              style={{ left: `${(before / W) * 100}%`, width: `${((after - before) / W) * 100}%` }}
              aria-label={`${formatCostPeriod(bucket, payload.meta.bucket)}: ${costLabel(bucket)}, ${coverageLabel(bucket)}${bucket.is_complete === false ? ", partial period" : ""}`}
              onMouseEnter={() => setHoveredBucket(bucket.bucket)}
              onMouseLeave={() => setHoveredBucket(null)}
              onFocus={() => setHoveredBucket(bucket.bucket)}
              onBlur={() => setHoveredBucket(null)}
              onClick={() => selectBucket(bucket.bucket)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  selectBucket(bucket.bucket);
                }
              }}
            />
          );
        })}
        {activePoint && (
          <>
            <i className="sot-crosshair" style={{ left: `${(activePoint.x / W) * 100}%` }} />
            <i
              className="sot-point"
              style={{ left: `${(activePoint.x / W) * 100}%`, top: plotTop(activePoint.y) }}
            />
          </>
        )}
        {activeBucket && activePoint && (
          <div
            className={`sot-tooltip${activePoint.x > W * 0.58 ? " is-left" : ""}`}
            role="status"
          >
            <strong>{formatCostPeriod(activeBucket, payload.meta.bucket)}</strong>
            <b>{costLabel(activeBucket)}</b>
            <span>{coverageLabel(activeBucket)}</span>
            {activeBucket.is_complete === false && <span>Partial period · excluded from spike comparisons</span>}
            {Object.entries(activeBucket.per_model)
              .filter(([, usd]) => usd > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([model, usd]) => (
                <span key={model}>{displayModelName(model)} {formatUsd(usd)}</span>
              ))}
            {activeBucket.unpriced_models.map((model) => (
              <span className="sot-unpriced" key={model}>{displayModelName(model)} unpriced</span>
            ))}
          </div>
        )}
      </div>
      <div className="sot-xaxis">
        {area.xLabels.map((x, index) => (
          <span
            key={x.label}
            className={index === 0 ? "is-first" : index === area.xLabels.length - 1 ? "is-last" : ""}
            style={{ left: `${(x.x / W) * 100}%` }}
            title={formatCostPeriod(periods.get(x.label) ?? { bucket: x.label }, payload.meta.bucket)}
          >
            {formatCostPeriod(periods.get(x.label) ?? { bucket: x.label }, payload.meta.bucket, true)}
          </span>
        ))}
        <b>{payload.meta.bucket === "week" ? "Week starting (UTC)" : "Date (UTC)"}</b>
      </div>
      <div className="chip-legend card-bottom-legend sot-legend sot-legend-slot" aria-label="Spend legend">
        {mode === "model" ? (
          <>
          {fullOrder.map((model) => (
            <button
              type="button"
              key={model}
              className={effectiveIsolation && effectiveIsolation !== model ? "is-muted" : ""}
              aria-pressed={effectiveIsolation === model}
              aria-label={effectiveIsolation === model ? `Show all models` : `Show only ${displayModelName(model)}`}
              onClick={() => setIsolatedModel((current) => current === model ? null : model)}
            >
              <i style={{ background: colors[model] ?? FALLBACK_COLOR }} />
              {displayModelName(model)}
            </button>
          ))}
          </>
        ) : (
          <span className="sot-total-key"><i style={{ background: ACCENT_COLOR }} />Total spend</span>
        )}
      </div>
    </div>
  );
}
