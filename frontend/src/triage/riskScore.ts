import type { SessionCard } from "../api/types";

// Tunable weights — one place to adjust how signals combine into the rank.
export const RISK_WEIGHTS = {
  alerts: 3,
  loops: 2,
  fanout: 1.5,
  cost: 1,
  patterns: 2,
} as const;

export const COST_SCALES = {
  events: 800,
  durationSeconds: 60 * 60,
  tokens: 120_000,
} as const;

// Soft-normalize an unbounded count into 0..1 so one huge session can't dominate.
function norm(value: number, scale: number): number {
  if (value <= 0) return 0;
  return value / (value + scale);
}

export interface RiskComponent {
  key: keyof typeof RISK_WEIGHTS;
  label: string;
  value: number; // weighted contribution
}

export function riskBreakdown(s: SessionCard): RiskComponent[] {
  const alerts = norm(s.error_count + s.system_count, 10);
  const loops = norm(s.loop_count * Math.max(s.max_repeat, 1), 15);
  const fanout = norm(s.subagent_count + s.max_agent_events / 50, 8);
  const cost = Math.max(
    norm(s.event_count, COST_SCALES.events),
    norm(s.duration_seconds, COST_SCALES.durationSeconds),
    norm(s.input_tokens + s.output_tokens, COST_SCALES.tokens),
  );
  const patterns = norm(s.pattern_risk_score, 8);
  return [
    { key: "alerts", label: "Alerts", value: alerts * RISK_WEIGHTS.alerts },
    { key: "loops", label: "Loops", value: loops * RISK_WEIGHTS.loops },
    { key: "fanout", label: "Fanout", value: fanout * RISK_WEIGHTS.fanout },
    { key: "cost", label: "Size/cost", value: cost * RISK_WEIGHTS.cost },
    { key: "patterns", label: "Patterns", value: patterns * RISK_WEIGHTS.patterns },
  ];
}

export function riskScore(s: SessionCard): number {
  return riskBreakdown(s).reduce((sum, part) => sum + part.value, 0);
}
