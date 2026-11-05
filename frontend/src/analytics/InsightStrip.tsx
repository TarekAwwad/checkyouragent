import type { CostAnalyticsResponse } from "../api/types";
import {
  chartModels,
  displayModelName,
  formatTokens,
  formatUsd,
  topModelSpendSharePct,
} from "./chartGeometry";
import SpikeInsight from "./SpikeInsight";

interface Props {
  payload: CostAnalyticsResponse;
  selectedSpikeBucket?: string | null;
  onSelectSpike?: (bucket: string) => void;
}

export default function InsightStrip({ payload, selectedSpikeBucket = null, onSelectSpike }: Props) {
  const cache = payload.cache_economics;
  const partial = payload.meta.costs_partial;
  const topModel = [...chartModels(payload.by_model)].sort((a, b) => b.usd - a.usd)[0];
  const topShare = topModelSpendSharePct(payload);
  const cacheLabel = partial
    ? "Cache comparison unavailable"
    : !payload.meta.available
    ? "Cache pricing unavailable"
    : cache.net_savings_usd > 0
      ? "Estimated API-equivalent cache savings"
      : cache.net_savings_usd < 0
        ? "Estimated API-equivalent cache penalty"
        : "Estimated API-equivalent cache difference";

  return (
    <div className="cost-insight-strip" aria-label="Cost insights">
      <div className="cost-insight">
        <span>{cacheLabel}</span>
        <b>{partial ? "Partial pricing" : payload.meta.available ? formatUsd(Math.abs(cache.net_savings_usd)) : "Unavailable"}</b>
        <small>
          {partial
            ? `excludes ${payload.meta.unpriced_models.map(displayModelName).join(", ")}`
            : !payload.meta.available
            ? "price table missing"
            : cache.cache_read_tokens > 0
              ? `${formatTokens(cache.cache_read_tokens)} reused vs uncached input`
              : "no cache reuse"}
        </small>
      </div>
      <div className="cost-insight">
        <SpikeInsight payload={payload} selectedBucket={selectedSpikeBucket} onSelectBucket={onSelectSpike} />
      </div>
      <div className="cost-insight">
        <span>{partial ? "Model share unavailable" : "Top model"}</span>
        <b>{partial ? "Partial pricing" : topModel ? `${topShare}%` : "None"}</b>
        <small>
          {topModel
            ? partial
              ? `${displayModelName(topModel.model)} leads priced spend only`
              : `${displayModelName(topModel.model)} spend share`
            : "no model spend"}
        </small>
      </div>
    </div>
  );
}
