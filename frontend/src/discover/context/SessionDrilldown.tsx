import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { getSessionContextEconomics } from "../../api/client";
import type { ContextFinding } from "../../api/types";
import { counterfactualSeries } from "./streamGeometry";
import { formatTokens, formatUsd } from "./ContextEconomics";
import ContextStream from "./ContextStream";
import BallastLanes from "./BallastLanes";

export default function SessionDrilldown({
  sessionId,
  sessionTitle,
  finding,
  onOpenSession,
  onClose,
}: {
  sessionId: number;
  sessionTitle: string;
  finding: ContextFinding | null;
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
  /** Omit when the investigator is a permanent board panel. */
  onClose?: () => void;
}) {
  const highlightEventId = finding?.event_id ?? null;
  const [hoverId, setHoverId] = React.useState<string | null>(null);
  const query = useQuery({
    queryKey: ["session-context-economics", sessionId],
    queryFn: () => getSessionContextEconomics(sessionId),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const renderBody = () => {
    if (query.isPending) {
      return <div className="empty-state" style={{ minHeight: 120 }}>Loading session economics…</div>;
    }
    if (query.isError) {
      return <div className="empty-state" style={{ minHeight: 120 }}>Failed to load session economics.</div>;
    }
    const costAvailable = query.data?.cost_available ?? false;
    const mainThread = query.data?.threads.find((thread) => thread.agent_id === null)
      ?? query.data?.threads[0];
    if (!mainThread) {
      return <div className="empty-state" style={{ minHeight: 120 }}>No usage data for this session.</div>;
    }
    const counterfactual = finding ? counterfactualSeries(mainThread, finding) : null;
    return (
      <>
        {finding && (
          <p className="drilldown-inspecting">
            <span className="drilldown-inspecting-label" title={finding.label}>{finding.label}</span>
            <strong>
              saves {costAvailable ? formatUsd(finding.savings_usd) : formatTokens(finding.savings_tokens)}
            </strong>
          </p>
        )}
        <ContextStream
          thread={mainThread}
          highlightEventId={highlightEventId}
          counterfactual={counterfactual}
          costAvailable={costAvailable}
          hoverId={hoverId}
          onHover={setHoverId}
        />
        <BallastLanes
          thread={mainThread}
          highlightEventId={highlightEventId}
          costAvailable={costAvailable}
          hoverId={hoverId}
          onHover={setHoverId}
        />
      </>
    );
  };

  return (
    <section className="session-drilldown">
      <header className="session-drilldown-header">
        <h3 className="session-drilldown-title">{sessionTitle}</h3>
        <div className="session-drilldown-actions">
          <button
            type="button"
            className="ghost-action"
            onClick={() => onOpenSession(sessionId, highlightEventId)}
          >
            <ExternalLink size={13} aria-hidden={true} />
            Open session
          </button>
          {onClose && (
            <button type="button" className="ghost-action" onClick={onClose} aria-label="Close drill-down">
              <X size={14} aria-hidden={true} />
            </button>
          )}
        </div>
      </header>
      <div className="session-drilldown-body">
        {renderBody()}
      </div>
    </section>
  );
}
