import type { CostAnalyticsResponse } from "../api/types";
import { formatSignedUsd, formatUsd, largestSpike } from "./chartGeometry";
import { formatCostPeriod, spikeBaselineDescription } from "./costPeriods";

interface Props {
  payload: CostAnalyticsResponse;
  selectedBucket?: string | null;
  onSelectBucket?: (bucket: string) => void;
}

export default function SpikeInsight({ payload, selectedBucket, onSelectBucket }: Props) {
  const size = payload.meta.bucket;
  const frequency = size === "week" ? "weekly" : "daily";
  const spike = largestSpike(payload);
  const available = payload.meta.available && !payload.meta.costs_partial;

  if (!available || !spike) {
    const comparable = payload.over_time.some((period) => period.baseline_usd !== null);
    return (
      <div className="spike-insight">
        <span className="spike-insight-label">Spend changes</span>
        <strong className="spike-insight-change">
          {!available ? "Spike comparison unavailable" : "No unusual increases"}
        </strong>
        <small className="spike-insight-context">
          {!payload.meta.available
            ? "Price table missing"
            : payload.meta.costs_partial
              ? "Requires complete model pricing"
              : payload.over_time.length === 0
                ? "No spend in range"
                : comparable
                  ? "No evidence-qualified increase in this range"
                  : "Requires at least 3 preceding complete periods"}
        </small>
      </div>
    );
  }

  const period = formatCostPeriod(spike, size);
  const selected = selectedBucket === spike.bucket;
  const caption = `Largest ${frequency} increase`;
  // Percentages against tiny baselines amplify small changes. The absolute
  // dollar increase remains visible for every qualified spike.
  const percentage = spike.baseline_usd >= 1 && spike.delta_pct !== null && Number.isFinite(spike.delta_pct)
    ? ` · +${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(spike.delta_pct)}%`
    : "";
  const content = (
    <>
      <span className="spike-insight-label">{caption}</span>
      <strong className="spike-insight-change">{formatSignedUsd(spike.delta_usd)} above typical {frequency} spend</strong>
      <small className="spike-insight-context">
        {period} · {formatUsd(spike.total_usd)} total · {spike.baseline_usd === 0 ? "Increased from $0" : `${formatUsd(spike.baseline_usd)} baseline`}
      </small>
      <small className="spike-insight-baseline">{spikeBaselineDescription(spike, size)}{percentage}</small>
      {onSelectBucket && <small className="spike-insight-action">{selected ? "Hide contributor sessions" : "Inspect contributor sessions"}</small>}
    </>
  );

  return onSelectBucket ? (
    <button
      type="button"
      className="spike-insight has-spike"
      aria-pressed={selected}
      aria-label={`${selected ? "Hide" : "Show"} largest ${frequency} increase sessions for ${period}`}
      onClick={() => onSelectBucket(spike.bucket)}
    >
      {content}
    </button>
  ) : <div className="spike-insight has-spike">{content}</div>;
}
