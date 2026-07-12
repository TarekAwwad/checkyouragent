import React from "react";
import type { LimitEraEntry } from "../../api/types";
import { formatUsd } from "./LimitHits";

const STRIP_W = 360;

// Per era: usage-at-hit dots, the min-max band, and a median marker, plus the
// percentile insight (a cap is a percentile of your windows, not a quota).
export default function CapZones({ eras }: { eras: LimitEraEntry[] }) {
  const zoned = eras.filter((e) => e.usage_at_hit_usd.length > 0);
  if (zoned.length === 0) {
    return (
      <div className="empty-state">
        No session-limit hits, so no measured cap zone. That is headroom.
      </div>
    );
  }
  const max = Math.max(1e-9, ...zoned.map((e) => e.cap_max_usd ?? 0));
  const px = (v: number) => Math.min(STRIP_W - 4, (v / max) * (STRIP_W - 8) + 4);
  return (
    <div className="limit-zones">
      {zoned.map((era) => (
        <div key={era.era || "all"} className="limit-zone-row">
          <div className="limit-zone-head">
            <strong>{era.era || "All usage"}</strong>
            <span>
              {era.session_hit_count} session hits, median {formatUsd(era.cap_median_usd)},{" "}
              {era.near_miss_count} near-misses
              {era.cap_percentile != null
                ? `, cap at p${Math.round(era.cap_percentile * 100)} of windows`
                : ""}
            </span>
          </div>
          <svg viewBox={`0 0 ${STRIP_W} 24`} preserveAspectRatio="none"
               className="limit-zone-strip" role="img"
               aria-label={`${era.era || "All usage"} cap zone`}>
            <rect x={0} y={10} width={STRIP_W} height={4} rx={2} className="lane-track" />
            {era.cap_min_usd != null && era.cap_max_usd != null && (
              <rect x={px(era.cap_min_usd)} y={8}
                    width={Math.max(2, px(era.cap_max_usd) - px(era.cap_min_usd))}
                    height={8} className="limit-zone-band" />
            )}
            {era.usage_at_hit_usd.map((v, i) => (
              <circle key={i} cx={px(v)} cy={12} r={4} className="limit-zone-dot" />
            ))}
            {era.cap_median_usd != null && (
              <rect x={px(era.cap_median_usd) - 1} y={4} width={2} height={16}
                    className="limit-zone-median" />
            )}
          </svg>
        </div>
      ))}
    </div>
  );
}
