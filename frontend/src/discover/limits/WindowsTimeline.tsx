import React from "react";
import type { LimitHitEntry, LimitWindowEntry } from "../../api/types";
import { useChartTooltip } from "../context/chartTooltip";
import {
  basisLabel,
  eraRates,
  formatLimitTick,
  formatLimitValue,
  type LimitBasis,
} from "./limitMath";

const BAR_W = 6;
const GAP = 2;
const MAX_SLOT_SCALE = 2.5; // bars may widen up to this much to fill the panel
const PLOT_TOP = 18; // era label strip
const PLOT_H = 210;
const XLABEL_H = 20;
const HEIGHT = PLOT_TOP + PLOT_H + XLABEL_H;
const MIN_XLABEL_GAP = 64; // px between date labels
const FALLBACK_W = 860;
const Y_FRACTIONS = [1, 0.75, 0.5, 0.25, 0];

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// One bar per reconstructed 5-hour window, uniform spacing. Hits are marked by
// color; era changes get a background band with the plan label. Bars widen (to
// a cap) to fill the panel; past that the chart scrolls horizontally inside
// its container so the page never scrolls sideways, and the metric axis stays
// fixed outside the scroller.
export default function WindowsTimeline({ windows, hits, basis, selected, onSelectWindow }: {
  windows: LimitWindowEntry[];
  hits: LimitHitEntry[];
  basis: LimitBasis;
  selected: number | null;
  onSelectWindow: (index: number) => void;
}) {
  const { ref, show, hide, tooltip } = useChartTooltip<HTMLDivElement>();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [hostWidth, setHostWidth] = React.useState(FALLBACK_W);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = (next: number) => {
      const rounded = Math.max(320, Math.round(next));
      setHostWidth((current) => (current === rounded ? current : rounded));
    };
    if (node.clientWidth) update(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) update(entries[0].contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  // Land on the most recent windows; the far past is a scroll away.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [windows.length, hostWidth]);

  if (windows.length === 0) {
    return <div className="empty-state">No usage found, so no windows to show.</div>;
  }
  const metric = (window: LimitWindowEntry) => (
    basis === "cost" ? window.value_usd : window.tokens
  );
  const max = Math.max(0, ...windows.map(metric));
  const scaleMax = Math.max(1e-9, max);
  const needed = GAP + windows.length * (BAR_W + GAP) + GAP;
  const scale = Math.min(MAX_SLOT_SCALE, Math.max(1, hostWidth / needed));
  const barW = BAR_W * scale;
  const gap = GAP * scale;
  const x = (i: number) => gap + i * (barW + gap);
  const width = Math.max(x(windows.length) + gap, hostWidth);
  const yTicks = Y_FRACTIONS.map((f) => ({
    f,
    y: PLOT_TOP + PLOT_H * (1 - f),
    label: formatLimitTick(max * f, basis),
  }));

  const bands: { era: string; from: number; to: number }[] = [];
  windows.forEach((w, i) => {
    const last = bands[bands.length - 1];
    if (last && last.era === w.era) last.to = i;
    else bands.push({ era: w.era, from: i, to: i });
  });
  const hasEras = bands.some((b) => b.era);

  // Average hits per week of each plan's tenure, annotated on its era band.
  // The rate cannot share the dollar axis, so it rides the band label instead
  // of pretending to be a level line.
  const rates = eraRates(windows, hits);

  const labelStep = Math.ceil(MIN_XLABEL_GAP / (barW + gap));
  const xLabelIdx: number[] = [];
  for (let i = 0; i < windows.length; i += labelStep) xLabelIdx.push(i);

  return (
    <>
      <div className="limit-timeline">
        <span className="limit-axis-title-y">
          {basis === "cost" ? "$ per window" : "tokens per window"}
        </span>
        <div className="limit-timeline-yaxis" style={{ height: HEIGHT }} aria-hidden={true}>
          {yTicks.map((t) => (
            <span key={t.f} className="limit-ylabel" style={{ top: t.y }}>{t.label}</span>
          ))}
        </div>
        <div className="limit-timeline-plot chart-tooltip-host" ref={ref}>
          <div className="limit-timeline-scroll" ref={scrollRef}>
            <svg width={width} height={HEIGHT}
                 role="img"
                 aria-label={`5-hour windows timeline by ${basisLabel(basis)}`}>
              {bands.map((b, bi) => (
                <g key={`${b.era}-${b.from}`}>
                  <rect x={x(b.from) - gap / 2} y={0}
                        width={x(b.to) + barW + gap / 2 - x(b.from) + gap / 2}
                        height={PLOT_TOP + PLOT_H}
                        className={bi % 2 ? "limit-era-band alt" : "limit-era-band"} />
                  {b.era && (
                    <text x={x(b.from) + 2} y={12} className="limit-era-label">
                      {b.era}
                    </text>
                  )}
                  {(rates.get(b.era)?.hitCount ?? 0) > 0 && (
                    <text x={x(b.from) + 2} y={b.era ? 24 : 12} className="limit-era-rate">
                      {`${rates.get(b.era)!.perWeek.toFixed(1)} hits/wk`}
                    </text>
                  )}
                </g>
              ))}
              {yTicks.map((t) => (
                <line key={t.f} className="limit-grid"
                      x1={0} y1={t.y} x2={width} y2={t.y} />
              ))}
              {xLabelIdx.map((i) => (
                <text key={windows[i].start}
                      x={i === 0 ? x(i) : x(i) + barW / 2}
                      y={PLOT_TOP + PLOT_H + 13}
                      className="limit-xlabel"
                      textAnchor={i === 0 ? "start" : "middle"}>
                  {dayLabel(windows[i].start)}
                </text>
              ))}
              {windows.map((w, i) => {
                const value = metric(w);
                const formattedValue = formatLimitValue(value, basis);
                const h = Math.max(2, (value / scaleMax) * PLOT_H);
                const hit = w.hit_kinds.length > 0;
                const cls = [
                  "limit-bar",
                  hit ? "limit-bar-hit" : "",
                  selected === i ? "limit-bar-selected" : "",
                ].join(" ").trim();
                return (
                  <rect key={w.start} x={x(i)} y={PLOT_TOP + PLOT_H - h}
                        width={barW} height={h}
                        className={cls} role="button" tabIndex={0}
                        aria-label={`window ${i + 1}: ${w.start.slice(0, 10)}, ${formattedValue}${hit ? `, ${w.hit_kinds.join(" and ")} hit` : ""}`}
                        onClick={() => onSelectWindow(i)}
                        onKeyDown={(e) => e.key === "Enter" && onSelectWindow(i)}
                        onMouseMove={(e) => show(e, dayLabel(w.start), [
                          `${formattedValue} in this window`,
                          ...(hit ? [`${w.hit_kinds.join(", ")} limit hit`] : []),
                          ...(w.era ? [`plan: ${w.era}`] : []),
                        ])}
                        onMouseLeave={hide} />
                );
              })}
            </svg>
          </div>
          {tooltip}
        </div>
      </div>
      <div className="chip-legend card-bottom-legend limit-legend">
        <span><i className="is-window" />window usage</span>
        <span><i className="is-hit" />limit hit</span>
        {hasEras && <span><i className="is-era" />plan era</span>}
        <em>{`y-axis: ${basisLabel(basis)} · x-axis: window start date`}</em>
      </div>
    </>
  );
}
