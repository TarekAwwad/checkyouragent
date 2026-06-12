import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getUsageMap, type UsageMapFilters } from "../../api/client";
import type { Project } from "../../api/types";
import EvidencePanel from "./EvidencePanel";
import type { MapNode } from "./mapGeometry";
import MindmapCanvas from "./MindmapCanvas";
import ShareRail from "./ShareRail";

interface Props {
  projects: Project[];
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
}

export default function UsageMindmap({ projects, onOpenSession }: Props) {
  const [projectId, setProjectId] = React.useState<number | null>(null);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [selectedNode, setSelectedNode] = React.useState<MapNode | null>(null);

  // A selection from the previous filter window may not exist in the new data;
  // fall back to the costliest phase instead of highlighting a phantom node.
  React.useEffect(() => {
    setSelectedNode(null);
  }, [projectId, dateFrom, dateTo]);

  const filters: UsageMapFilters = {
    projectId,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
  };
  const query = useQuery({
    queryKey: ["usage-map", projectId, dateFrom, dateTo],
    queryFn: () => getUsageMap(filters),
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  if (query.isPending) {
    return (
      <main className="discover-page"><div className="discover-page-inner">
        <div className="empty-state">Building your usage map…</div>
      </div></main>
    );
  }
  if (query.isError || !query.data) {
    return (
      <main className="discover-page"><div className="discover-page-inner">
        <div className="empty-state panel-error">
          <strong>Failed to load</strong>
          <span>The usage map could not be loaded.</span>
        </div>
      </div></main>
    );
  }
  const { meta, phases } = query.data;
  if (meta.sessions_analyzed === 0) {
    return (
      <main className="discover-page"><div className="discover-page-inner">
        <div className="empty-state">No imported sessions in this window — adjust the filters or import an export first.</div>
      </div></main>
    );
  }

  // Default selection: the costliest phase, so the evidence panel is never empty.
  const fallbackNode = ((): MapNode | null => {
    const top = [...phases].sort((a, b) => b.share - a.share)[0];
    if (!top || top.share === 0) return null;
    return { id: `phase:${top.key}`, kind: "phase", label: top.label,
             sublabel: "", x: 0, y: 0, rx: 0, ry: 0, share: top.share,
             phaseKey: top.key };
  })();
  const activeNode = selectedNode ?? fallbackNode;

  const selectPhaseFromRail = (phaseKey: string) => {
    const phase = phases.find((p) => p.key === phaseKey);
    if (!phase) return;
    setSelectedNode({ id: `phase:${phaseKey}`, kind: "phase", label: phase.label,
                      sublabel: "", x: 0, y: 0, rx: 0, ry: 0, share: phase.share,
                      phaseKey });
  };

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <div className="discover-toolbar" aria-label="Usage map controls">
          <div className="cost-filterbar discover-filterbar">
            <select aria-label="Project" value={projectId ?? ""}
                    onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.display_name}</option>
              ))}
            </select>
            <input aria-label="From date" type="date" value={dateFrom}
                   onChange={(e) => setDateFrom(e.target.value)} />
            <input aria-label="To date" type="date" value={dateTo}
                   onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>

        {!meta.cost_available && (
          <p className="tile-note">Price table unavailable — shares are token-based.</p>
        )}
        {meta.costs_partial && (
          <p className="tile-note">Some models have no price row — costs are partial.</p>
        )}

        <div className="mindmap-board">
          <MindmapCanvas
            phases={phases}
            totalUsd={meta.total_usd}
            costAvailable={meta.cost_available}
            selectedNodeId={activeNode?.id ?? null}
            onSelectNode={setSelectedNode}
          />
          <div className="mindmap-side">
            <ShareRail
              phases={phases}
              selectedPhaseKey={activeNode?.kind === "phase" ? activeNode.phaseKey ?? null : null}
              onSelect={selectPhaseFromRail}
            />
            {activeNode && (
              <EvidencePanel
                node={activeNode}
                filters={filters}
                costAvailable={meta.cost_available}
                onOpenSession={onOpenSession}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
