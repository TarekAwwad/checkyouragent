import type { CostAnalyticsResponse } from "../api/types";
import {
  chartModels,
  displayModelName,
  formatSignedUsd,
  formatUsd,
  largestSpike,
  topModelSpendSharePct,
  turnDistributionSummary,
} from "./chartGeometry";

interface Props {
  payload: CostAnalyticsResponse;
}

export default function InsightStrip({ payload }: Props) {
  const cache = payload.cache_economics;
  const spike = largestSpike(payload);
  const turnSummary = turnDistributionSummary(payload.sessions);
  const topModel = [...chartModels(payload.by_model)].sort((a, b) => b.usd - a.usd)[0];
  const topShare = topModelSpendSharePct(payload);
  const cacheLabel = !payload.meta.available
    ? "Cache pricing"
    : cache.net_savings_usd > 0
      ? "Cache saved"
      : cache.net_savings_usd < 0
        ? "Cache penalty"
        : "Cache neutral";

  return (
    <div className="cost-insight-strip" aria-label="Cost insights">
      <div className="cost-insight">
        <span>{cacheLabel}</span>
        <b>{payload.meta.available ? formatUsd(Math.abs(cache.net_savings_usd)) : "Unavailable"}</b>
        <small>
          {!payload.meta.available
            ? "price table missing"
            : cache.cache_read_tokens > 0
              ? "vs uncached input"
              : "no cache reuse"}
        </small>
      </div>
      <div className="cost-insight">
        <span>Largest spike</span>
        <b>{spike ? `${spike.bucket} ${formatSignedUsd(spike.delta_usd)}` : "None"}</b>
        <small>{spike ? `${formatUsd(spike.total_usd)} total` : "no positive jump"}</small>
      </div>
      <div className="cost-insight">
        <span>Outside target</span>
        <b>{turnSummary.attentionCount}</b>
        <small>{turnSummary.total > 0 ? `of ${turnSummary.total} sessions` : "no turn data"}</small>
      </div>
      <div className="cost-insight">
        <span>Top model</span>
        <b>{topModel ? `${topShare}%` : "None"}</b>
        <small>{topModel ? `${displayModelName(topModel.model)} spend share` : "no model spend"}</small>
      </div>
    </div>
  );
}
