import React from "react";
import { useQuery } from "@tanstack/react-query";
import { FileJson, ImageDown } from "lucide-react";
import { getUsageMap, type UsageMapFilters } from "../../api/client";
import EvidencePanel from "./EvidencePanel";
import { exportJson, exportPng } from "./exportMap";
import { phaseNode, deriveOriginPhases, type LeafMode, type MapNode, type OriginFilter } from "./forceModel";
import MindmapCanvas from "./MindmapCanvas";
import LoadingBar from "../../components/LoadingBar";
import PageHeader from "../../shell/PageHeader";
import SegmentedControl, { type SegmentOption } from "../../components/controls/SegmentedControl";
import ToggleChip from "../../components/controls/ToggleChip";
import ExportMenu from "../../components/controls/ExportMenu";
import { useAnalysisScope } from "../../shell/analysisScope";
import { instantBounds, previousRange } from "../../shell/dateRange";

interface Props {
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
}

const ORIGIN_OPTIONS: SegmentOption<OriginFilter>[] = [
  { value: "all", label: "All" },
  { value: "main", label: "Main" },
  { value: "subagent", label: "Subagents" },
];

const LENS_OPTIONS: SegmentOption<LeafMode>[] = [
  { value: "habits", label: "Patterns" },
  { value: "tools", label: "Tools" },
];

export default function UsageMindmap({ onOpenSession }: Props) {
  const { resolvedRange, projectId } = useAnalysisScope();
  const [selectedNode, setSelectedNode] = React.useState<MapNode | null>(null);
  const [compare, setCompare] = React.useState(false);
  const [leafMode, setLeafMode] = React.useState<LeafMode>("habits");
  const [origin, setOrigin] = React.useState<OriginFilter>("all");
  const boardRef = React.useRef<HTMLDivElement>(null);

  const { from, to } = resolvedRange;
  const bounds = React.useMemo(() => instantBounds({ from, to }), [from, to]);
  const previous = React.useMemo(() => previousRange({ from, to }), [from, to]);
  const previousBounds = React.useMemo(() => (previous ? instantBounds(previous) : null), [previous]);

  // A selection from the previous filter window may not exist in the new data;
  // fall back to the most active phase instead of highlighting a phantom node.
  React.useEffect(() => {
    setSelectedNode(null);
  }, [projectId, bounds]);

  const filters: UsageMapFilters = { projectId, dateFrom: bounds.dateFrom, dateTo: bounds.dateTo };
  const query = useQuery({
    queryKey: ["usage-map", projectId, bounds.dateFrom, bounds.dateTo],
    queryFn: () => getUsageMap(filters),
    placeholderData: (prior) => prior,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const compareEnabled = compare && previousBounds !== null;
  const previousQuery = useQuery({
    queryKey: ["usage-map-prev", projectId, previousBounds?.dateFrom ?? null, previousBounds?.dateTo ?? null],
    queryFn: () => getUsageMap({
      projectId, dateFrom: previousBounds!.dateFrom, dateTo: previousBounds!.dateTo,
    }),
    enabled: compareEnabled,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const previousShares: Record<string, number> | undefined =
    compareEnabled && previousQuery.data
      ? Object.fromEntries(previousQuery.data.phases.map((p) => [p.key, p.activity_share]))
      : undefined;

  const data = query.data;
  const ready = !query.isPending && !query.isError && data !== undefined && data.meta.sessions_analyzed > 0;
  const exportBoardPng = () => {
    const svg = boardRef.current?.querySelector("svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    exportPng(svg, rect.width || 960, rect.height || 560);
  };

  const header = (
    <PageHeader
      section="Explore"
      title="Activity map"
      subtitle="Tool calls and assistant steps by phase."
      status={query.isFetching && !query.isPending ? "Updating…" : null}
      actions={(
        <ExportMenu
          disabled={!ready}
          items={[
            {
              label: "Export JSON",
              icon: <FileJson size={14} aria-hidden="true" />,
              onSelect: () => { if (data) exportJson(data); },
            },
            { label: "Export PNG", icon: <ImageDown size={14} aria-hidden="true" />, onSelect: exportBoardPng },
          ]}
        />
      )}
      scope={{ date: "filter", project: "filter" }}
      filters={(
        <SegmentedControl label="Origin" options={ORIGIN_OPTIONS} value={origin}
                          onChange={(next) => { setOrigin(next); setSelectedNode(null); }} />
      )}
      view={(
        <>
          <SegmentedControl label="Leaf lens" options={LENS_OPTIONS} value={leafMode}
                            onChange={(next) => {
                              setLeafMode(next);
                              // A habit node cannot stay selected in tool mode (and
                              // vice versa); fall back to the most active phase.
                              setSelectedNode(null);
                            }} />
          <ToggleChip label="vs previous period" ariaLabel="Compare with previous period"
                      checked={compare && previous !== null} disabled={previous === null} onChange={setCompare} />
        </>
      )}
    />
  );

  let body: React.ReactNode;
  if (query.isPending) {
    body = <div className="loading-view"><LoadingBar caption="Building the activity map…" /></div>;
  } else if (query.isError || !data) {
    body = (
      <div className="empty-state panel-error">
        <strong>Failed to load</strong>
        <span>The activity map could not be loaded.</span>
      </div>
    );
  } else if (data.meta.sessions_analyzed === 0) {
    body = (
      <div className="empty-state">
        No imported sessions in this window — adjust the filters or import an export first.
      </div>
    );
  } else {
    const { meta, phases } = data;
    const { phases: displayedPhases, total: displayedTotal } = deriveOriginPhases(phases, origin);
    const splitEmpty = origin !== "all" && displayedTotal === 0;
    // Default selection: the most active phase, so the evidence card is never empty.
    const top = [...displayedPhases].sort((a, b) => b.activity_share - a.activity_share)[0];
    const fallbackNode = top && top.activity_share > 0 ? phaseNode(top) : null;
    const activeNode = selectedNode ?? fallbackNode;
    body = (
      <div className="mindmap-stage" ref={boardRef}>
        {splitEmpty ? (
          <div className="empty-state">
            No {origin === "main" ? "main-thread" : "subagent"} activity in this window.
          </div>
        ) : (
          <>
            <MindmapCanvas
              phases={displayedPhases}
              totalActivity={displayedTotal}
              selectedNodeId={activeNode?.id ?? null}
              onSelectNode={setSelectedNode}
              previousShares={origin === "all" ? previousShares : undefined}
              leafMode={leafMode}
            />
            {activeNode && (
              <EvidencePanel
                key={activeNode.id}
                node={activeNode}
                phases={phases}
                filters={filters}
                costAvailable={meta.cost_available}
                onOpenSession={onOpenSession}
                previousShares={origin === "all" ? previousShares : undefined}
              />
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        {header}
        {body}
      </div>
    </main>
  );
}
