import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { getSessionContextEconomics } from "../../api/client";
import ContextStream from "./ContextStream";
import BallastLanes from "./BallastLanes";

export default function SessionDrilldown({
  sessionId,
  sessionTitle,
  highlightEventId,
  onOpenSession,
  onClose,
}: {
  sessionId: number;
  sessionTitle: string;
  highlightEventId: number | null;
  onOpenSession: (sessionId: number) => void;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["session-context-economics", sessionId],
    queryFn: () => getSessionContextEconomics(sessionId),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  if (query.isPending) return <div className="empty-state">Loading session economics…</div>;
  const mainThread = query.data?.threads.find((thread) => thread.agent_id === null)
    ?? query.data?.threads[0];
  if (!mainThread) return <div className="empty-state">No usage data for this session.</div>;

  return (
    <section className="session-drilldown">
      <header>
        <h3>{sessionTitle}</h3>
        <div>
          <button type="button" onClick={() => onOpenSession(sessionId)}>
            <ExternalLink size={13} aria-hidden={true} /> Open session
          </button>
          <button type="button" onClick={onClose} aria-label="Close drill-down">
            <X size={14} aria-hidden={true} />
          </button>
        </div>
      </header>
      <ContextStream thread={mainThread} highlightEventId={highlightEventId} />
      <BallastLanes
        thread={mainThread}
        highlightEventId={highlightEventId}
        costAvailable={query.data?.cost_available ?? false}
      />
    </section>
  );
}
