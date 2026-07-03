import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getUsageMapEvidence, type UsageMapFilters } from "../../api/client";
import type { UsagePhase } from "../../api/types";
import { formatTokens, formatUsd } from "../formatting";
import type { MapNode } from "./forceModel";
import LoadingBar from "../../components/LoadingBar";

interface Props {
  node: MapNode;
  phases: UsagePhase[];
  filters: UsageMapFilters;
  costAvailable: boolean;
  /** Optional: previous-period share per phase key (compare mode). */
  previousShares?: Record<string, number>;
}

/**
 * Floating card over the graph: the rule that fired plus exact totals for the
 * selected node. Deliberately no session list — the map stays the focus.
 */
export default function EvidencePanel({
  node, phases, filters, costAvailable, previousShares,
}: Props) {
  // Habit node ids carry their home phase ("habit:<key>@<phase>") and the API
  // accepts that form directly. Hooks must run unconditionally; grouped
  // overflow leaves and the center node simply disable the fetch.
  const query = useQuery({
    queryKey: ["usage-map-evidence", node.id, filters.projectId ?? null,
               filters.dateFrom ?? null, filters.dateTo ?? null],
    queryFn: () => getUsageMapEvidence(node.id, filters),
    enabled: node.kind !== "center" && !node.grouped,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  if (node.kind === "center") return null;

  const cardClass = ["mindmap-evidence", `is-${node.kind}`,
    node.polarity ? `is-${node.polarity}` : ""].filter(Boolean).join(" ");

  if (node.grouped) {
    return (
      <aside className={cardClass}>
        <h3><i aria-hidden="true" />{node.label}</h3>
        <ul className="mindmap-evidence-grouped">
          {node.grouped.map((leaf) => (
            <li key={leaf.key}>
              {leaf.label} — {costAvailable ? formatUsd(leaf.cost_usd) : `${leaf.count}x`}
            </li>
          ))}
        </ul>
      </aside>
    );
  }
  if (query.isPending) {
    return <aside className={cardClass}><div className="mindmap-evidence-rule"><LoadingBar caption="Loading evidence…" /></div></aside>;
  }
  if (query.isError || !query.data) {
    return <aside className={`${cardClass} panel-error`}><p className="mindmap-evidence-rule">Evidence could not be loaded.</p></aside>;
  }

  const { label, rule, cost_usd } = query.data;
  const phase = phases.find((p) => p.key === node.phaseKey);
  const habit = node.habitKey
    ? phase?.habits.find((h) => h.key === node.habitKey) : undefined;
  const tool = node.toolKey
    ? phase?.tools.find((t) => t.key === node.toolKey) : undefined;
  const previous = node.kind === "phase" && node.phaseKey
    ? previousShares?.[node.phaseKey] : undefined;

  return (
    <aside className={cardClass}>
      <h3><i aria-hidden="true" />{label}</h3>
      <p className="mindmap-evidence-rule">{rule}</p>
      <div className="mindmap-evidence-bar">
        <i style={{ width: `${Math.max(3, node.share * 100)}%` }} />
      </div>
      <div className="mindmap-evidence-row">
        <span>Share of spend</span><b>{Math.round(node.share * 100)}%</b>
      </div>
      {previous !== undefined && (
        <div className="mindmap-evidence-row">
          <span>Previous period</span><b>{Math.round(previous * 100)}%</b>
        </div>
      )}
      {costAvailable ? (
        <div className="mindmap-evidence-row"><span>Cost</span><b>{formatUsd(cost_usd)}</b></div>
      ) : node.kind === "phase" && phase ? (
        <div className="mindmap-evidence-row"><span>Tokens</span><b>{formatTokens(phase.tokens)}</b></div>
      ) : node.kind === "tool" && tool ? (
        <div className="mindmap-evidence-row"><span>Tokens</span><b>{formatTokens(tool.tokens)}</b></div>
      ) : null}
      {node.kind === "phase" && phase && (
        <>
          <div className="mindmap-evidence-row"><span>Tool calls</span><b>{phase.tool_count}</b></div>
          <div className="mindmap-evidence-row"><span>Sessions</span><b>{phase.session_count}</b></div>
        </>
      )}
      {node.kind === "habit" && habit && (
        <>
          <div className="mindmap-evidence-row"><span>Occurrences</span><b>{habit.count}</b></div>
          <div className="mindmap-evidence-row"><span>Sessions</span><b>{habit.session_count}</b></div>
        </>
      )}
      {node.kind === "tool" && tool && (
        <>
          <div className="mindmap-evidence-row"><span>Calls</span><b>{tool.count}</b></div>
          <div className="mindmap-evidence-row"><span>Sessions</span><b>{tool.session_count}</b></div>
        </>
      )}
    </aside>
  );
}
