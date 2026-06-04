import type { SessionCard } from "../api/types";

interface Props {
  session: SessionCard;
}

// Header insight cards. Reuses the cost page's card chrome for session quality
// signals only.
export default function SessionInsightStrip({ session }: Props) {
  return (
    <div className="cost-insight-strip session-insight-strip" aria-label="Session insights">
      <div className="cost-insight">
        <span>Errors</span>
        <b>{session.error_count.toLocaleString()}</b>
        <small>events flagged</small>
      </div>
      <div className="cost-insight">
        <span>Max loop</span>
        <b>{session.loop_count > 0 ? `x${session.max_repeat}` : "0"}</b>
        <small>repetitions</small>
      </div>
      <div className="cost-insight">
        <span>Risk score</span>
        <b>{session.pattern_risk_score}</b>
        <small>pattern risk</small>
      </div>
    </div>
  );
}
