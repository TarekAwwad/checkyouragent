import React from "react";
import { useQuery } from "@tanstack/react-query";
import { FileJson, ImageDown } from "lucide-react";
import { getUsageMap, type UsageMapFilters } from "../../api/client";
import type { Project } from "../../api/types";
import EvidencePanel from "./EvidencePanel";
import { exportJson, exportPng } from "./exportMap";
import { phaseNode, deriveOriginPhases, type LeafMode, type MapNode, type OriginFilter } from "./forceModel";
import MindmapCanvas from "./MindmapCanvas";
import LoadingBar from "../../components/LoadingBar";

interface Props {
  projects: Project[];
  /** Part of the shared TechniqueProps contract; unused since the evidence
      card no longer links into sessions. */
  onOpenSession?: (sessionId: number, eventId?: number | null) => void;
}

export default function UsageMindmap({ projects }: Props) {
  const [projectId, setProjectId] = React.useState<number | null>(null);
  const [dateFrom, setDateFrom] = React.useState("");
  const [dateTo, setDateTo] = React.useState("");
  const [selectedNode, setSelectedNode] = React.useState<MapNode | null>(null);
  const [compare, setCompare] = React.useState(false);
  const [leafMode, setLeafMode] = React.useState<LeafMode>("habits");
  const [origin, setOrigin] = React.useState<OriginFilter>("all");
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
  const previousShares: Record<string, number> | undefined =
    compareEnabled && previousQuery.data
      ? Object.fromEntries(previousQuery.data.phases.map((p) => [p.key, p.share]))
      : undefined;

  if (query.isPending) {
    return (
      <main className="discover-page"><div className="discover-page-inner">
        <div className="loading-view"><LoadingBar caption="Building your usage map…" /></div>
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

  const basis = meta.share_basis;
  const { phases: displayedPhases, total: displayedTotal } =
    deriveOriginPhases(phases, origin, basis);
  const splitEmpty = origin !== "all" && displayedTotal === 0;

  // Default selection: the costliest phase, so the evidence card is never empty.
  const fallbackNode = ((): MapNode | null => {
    const top = [...displayedPhases].sort((a, b) => b.share - a.share)[0];
    if (!top || top.share === 0) return null;
    return phaseNode(top);
  })();
  const activeNode = selectedNode ?? fallbackNode;

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
            <div className="segmented-control" role="group" aria-label="Leaf lens">
              {(["habits", "tools"] as const).map((mode) => (
                <button key={mode} type="button"
                        aria-pressed={leafMode === mode}
                        className={leafMode === mode ? "active" : ""}
                        onClick={() => {
                          setLeafMode(mode);
                          // A habit node cannot stay selected in tool mode (and
                          // vice versa); fall back to the costliest phase.
                          setSelectedNode(null);
                        }}>
                  {mode === "habits" ? "Habits" : "Tools"}
                </button>
              ))}
            </div>
            <div className="segmented-control" role="group" aria-label="Origin">
              {(["all", "main", "subagent"] as const).map((o) => (
                <button key={o} type="button"
                        aria-pressed={origin === o}
                        className={origin === o ? "active" : ""}
                        onClick={() => { setOrigin(o); setSelectedNode(null); }}>
                  {o === "all" ? "All" : o === "main" ? "Main" : "Subagents"}
                </button>
              ))}
            </div>
            <button type="button" className="ghost-action"
                    onClick={() => exportJson(query.data!)}>
              <FileJson size={14} />
              <span>Export JSON</span>
            </button>
            <button type="button" className="ghost-action" onClick={() => {
              const svg = boardRef.current?.querySelector("svg");
              if (!svg) return;
              const rect = svg.getBoundingClientRect();
              exportPng(svg, rect.width || 960, rect.height || 560);
            }}>
              <ImageDown size={14} />
              <span>Export PNG</span>
            </button>
          </div>
        </div>

        {!meta.cost_available && (
          <p className="tile-note">Price table unavailable — shares are token-based.</p>
        )}
        {meta.costs_partial && (
          <p className="tile-note">Some models have no price row — costs are partial.</p>
        )}

        <div className="mindmap-stage" ref={boardRef}>
          {splitEmpty ? (
            <div className="empty-state">
              No {origin === "main" ? "main-thread" : "subagent"} spend in this window.
            </div>
          ) : (
            <>
              <MindmapCanvas
                phases={displayedPhases}
                totalUsd={displayedTotal}
                costAvailable={basis === "cost"}
                selectedNodeId={activeNode?.id ?? null}
                onSelectNode={setSelectedNode}
                previousShares={origin === "all" ? previousShares : undefined}
                leafMode={leafMode}
              />
              {activeNode && (
                <EvidencePanel
                  node={activeNode}
                  phases={phases}
                  filters={filters}
                  costAvailable={meta.cost_available}
                  previousShares={origin === "all" ? previousShares : undefined}
                />
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
