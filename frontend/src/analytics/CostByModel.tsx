import type { CostAnalyticsResponse } from "../api/types";
import {
  chartModels,
  displayModelName,
  effectiveUsdPerMillion,
  formatTokens,
  formatUsd,
  formatUsdPerMillion,
  modelSpendSharePct,
  modelTokenSharePct,
  FALLBACK_COLOR,
} from "./chartGeometry";

interface Props {
  payload: CostAnalyticsResponse;
  colors: Record<string, string>;
  available: boolean;
}

export default function CostByModel({ payload, colors, available }: Props) {
  if (!available) return <div className="empty-state">Cost estimate unavailable - no price table loaded.</div>;
  const rows = chartModels(payload.by_model);
  if (rows.length === 0) return <div className="empty-state">No models in range.</div>;
  const max = Math.max(...rows.map((m) => m.usd), 0);

  return (
    <div className="cbm" role="region" aria-label="Model costs" tabIndex={0}>
      {rows.map((m) => {
        const spendPct = payload.meta.costs_partial ? null : modelSpendSharePct(m, payload);
        const tokenPct = modelTokenSharePct(m, payload);
        return (
          <div className="cbm-row" key={m.model}>
            <div className="cbm-label" title={m.model}>{displayModelName(m.model)}</div>
            <div className="cbm-bars">
              <div className="cbm-track" title={spendPct === null ? `${formatUsd(m.usd)} priced spend` : `${spendPct}% spend share`}>
                <i style={{ width: max > 0 ? `${(m.usd / max) * 100}%` : "0%", background: colors[m.model] ?? FALLBACK_COLOR }} />
              </div>
              <div className="cbm-token-track" title={`${tokenPct}% token share`}>
                <i style={{ width: `${tokenPct}%` }} />
              </div>
            </div>
            <div className="cbm-val">
              <b>{formatUsd(m.usd)}</b>
              {spendPct !== null && <span>{spendPct}% of spend</span>}
              <span>{formatTokens(m.tokens)} tok</span>
              <span>{formatUsdPerMillion(effectiveUsdPerMillion(m))}</span>
            </div>
          </div>
        );
      })}
      {payload.meta.costs_partial && (
        <p className="tile-note">Spend shares are hidden because some model usage is unpriced.</p>
      )}
    </div>
  );
}
