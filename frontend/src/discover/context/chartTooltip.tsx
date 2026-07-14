import React from "react";
import { Blurred } from "../../shell/Blurred";

interface TipState {
  x: number;
  y: number;
  hostWidth: number;
  hostHeight: number;
  title: string;
  lines: string[];
  blur: boolean;
}

/**
 * Cursor-following tooltip for the hand-rolled SVG charts. The host element
 * (attach `ref` and the `chart-tooltip-host` class) must be position:relative;
 * call `show` from mouse-move handlers and `hide` on leave. Replaces native
 * SVG <title> tooltips, which are slow to appear and unstyled.
 */
export function useChartTooltip<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [tip, setTip] = React.useState<TipState | null>(null);

  // Pass { blur: true } when the title is content-derived (file paths, tool
  // labels) so privacy mode blurs it; category titles stay readable by default.
  const show = React.useCallback((
    event: React.MouseEvent,
    title: string,
    lines: string[],
    options?: { blur?: boolean },
  ) => {
    const host = ref.current?.getBoundingClientRect();
    if (!host) return;
    setTip({
      x: event.clientX - host.left,
      y: event.clientY - host.top,
      hostWidth: host.width,
      hostHeight: host.height,
      title,
      lines,
      blur: options?.blur ?? false,
    });
  }, []);

  const hide = React.useCallback(() => setTip(null), []);

  // Flip to the left of the cursor in the right 40% of the host, and above it
  // in the bottom 40%, so the tooltip never clips at the container edge.
  const flipped = tip !== null && tip.x > tip.hostWidth * 0.6;
  const flippedY = tip !== null && tip.y > tip.hostHeight * 0.6;
  const tooltip = tip && (
    <div
      className={`chart-tooltip${flipped ? " is-flipped" : ""}${flippedY ? " is-flipped-y" : ""}`}
      style={{ left: tip.x, top: tip.y }}
      role="presentation"
    >
      <strong>{tip.blur ? <Blurred>{tip.title}</Blurred> : tip.title}</strong>
      {tip.lines.map((line) => <span key={line}>{line}</span>)}
    </div>
  );

  return { ref, show, hide, tooltip };
}
