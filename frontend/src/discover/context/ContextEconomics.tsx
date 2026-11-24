import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getContextEconomics } from "../../api/client";
import type { ContextArchetype, ContextFinding } from "../../api/types";
import TaxMeterHero from "./TaxMeterHero";
import ArchetypeBrief from "./ArchetypeBrief";
import FindingsPanel from "./FindingsPanel";
import SessionDrilldown from "./SessionDrilldown";
import LoadingBar from "../../components/LoadingBar";
import PageHeader from "../../shell/PageHeader";
import { useAnalysisScope } from "../../shell/analysisScope";

interface Props {
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
}

export { formatUsd, formatTokens } from "../formatting";

export function findingKey(finding: ContextFinding): string {
  return `${finding.session_id}:${finding.entry_turn}:${finding.label}`;
}

export default function ContextEconomics({ onOpenSession }: Props) {
  const { projectId } = useAnalysisScope();
  // Hierarchy: archetype (kind of opportunity, tabs) → finding (which session/event,
  // list) → investigator (the evidence). Both selections fall back to the
  // first available entry so the board always shows evidence.
  const [archetypeKey, setArchetypeKey] = React.useState<string | null>(null);
  const [selectedFindingKey, setSelectedFindingKey] = React.useState<string | null>(null);
  const query = useQuery({
    queryKey: ["context-economics", projectId],
    queryFn: () => getContextEconomics({ projectId }),
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const selectArchetype = (key: string) => {
    setArchetypeKey(key);
    setSelectedFindingKey(null);
  };

  let body: React.ReactNode;
  if (query.isPending) {
    body = <div className="loading-view"><LoadingBar caption="Analyzing context economics…" /></div>;
  } else if (query.isError || !query.data) {
    body = (
      <div className="empty-state panel-error">
        <strong>Failed to load</strong>
        <span>Context economics could not be loaded.</span>
      </div>
    );
  } else if (query.data.meta.sessions_analyzed === 0) {
    body = <div className="empty-state">No imported sessions with usage data available.</div>;
  } else {
    const { meta, archetypes } = query.data;
    const supported = archetypes.filter((a: ContextArchetype) => a.meets_support);
    const activeArchetype = supported.find((a) => a.key === archetypeKey) ?? supported[0] ?? null;
    const findings = activeArchetype?.findings ?? [];
    const activeFinding = findings.find((f) => findingKey(f) === selectedFindingKey)
      ?? findings[0]
      ?? null;
    body = (
      <>
        {meta.costs_partial ? (
          <p className="tile-note">
            Pricing is partial — dollar estimates exclude unpriced models: {meta.unpriced_models.join(", ")}.
            Percentage breakdowns are hidden.
          </p>
        ) : !meta.cost_available ? (
          <p className="tile-note">
            Price table unavailable — estimated context opportunity is shown in tokens only.
          </p>
        ) : null}

        <TaxMeterHero
          meta={meta}
          archetypes={archetypes}
          selectedKey={activeArchetype?.key ?? null}
          onSelectArchetype={selectArchetype}
        />

        {activeArchetype ? (
          <div className="context-board">
            <div className="context-side">
              <ArchetypeBrief
                archetype={activeArchetype}
                costAvailable={meta.cost_available}
                costsPartial={meta.costs_partial}
              />
              <FindingsPanel
                archetype={activeArchetype}
                costAvailable={meta.cost_available}
                costsPartial={meta.costs_partial}
                activeFindingKey={activeFinding ? findingKey(activeFinding) : null}
                onSelectFinding={(finding) => setSelectedFindingKey(findingKey(finding))}
              />
            </div>
            {activeFinding && (
              <div className="archetype-detail">
                <SessionDrilldown
                  sessionId={activeFinding.session_id}
                  sessionTitle={activeFinding.session_title ?? "Untitled session"}
                  finding={activeFinding}
                  onOpenSession={onOpenSession}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state">
            No supported context opportunities were detected for this selection.
          </div>
        )}
      </>
    );
  }

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <PageHeader
          section="Explore"
          title="Context economics"
          experimental
          subtitle="Estimated context opportunity by kind."
          status={query.isFetching && !query.isPending ? "Updating…" : null}
          scope={{ date: "fixed", project: "filter" }}
        />
        {body}
      </div>
    </main>
  );
}
