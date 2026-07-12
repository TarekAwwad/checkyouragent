import React from "react";
import type { LimitWindowEntry } from "../../api/types";

const BAR_W = 6;
const GAP = 2;
const HEIGHT = 150;
const LABEL_H = 14;

// One bar per reconstructed 5-hour window, uniform spacing. Hits are marked by
// color; era changes get a background band with the plan label. The chart lives
// inside a horizontally scrolling container so the page never scrolls sideways.
export default function WindowsTimeline({ windows, selected, onSelectWindow }: {
  windows: LimitWindowEntry[];
  selected: number | null;
  onSelectWindow: (index: number) => void;
}) {
  if (windows.length === 0) {
    return <div className="empty-state">No usage found, so no windows to show.</div>;
  }
  const max = Math.max(1e-9, ...windows.map((w) => w.value_usd));
  const x = (i: number) => GAP + i * (BAR_W + GAP);
  const width = x(windows.length) + GAP;

  const bands: { era: string; from: number; to: number }[] = [];
  windows.forEach((w, i) => {
    const last = bands[bands.length - 1];
    if (last && last.era === w.era) last.to = i;
    else bands.push({ era: w.era, from: i, to: i });
  });

  return (
    <div className="limit-timeline-scroll">
      <svg width={Math.max(width, 320)} height={HEIGHT}
           role="img" aria-label="5-hour windows timeline">
        {bands.map((b, bi) => (
          <g key={`${b.era}-${b.from}`}>
            <rect x={x(b.from) - GAP / 2} y={0}
                  width={x(b.to) + BAR_W + GAP / 2 - x(b.from) + GAP / 2}
                  height={HEIGHT}
                  className={bi % 2 ? "limit-era-band alt" : "limit-era-band"} />
            {b.era && (
              <text x={x(b.from) + 2} y={LABEL_H - 3} className="limit-era-label">
                {b.era}
              </text>
            )}
          </g>
        ))}
        {windows.map((w, i) => {
          const h = Math.max(2, (w.value_usd / max) * (HEIGHT - LABEL_H - 6));
          const hit = w.hit_kinds.length > 0;
          const cls = [
            "limit-bar",
            hit ? "limit-bar-hit" : "",
            selected === i ? "limit-bar-selected" : "",
          ].join(" ").trim();
          const day = w.start.slice(0, 10);
          return (
            <rect key={w.start} x={x(i)} y={HEIGHT - h} width={BAR_W} height={h}
                  className={cls} role="button" tabIndex={0}
                  aria-label={`window ${i + 1}: ${day}, $${w.value_usd.toFixed(2)}${hit ? `, ${w.hit_kinds.join(" and ")} hit` : ""}`}
                  onClick={() => onSelectWindow(i)}
                  onKeyDown={(e) => e.key === "Enter" && onSelectWindow(i)}>
              <title>{`${day} · $${w.value_usd.toFixed(2)}${hit ? ` · ${w.hit_kinds.join(", ")} hit` : ""}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
