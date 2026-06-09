import type { SessionCard } from "../api/types";
import { riskScore, riskBreakdown, riskClass, type RiskComponent } from "./riskScore";

// Segments contributing less than this share of total risk are dropped so thin
// slivers don't muddy the bar; the survivors re-proportion to fill it.
const MIN_SHARE = 0.08;

interface Segment {
  key: RiskComponent["key"];
  label: string;
  share: number; // fraction of total risk (for the accessible label)
  grow: number; // re-proportioned width across visible segments
}

function segments(parts: RiskComponent[]): Segment[] {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  if (total <= 0) return [];
  const visible = parts.filter((p) => p.value / total >= MIN_SHARE);
  const visibleTotal = visible.reduce((sum, p) => sum + p.value, 0);
  return visible.map((p) => ({
    key: p.key,
    label: p.label,
    share: p.value / total,
    grow: p.value / visibleTotal,
  }));
}

// The Risk cell: the score (magnitude, colored by severity tier) over a thin
// segmented underline showing what's driving it, drawn from riskBreakdown(). Low-risk
// sessions show a faint flat track instead of segments.
export default function RiskCell({ session }: { session: SessionCard }) {
  const score = riskScore(session);
  const tier = riskClass(score);
  const calm = tier === "g-lo";
  const segs = calm ? [] : segments(riskBreakdown(session));
  const label = calm
    ? "Low risk"
    : segs.map((s) => `${s.label} ${Math.round(s.share * 100)}%`).join(" · ");

  return (
    <div className="risk-cell">
      <span className={`risk-score ${tier}`} data-testid="risk-score">{score.toFixed(1)}</span>
      {calm ? (
        <span className="risk-bar calm" data-testid="risk-bar" aria-label={label} title={label} />
      ) : (
        <span className="risk-bar" data-testid="risk-bar" aria-label={label} title={label}>
          {segs.map((seg) => (
            <span
              key={seg.key}
              data-testid="risk-seg"
              data-key={seg.key}
              className={`risk-seg seg-${seg.key}`}
              style={{ flexGrow: seg.grow }}
            />
          ))}
        </span>
      )}
    </div>
  );
}
