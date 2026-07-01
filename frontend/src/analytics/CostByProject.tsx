// frontend/src/analytics/CostByProject.tsx
import type { CostAnalyticsResponse } from "../api/types";
import { displayModelName, formatUsd, orderedModels, stackedSegments, topProjectsWithRollup, FALLBACK_COLOR } from "./chartGeometry";
import { Blurred } from "../shell/Blurred";

interface Props {
  payload: CostAnalyticsResponse;
  colors: Record<string, string>;
  available: boolean;
}

export default function CostByProject({ payload, colors, available }: Props) {
  if (!available) return <div className="empty-state">Cost estimate unavailable — no price table loaded.</div>;
  const { top, rollup } = topProjectsWithRollup(payload.treemap, 5);
  if (top.length === 0) return <div className="empty-state">No cost data in range.</div>;
  const order = orderedModels(payload.by_model);

  return (
    <div className="cbp">
      {top.map((project) => {
        const segments = stackedSegments(project.children, order, project.usd);
        return (
          <div className="cbp-row" key={project.project_id}>
            <div className="cbp-label" title={project.project_name}><Blurred>{project.project_name}</Blurred></div>
            <div className="cbp-track">
              {segments.map((s) => (
                <i key={s.model} style={{ width: `${s.pct}%`, background: colors[s.model] ?? FALLBACK_COLOR }}
                   title={`${displayModelName(s.model)}: ${formatUsd(s.usd)}`} />
              ))}
            </div>
            <div className="cbp-val">{formatUsd(project.usd)}</div>
          </div>
        );
      })}
      {rollup.count > 0 && (
        <div className="cbp-more">+ {rollup.count} more {rollup.count === 1 ? "project" : "projects"} · {formatUsd(rollup.usd)}</div>
      )}
      <div className="chip-legend card-bottom-legend">
        {order.map((m) => (
          <span key={m}><i style={{ background: colors[m] ?? FALLBACK_COLOR }} />{displayModelName(m)}</span>
        ))}
      </div>
    </div>
  );
}
