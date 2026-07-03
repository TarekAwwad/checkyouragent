import type { ReactNode } from "react";

interface Props {
  size?: "panel" | "tile" | "inline";
  label?: string;
  caption?: ReactNode;
}

/**
 * The app's one loading indicator: a rounded track that reuses the risk-bar's
 * colours (`--err → --loop → --fan → --accent → --info`). Motion adapts to size —
 * wide bars (panel/tile) sweep a gradient band across; the small inline bar fills
 * and resets. Pass `caption` to show muted text under the bar (panel loaders).
 */
export default function LoadingBar({ size = "panel", label, caption }: Props) {
  const name = label ?? (typeof caption === "string" ? caption : "Loading…");
  const bar = <span className={`loading-bar ${size}`} role="status" aria-label={name} />;
  if (caption === undefined) return bar;
  return (
    <span className="loading-bar-block">
      {bar}
      <small className="loading-bar-caption">{caption}</small>
    </span>
  );
}
