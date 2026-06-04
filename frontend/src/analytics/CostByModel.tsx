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

const shortLabel = (name: string): string => (name.length > 12 ? `${name.slice(0, 12)}...` : name);

export default function CostByModel({ payload, colors, available }: Props) {
  if (!available) return <div className="empty-state">Cost estimate unavailable - no price table loaded.</div>;
  const rows = chartModels(payload.by_model);
  if (rows.length === 0) return <div className="empty-state">No models in range.</div>;
  const max = Math.max(...rows.map((m) => m.usd), 0);

  return (
    <div className="cbm">
      {rows.map((m) => {
        const spendPct = modelSpendSharePct(m, payload);
        const tokenPct = modelTokenSharePct(m, payload);
        return (
          <div className="cbm-row" key={m.model}>
            <div className="cbm-label" title={m.model}>{shortLabel(displayModelName(m.model))}</div>
            <div className="cbm-bars">
              <div className="cbm-track" title={`${spendPct}% spend share`}>
                <i style={{ width: max > 0 ? `${(m.usd / max) * 100}%` : "0%", background: colors[m.model] ?? FALLBACK_COLOR }} />
              </div>
              <div className="cbm-token-track" title={`${tokenPct}% token share`}>
                <i style={{ width: `${tokenPct}%` }} />
              </div>
            </div>
            <div className="cbm-val">
              <b>{formatUsd(m.usd)}</b>
              <span>{formatTokens(m.tokens)} tok</span>
              <span>{formatUsdPerMillion(effectiveUsdPerMillion(m))}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
