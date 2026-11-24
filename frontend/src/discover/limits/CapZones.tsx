import React from "react";
import type { LimitEraEntry } from "../../api/types";
import {
  eraDateRange,
  eraHitLevel,
  eraName,
  formatHitRate,
  formatLimitTick,
  formatLimitValue,
  type LimitBasis,
} from "./limitMath";
import { useChartTooltip } from "../context/chartTooltip";

const FALLBACK_W = 560;
const STRIP_H = 26;
const PAD = 10; // keeps edge dots inside the strip

function edgeShift(index: number, count: number): string {
  if (index === 0) return "translateX(0)";
  if (index === count - 1) return "translateX(-100%)";
  return "translateX(-50%)";
}

// A row shows what a reader scans for, hits and rate; everything else about
// the period (median, range, how many windows, the percentile) waits for the
// hover. The glossary defines each part.
function eraStats(era: LimitEraEntry): string {
  const hits = era.session_hit_count;
  return `${hits} hit${hits === 1 ? "" : "s"} · ${formatHitRate(era, true)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function eraDetails(era: LimitEraEntry, basis: LimitBasis): string[] {
  const hitLevel = eraHitLevel(era, basis);
  const weeks = era.weeks.toFixed(1) === "1.0" ? "1 week" : `${era.weeks.toFixed(1)} weeks`;
  return [
    ...(hitLevel.median != null ? [`median ${formatLimitValue(hitLevel.median, basis)}`] : []),
    ...(hitLevel.min != null && hitLevel.max != null
      ? [`range ${formatLimitValue(hitLevel.min, basis)}–${formatLimitValue(hitLevel.max, basis)}`]
      : []),
    `${plural(era.window_count, "window")} in ${weeks}`,
    ...(hitLevel.percentile != null
      ? [`${Math.round(hitLevel.percentile * 100)}% of windows at or below the median`]
      : []),
  ];
}

// Per plan period (an era): usage-at-hit dots, the min-max band, and a median
// marker. Hovering the row's figures shows its details; a dot shows that hit.
// Rendered in measured pixel space so markers keep their shape at any width;
// all eras share one scale for the selected basis and the axis at the bottom.
export default function CapZones({ eras, basis }: {
  eras: LimitEraEntry[];
  basis: LimitBasis;
}) {
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

  const zoned = eras.filter((e) => eraHitLevel(e, basis).values.length > 0);
  if (zoned.length === 0) {
    return <div className="empty-state">No session-limit hits.</div>;
  }
  const max = Math.max(0, ...zoned.map((e) => eraHitLevel(e, basis).max ?? 0));
  const scaleMax = Math.max(1e-9, max);
  const px = (v: number) => PAD + (v / scaleMax) * (width - 2 * PAD);
  // Hits measured at zero usage (a pool filled elsewhere, or no price table)
  // leave max at 0, where the three ticks would land on top of each other.
  const ticks = max > 0 ? [0, max / 2, max] : [0];

  return (
    <div className="limit-zones chart-tooltip-host" ref={ref}>
      {eras.map((era) => {
        const hitLevel = eraHitLevel(era, basis);
        const hasStrip = hitLevel.values.length > 0;
        // A period without hits still gets a line once there are periods to
        // compare: "no hits in 15 weeks" is the finding, not an absence of one.
        const quiet = !hasStrip && eras.length > 1 && era.session_hit_count === 0;
        if (!hasStrip && !quiet) return null;
        const name = eraName(era, eras.length);
        // Dates only matter once there is more than one period to tell apart.
        const dates = eras.length > 1 ? eraDateRange(era) : null;
        const label = dates ? `${name} (${dates})` : name;
        const details = eraDetails(era, basis);
        const title = dates ? `${name} · ${dates}` : name;
        return (
        <div key={`${era.era}-${era.start_date ?? "start"}`} className="limit-zone-row">
          <div className="limit-zone-head">
            <strong>
              {name}
              {dates && <span className="limit-zone-dates"> · {dates}</span>}
            </strong>
            <span className="limit-zone-stats"
                  onMouseMove={(e) => show(e, title, details)} onMouseLeave={hide}>
              {eraStats(era)}
            </span>
          </div>
          {/* A quiet period keeps an empty lane on the shared scale, so the
              axis below never reads as belonging to a row without a strip. */}
          <svg width={width} height={STRIP_H} className="limit-zone-strip" role="img"
               aria-label={`${label}: ${[
                 quiet ? "no hits" : eraStats(era).replace(" · ", ", "),
                 ...details,
               ].join(", ")}`}>
            {ticks.map((t) => (
              <line key={t} className="limit-zone-grid"
                    x1={px(t)} y1={3} x2={px(t)} y2={STRIP_H - 3} />
            ))}
            <rect x={PAD} y={STRIP_H / 2 - 2} width={Math.max(0, width - 2 * PAD)}
                  height={4} rx={2} className="lane-track" />
            {hitLevel.min != null && hitLevel.max != null && (
              <rect x={px(hitLevel.min)} y={STRIP_H / 2 - 5}
                    width={Math.max(2, px(hitLevel.max) - px(hitLevel.min))}
                    height={10} rx={5} className="limit-zone-band" />
            )}
            {hitLevel.values.map((v, i) => (
              <circle key={i} cx={px(v)} cy={STRIP_H / 2} r={5}
                      className="limit-zone-dot"
                      onMouseMove={(e) => show(e, formatLimitValue(v, basis), ["usage at hit"])}
                      onMouseLeave={hide} />
            ))}
            {hitLevel.median != null && (
              <rect x={px(hitLevel.median) - 1} y={2} width={2} height={STRIP_H - 4}
                    className="limit-zone-median" />
            )}
          </svg>
        </div>
        );
      })}
      <div className="limit-zone-axis" aria-hidden={true}>
        {ticks.map((t, i) => (
          // Edge labels anchor inward: a token label ("49.7M tok") is wide
          // enough to leave the strip if it stays centred on its tick.
          <span key={t} style={{ left: px(t), transform: edgeShift(i, ticks.length) }}>
            {formatLimitTick(t, basis)}
          </span>
        ))}
      </div>
      <div className="chip-legend card-bottom-legend limit-legend">
        <span><i className="is-hit-dot" />usage at hit</span>
        <span><i className="is-band" />range</span>
        <span><i className="is-median" />median</span>
      </div>
      {tooltip}
    </div>
  );
}
