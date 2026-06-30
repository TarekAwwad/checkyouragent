// frontend/src/analytics/SessionCostList.tsx
import type { CostAnalyticsResponse } from "../api/types";
import { formatUsd } from "./chartGeometry";
import { Blurred } from "../shell/Blurred";

interface Props {
  payload: CostAnalyticsResponse;
  onOpenSession: (sessionId: number) => void;
  available: boolean;
}

export default function SessionCostList({ payload, onOpenSession, available }: Props) {
  if (!available) {
    return <div className="empty-state">Cost estimate unavailable — no price table loaded.</div>;
  }
  if (payload.sessions.length === 0) {
    return <div className="empty-state">No sessions in range.</div>;
  }
  return (
    <ul className="session-cost-list">
      {payload.sessions.slice(0, 12).map((s) => (
        <li key={s.id}>
          <button onClick={() => onOpenSession(s.id)}>
            <span className="scl-title"><Blurred>{s.title || s.session_id}</Blurred></span>
            <span className="scl-project"><Blurred>{s.project_name}</Blurred></span>
            <b>{formatUsd(s.usd)}</b>
          </button>
        </li>
      ))}
    </ul>
  );
}
