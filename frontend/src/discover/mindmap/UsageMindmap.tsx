import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getUsageMap, type UsageMapFilters } from "../../api/client";
import type { Project } from "../../api/types";
import EvidencePanel from "./EvidencePanel";
import { exportJson, exportPng } from "./exportMap";
import type { MapNode } from "./mapGeometry";
import { MAP_HEIGHT, MAP_WIDTH } from "./mapGeometry";
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
  const [compare, setCompare] = React.useState(false);
  const boardRef = React.useRef<HTMLDivElement>(null);

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

  // Previous window of equal length, ending the day before dateFrom.
  const previousWindow = React.useMemo(() => {
    if (!dateFrom || !dateTo) return null;
    const from = new Date(`${dateFrom}T00:00:00Z`);
    const to = new Date(`${dateTo}T00:00:00Z`);
    const spanMs = to.getTime() - from.getTime();
    if (Number.isNaN(spanMs) || spanMs < 0) return null;
    const dayMs = 24 * 60 * 60 * 1000;
    const prevTo = new Date(from.getTime() - dayMs);
    const prevFrom = new Date(prevTo.getTime() - spanMs);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    return { dateFrom: iso(prevFrom), dateTo: iso(prevTo) };
  }, [dateFrom, dateTo]);

  const compareEnabled = compare && previousWindow !== null;
  const previousQuery = useQuery({
    queryKey: ["usage-map-prev", projectId, previousWindow?.dateFrom ?? null,
               previousWindow?.dateTo ?? null],
    queryFn: () => getUsageMap({ projectId, ...previousWindow! }),
    enabled: compareEnabled,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const previousShares = compareEnabled && previousQuery.data
    ? Object.fromEntries(previousQuery.data.phases.map((p) => [p.key, p.share]))
    : undefined;

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
            <label className="mindmap-compare-toggle">
              <input type="checkbox" aria-label="Compare with previous period"
                     checked={compare} disabled={!previousWindow}
                     onChange={(e) => setCompare(e.target.checked)} />
              vs previous period
            </label>
            <button type="button" onClick={() => exportJson(query.data!)}>Export JSON</button>
            <button type="button" onClick={() => {
              const svg = boardRef.current?.querySelector("svg");
              if (svg) exportPng(svg, MAP_WIDTH, MAP_HEIGHT);
            }}>Export PNG</button>
          </div>
        </div>

        {!meta.cost_available && (
          <p className="tile-note">Price table unavailable — shares are token-based.</p>
        )}
        {meta.costs_partial && (
          <p className="tile-note">Some models have no price row — costs are partial.</p>
        )}

        <div className="mindmap-board" ref={boardRef}>
          <MindmapCanvas
            phases={phases}
            totalUsd={meta.total_usd}
            costAvailable={meta.cost_available}
            selectedNodeId={activeNode?.id ?? null}
            onSelectNode={setSelectedNode}
            previousShares={previousShares}
          />
          <div className="mindmap-side">
            <ShareRail
              phases={phases}
              selectedPhaseKey={activeNode?.kind === "phase" ? activeNode.phaseKey ?? null : null}
              onSelect={selectPhaseFromRail}
              previousShares={previousShares}
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
