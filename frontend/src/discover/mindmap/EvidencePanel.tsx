import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getUsageMapEvidence, type UsageMapFilters } from "../../api/client";
import { formatUsd } from "../formatting";
import type { MapNode } from "./mapGeometry";

interface Props {
  node: MapNode;
  filters: UsageMapFilters;
  costAvailable: boolean;
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
}

/** Receipts for the selected node: the rule that fired and the sessions behind it. */
export default function EvidencePanel({ node, filters, costAvailable, onOpenSession }: Props) {
  // Map node id to the API node id: habit nodes are "habit:<key>@<phase>" on
  // the canvas but "habit:<key>" in the API contract.
  const apiNode = node.kind === "habit" && node.habitKey
    ? `habit:${node.habitKey}`
    : node.id;
  // Hooks must run unconditionally (no early returns above this line); grouped
  // overflow leaves and the center node simply disable the fetch.
  const query = useQuery({
    queryKey: ["usage-map-evidence", apiNode, filters],
    queryFn: () => getUsageMapEvidence(apiNode, filters),
    enabled: node.kind !== "center" && !node.grouped,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  // Grouped overflow leaves carry their members locally — no fetch needed.
  if (node.grouped) {
    return (
      <aside className="mindmap-evidence">
        <h3>{node.label}</h3>
        <ul>
          {node.grouped.map((habit) => (
            <li key={habit.key}>
              {habit.label} — {costAvailable ? formatUsd(habit.cost_usd) : `${habit.count}x`}
            </li>
          ))}
        </ul>
      </aside>
    );
  }
  if (node.kind === "center") {
    return <aside className="mindmap-evidence"><p>Select a phase or habit to see its receipts.</p></aside>;
  }
  if (query.isPending) {
    return <aside className="mindmap-evidence"><p>Loading evidence…</p></aside>;
  }
  if (query.isError || !query.data) {
    return <aside className="mindmap-evidence panel-error"><p>Evidence could not be loaded.</p></aside>;
  }
  const { label, rule, cost_usd, sessions } = query.data;
  return (
    <aside className="mindmap-evidence">
      <h3>{label}</h3>
      <p className="mindmap-evidence-rule">{rule}</p>
      {costAvailable && <p className="mindmap-evidence-total">{formatUsd(cost_usd)} total</p>}
      <ul className="mindmap-evidence-sessions">
        {sessions.map((session) => (
          <li key={session.session_id}>
            <button type="button"
                    onClick={() => onOpenSession(session.session_id,
                                                 session.exemplar_event_ids[0] ?? null)}>
              <strong>{session.title}</strong>
              <span>{session.project_name}</span>
              <span>
                {costAvailable ? formatUsd(session.cost_usd) : `${session.count}x`}
                {session.detail ? ` — ${session.detail}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
