import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getContextEconomics } from "../../api/client";
import type { ContextArchetype, ContextFinding, Project } from "../../api/types";
import TaxMeterHero from "./TaxMeterHero";
import ArchetypeCard from "./ArchetypeCard";
import SessionDrilldown from "./SessionDrilldown";

interface Props {
  projects: Project[];
  onOpenSession: (sessionId: number) => void;
}

const SUPPORT_OPTIONS = [1, 3, 5, 10];

export function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k tok`;
  return `${value} tok`;
}

export default function ContextEconomics({ projects, onOpenSession }: Props) {
  const [projectId, setProjectId] = React.useState<number | null>(null);
  const [minSupport, setMinSupport] = React.useState(3);
  const [drilldown, setDrilldown] = React.useState<{ sessionId: number; title: string; eventId: number | null } | null>(null);
  const query = useQuery({
    queryKey: ["context-economics", projectId, minSupport],
    queryFn: () => getContextEconomics({ projectId, minSupport }),
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return <div className="empty-state">Analyzing context economics…</div>;
  }
  if (query.isError || !query.data) {
    return <div className="empty-state">Context economics failed to load.</div>;
  }
  const { meta, archetypes } = query.data;
  if (meta.sessions_analyzed === 0) {
    return <div className="empty-state">No imported sessions with usage data available.</div>;
  }

  return (
    <div className="context-economics">
      <div className="discover-filter-row">
        <label>
          Project
          <select
            value={projectId ?? ""}
            onChange={(event) => setProjectId(event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.display_name}</option>
            ))}
          </select>
        </label>
        <label>
          Min findings
          <select value={minSupport} onChange={(event) => setMinSupport(Number(event.target.value))}>
            {SUPPORT_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
      </div>

      {!meta.cost_available && (
        <div className="empty-state">Price table unavailable — showing token counts only.</div>
      )}

      <TaxMeterHero meta={meta} archetypes={archetypes} />

      <div className="archetype-grid">
        {archetypes.map((archetype: ContextArchetype) => (
          <ArchetypeCard
            key={archetype.key}
            archetype={archetype}
            minSupport={meta.min_support}
            costAvailable={meta.cost_available}
            onOpenSession={onOpenSession}
            onInspectFinding={(finding: ContextFinding) => setDrilldown({
              sessionId: finding.session_id,
              title: finding.session_title ?? "Untitled session",
              eventId: finding.event_id,
            })}
          />
        ))}
      </div>
      {drilldown && (
        <SessionDrilldown
          sessionId={drilldown.sessionId}
          sessionTitle={drilldown.title}
          highlightEventId={drilldown.eventId}
          onOpenSession={onOpenSession}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}
