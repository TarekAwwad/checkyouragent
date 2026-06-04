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
  const cacheDeltaLabel = cache.net_savings_usd >= 0 ? "saved" : "penalty";

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
          <span>Actual input</span>
          <b>{formatUsd(cache.observed_input_usd)}</b>
        </div>
        <div>
          <span>No-cache input</span>
          <b>{formatUsd(cache.no_cache_input_usd)}</b>
        </div>
        <div className={cache.net_savings_usd >= 0 ? "positive" : "negative"}>
          <span>Cache {cacheDeltaLabel}</span>
          <b>{formatUsd(Math.abs(cache.net_savings_usd))}</b>
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
