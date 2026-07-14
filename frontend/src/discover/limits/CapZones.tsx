import React from "react";
import type { LimitEraEntry } from "../../api/types";
import { formatBlocked, formatUsd, meanUsageAtHit } from "./limitMath";
import { useChartTooltip } from "../context/chartTooltip";

const FALLBACK_W = 560;
const STRIP_H = 26;
const PAD = 10; // keeps edge dots inside the strip

// The per-plan metrics live here (one row per era, not one card per era, so
// any number of plans scales). Only the parts an era actually has are shown.
function eraSummary(era: LimitEraEntry): string {
  const hits = era.session_hit_count;
  const avg = meanUsageAtHit(era);
  const parts = [`${hits} session hit${hits === 1 ? "" : "s"}`];
  if (era.cap_median_usd != null) parts.push(`median ${formatUsd(era.cap_median_usd)}`);
  if (avg != null) parts.push(`avg ${formatUsd(avg)}`);
  if (era.blocked_minutes > 0) parts.push(`${formatBlocked(era.blocked_minutes)} blocked`);
  parts.push(`${era.near_miss_count} near-miss${era.near_miss_count === 1 ? "" : "es"}`);
  if (era.cap_percentile != null) {
    parts.push(`cap at p${Math.round(era.cap_percentile * 100)} of windows`);
  }
  return parts.join(", ");
}

// Per era: usage-at-hit dots, the min-max band, and a median marker, plus the
// percentile insight (a cap is a percentile of your windows, not a quota).
// Rendered in measured pixel space so markers keep their shape at any width;
// all eras share one dollar scale and the axis at the bottom.
export default function CapZones({ eras }: { eras: LimitEraEntry[] }) {
  const { ref, show, hide, tooltip } = useChartTooltip<HTMLDivElement>();
  const [width, setWidth] = React.useState(FALLBACK_W);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = (next: number) => {
      const rounded = Math.max(280, Math.round(next));
      setWidth((current) => (current === rounded ? current : rounded));
    };
    if (node.clientWidth) update(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) update(entries[0].contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  const zoned = eras.filter((e) => e.usage_at_hit_usd.length > 0 || e.blocked_minutes > 0);
  if (zoned.length === 0) {
    return (
      <div className="empty-state">
        No session-limit hits, so no measured cap zone. That is headroom.
      </div>
    );
  }
  const max = Math.max(1e-9, ...zoned.map((e) => e.cap_max_usd ?? 0));
  const px = (v: number) => PAD + (v / max) * (width - 2 * PAD);
  const ticks = [0, max / 2, max];

  return (
    <div className="limit-zones chart-tooltip-host" ref={ref}>
      {zoned.map((era) => {
        const avg = meanUsageAtHit(era);
        return (
        <div key={era.era || "all"} className="limit-zone-row">
          <div className="limit-zone-head">
            <strong>{era.era || "All usage"}</strong>
            <span>{eraSummary(era)}</span>
          </div>
          <svg width={width} height={STRIP_H} className="limit-zone-strip" role="img"
               aria-label={`${era.era || "All usage"} cap zone`}>
            {ticks.map((t) => (
              <line key={t} className="limit-zone-grid"
                    x1={px(t)} y1={3} x2={px(t)} y2={STRIP_H - 3} />
            ))}
            <rect x={PAD} y={STRIP_H / 2 - 2} width={Math.max(0, width - 2 * PAD)}
                  height={4} rx={2} className="lane-track" />
            {era.cap_min_usd != null && era.cap_max_usd != null && (
              <rect x={px(era.cap_min_usd)} y={STRIP_H / 2 - 5}
                    width={Math.max(2, px(era.cap_max_usd) - px(era.cap_min_usd))}
                    height={10} rx={5} className="limit-zone-band" />
            )}
            {era.usage_at_hit_usd.map((v, i) => (
              <circle key={i} cx={px(v)} cy={STRIP_H / 2} r={5}
                      className="limit-zone-dot"
                      onMouseMove={(e) => show(e, formatUsd(v), ["window usage when the cap hit"])}
                      onMouseLeave={hide} />
            ))}
            {era.cap_median_usd != null && (
              <rect x={px(era.cap_median_usd) - 1} y={2} width={2} height={STRIP_H - 4}
                    className="limit-zone-median" />
            )}
            {avg != null && (
              <line x1={px(avg)} y1={2} x2={px(avg)} y2={STRIP_H - 2}
                    className="limit-zone-avg" />
            )}
          </svg>
        </div>
        );
      })}
      <div className="limit-zone-axis" aria-hidden={true}>
        {ticks.map((t) => (
          <span key={t} style={{ left: px(t) }}>{t === 0 ? "$0" : formatUsd(t)}</span>
        ))}
      </div>
      <div className="chip-legend card-bottom-legend limit-legend">
        <span><i className="is-hit-dot" />usage at a session-limit hit</span>
        <span><i className="is-band" />min-max cap zone</span>
        <span><i className="is-median" />median cap</span>
        <span><i className="is-avg" />avg hit</span>
        <em>x-axis: window usage, $ API-equivalent</em>
      </div>
      {tooltip}
    </div>
  );
}
