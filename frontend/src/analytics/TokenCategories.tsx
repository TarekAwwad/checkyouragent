import type { CostAnalyticsResponse } from "../api/types";
import { categoryRows, cacheReadPctOfInput, formatTokens, formatUsd } from "./chartGeometry";

interface Props {
  payload: CostAnalyticsResponse;
}

export default function TokenCategories({ payload }: Props) {
  const rows = categoryRows(payload.categories);
  if (rows.length === 0) return <div className="empty-state">No token usage in range.</div>;
  const cachePct = cacheReadPctOfInput(payload.categories);
  const cache = payload.cache_economics;
  const partial = payload.meta.costs_partial;
  const cacheDeltaLabel = cache.net_savings_usd >= 0
    ? "Estimated API-equivalent cache savings"
    : "Estimated API-equivalent cache penalty";

  return (
    <div className="tcat">
      <div className="tcat-bar">
        {rows.map((r) => (
          <i key={r.key} style={{ width: `${r.pct}%`, background: r.color }} title={`${r.label}: ${formatTokens(r.tokens)}`} />
        ))}
      </div>
      <div className="tcat-rows">
        {rows.map((r) => (
          <div className="tcat-row" key={r.key}>
            <i style={{ background: r.color }} />
            <span className="tcat-label">{r.label}</span>
            <b>{formatTokens(r.tokens)}</b>
            <span className="tcat-pct">{r.pct}%</span>
          </div>
        ))}
      </div>
      <div className="cache-economics">
        <div>
          <span>Estimated observed input cost</span>
          <b>{partial ? `≥${formatUsd(cache.observed_input_usd)}` : formatUsd(cache.observed_input_usd)}</b>
        </div>
        <div>
          <span>Estimated no-cache input cost</span>
          <b>{partial ? `≥${formatUsd(cache.no_cache_input_usd)}` : formatUsd(cache.no_cache_input_usd)}</b>
        </div>
        <div className={!partial && payload.meta.available ? (cache.net_savings_usd > 0 ? "positive" : cache.net_savings_usd < 0 ? "negative" : "") : ""}>
          <span>{partial ? "Cache comparison unavailable" : cacheDeltaLabel}</span>
          <b>{partial ? "Partial pricing" : formatUsd(Math.abs(cache.net_savings_usd))}</b>
        </div>
      </div>
      {cachePct > 0 && (
        <p className="tile-note">
          Cache reads {cachePct}% of input; {formatTokens(cache.cache_read_tokens)} read tokens reused.
        </p>
      )}
    </div>
  );
}
