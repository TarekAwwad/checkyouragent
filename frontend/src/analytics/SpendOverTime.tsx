import type { CostAnalyticsResponse } from "../api/types";
import { buildSpendArea, displayModelName, orderedModels, FALLBACK_COLOR } from "./chartGeometry";

interface Props {
  payload: CostAnalyticsResponse;
  colors: Record<string, string>;
}

const W = 600;
const H = 150;

export default function SpendOverTime({ payload, colors }: Props) {
  if (payload.over_time.length === 0) return <div className="empty-state">No spend in range.</div>;
  const order = orderedModels(payload.by_model);
  const area = buildSpendArea(payload.over_time, order, W, H);

  return (
    <div className="sot">
      <div className="sot-plot">
        <svg className="sot-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Spend over time">
          {area.yTicks.map((t) => (
            <line key={t.y} className="sot-grid" x1={0} y1={t.y} x2={W} y2={t.y} />
          ))}
          {area.paths.map((p) => (
            <g key={p.model}>
              <path d={p.areaPath} fill={colors[p.model] ?? FALLBACK_COLOR} fillOpacity={0.22} />
              <path d={p.linePath} fill="none" stroke={colors[p.model] ?? FALLBACK_COLOR} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
        </svg>
        {area.yTicks.map((t) => (
          <span className="sot-ylabel" key={t.y} style={{ top: `${(t.y / H) * 100}%` }}>{t.label}</span>
        ))}
      </div>
      <div className="sot-xaxis">
        {area.xLabels.map((x) => (<span key={x.label}>{x.label}</span>))}
      </div>
      <div className="chip-legend card-bottom-legend">
        {area.paths.map((p) => (
          <span key={p.model}><i style={{ background: colors[p.model] ?? FALLBACK_COLOR }} />{displayModelName(p.model)}</span>
        ))}
      </div>
    </div>
  );
}
