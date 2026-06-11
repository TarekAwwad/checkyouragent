import React from "react";

interface TipState {
  x: number;
  y: number;
  hostWidth: number;
  title: string;
  lines: string[];
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

  const show = React.useCallback((event: React.MouseEvent, title: string, lines: string[]) => {
    const host = ref.current?.getBoundingClientRect();
    if (!host) return;
    setTip({
      x: event.clientX - host.left,
      y: event.clientY - host.top,
      hostWidth: host.width,
      title,
      lines,
    });
  }, []);

  const hide = React.useCallback(() => setTip(null), []);

  // Flip to the left of the cursor in the right 40% of the host so the tooltip
  // never clips at the container edge.
  const flipped = tip !== null && tip.x > tip.hostWidth * 0.6;
  const tooltip = tip && (
    <div
      className={`chart-tooltip${flipped ? " is-flipped" : ""}`}
      style={{ left: tip.x, top: tip.y }}
      role="presentation"
    >
      <strong>{tip.title}</strong>
      {tip.lines.map((line) => <span key={line}>{line}</span>)}
    </div>
  );

  return { ref, show, hide, tooltip };
}
