import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowLeftRight } from "lucide-react";
import PageHeader from "../shell/PageHeader";
import SearchField from "../components/controls/SearchField";
import { getEvent, getSession, getSessionFindings, getSubagents, getTimeline, getToolActivity, getTrace, search } from "../api/client";
import { Blurred } from "../shell/Blurred";
import type { SessionCard } from "../api/types";
import TimelinePanel from "../timeline/TimelinePanel";
import InspectorPanel from "../inspector/InspectorPanel";
import TraceView from "../trace/TraceView";
import { buildSameToolStreakContextMap } from "../trace/sameToolStreak";
import SessionInsightStrip from "../session/SessionInsightStrip";
import ToolUsageTile from "../session/ToolUsageTile";
import SubagentHeatTile from "../session/SubagentHeatTile";
import { buildSubagentHeat } from "../session/sessionAnalytics";
import LoadingBar from "../components/LoadingBar";

interface Props {
  session: SessionCard;
  /** Event to select on entry (deep-link from analytics views); null = default. */
  initialEventId?: number | null;
  /** Where the session was opened from, shown before its title. */
  section?: string;
  /** Label for the origin-aware navigation control, for example "Back to Cost". */
  backLabel?: string;
  onBack?: () => void;
  historical?: boolean;
}

function SessionWorkspace({ session, initialEventId = null, section, backLabel, onBack, historical = true }: Props) {
  const workspaceRef = React.useRef<HTMLElement | null>(null);
  const [selectedEventId, setSelectedEventId] = React.useState<number | null>(initialEventId);
  const [query, setQuery] = React.useState("");

  const sessionQuery = useQuery({ queryKey: ["session", session.id], queryFn: () => getSession(session.id), initialData: session });
  const timeline = useQuery({ queryKey: ["timeline", session.id], queryFn: () => getTimeline(session.id) });
  const trace = useQuery({ queryKey: ["trace", session.id], queryFn: () => getTrace(session.id) });
  const subagents = useQuery({
    queryKey: ["subagents", session.id, historical],
    queryFn: () => getSubagents(session.id, historical),
  });
  const toolActivity = useQuery({
    queryKey: ["tool-activity", session.id],
    queryFn: () => getToolActivity(session.id),
  });
  const findings = useQuery({ queryKey: ["findings", session.id], queryFn: () => getSessionFindings(session.id) });
  const selectedEvent = useQuery({
    queryKey: ["event", selectedEventId],
    queryFn: () => getEvent(selectedEventId as number),
    enabled: selectedEventId !== null,
  });
  const searchResults = useQuery({
    queryKey: ["search", session.id, query],
    queryFn: () => search(query, session.id),
    enabled: query.trim().length > 1,
  });
  const timelineItems = React.useMemo(() => timeline.data ?? [], [timeline.data]);
  const spans = React.useMemo(() => trace.data?.spans ?? [], [trace.data?.spans]);
  const subagentList = React.useMemo(() => subagents.data ?? [], [subagents.data]);
  const sameToolStreakContexts = React.useMemo(
    () => buildSameToolStreakContextMap(spans),
    [spans],
  );
  const subagentLabels = React.useMemo(() => {
    const model = buildSubagentHeat(subagentList);
    return new Map(model.cells.map((cell) => [
      cell.agentId,
      `${cell.label} · ${cell.agentType || cell.name || "Subagent"}`,
    ]));
  }, [subagentList]);
  const subagentFirstEventIds = React.useMemo(() => {
    const ids = new Map<string, number>();
    for (const item of timelineItems) {
      if (item.kind !== "subagent_event" || !item.agent_id || ids.has(item.agent_id)) continue;
      ids.set(item.agent_id, item.event_id);
    }
    return ids;
  }, [timelineItems]);

  const card = sessionQuery.data;
  // Primary model for the meta line: the first model seen on a trace span.
  const primaryModel = React.useMemo(() => {
    for (const span of spans) {
      if (span.model) return span.model;
    }
    return null;
  }, [spans]);
  const metaParts = [
    card.cwd,
    [card.version, primaryModel ? `(${primaryModel})` : null].filter(Boolean).join(" ") || null,
    card.entrypoint,
  ].filter(Boolean);

  const inspectSubagent = React.useCallback((agentId: string) => {
    const eventId = subagentFirstEventIds.get(agentId);
    if (!eventId) return;
    setSelectedEventId(eventId);
    window.requestAnimationFrame(() => {
      workspaceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [subagentFirstEventIds]);

  React.useEffect(() => {
    setSelectedEventId(initialEventId);
  }, [session.id, initialEventId]);

  React.useEffect(() => {
    if (!selectedEventId && timelineItems.length) {
      setSelectedEventId(timelineItems[0].event_id);
    }
  }, [selectedEventId, timelineItems]);

  const selectedTimestamp = React.useMemo(
    () => timelineItems.find((item) => item.event_id === selectedEventId)?.timestamp ?? null,
    [selectedEventId, timelineItems],
  );

  return (
    <main className="cost-page session-page">
      <div className="cost-page-inner session-page-inner">
        <PageHeader
          leading={backLabel && onBack ? (
            <button type="button" className="ghost-action" onClick={onBack} aria-label={backLabel}>
              <ArrowLeft size={15} />
              <span>{backLabel}</span>
            </button>
          ) : undefined}
          section={section}
          title={<Blurred>{card.title || card.session_id}</Blurred>}
          subtitle={(
            <Blurred>
              {[`${card.project_name}${card.git_branch ? ` / ${card.git_branch}` : ""}`, ...metaParts].join(" · ")}
            </Blurred>
          )}
          filters={(
            <div className="session-search-wrap">
              <SearchField value={query} onChange={setQuery} placeholder="Search inside session" />
              {searchResults.data && query && (
                <div className="search-popover">
                  {searchResults.data.slice(0, 8).map((result) => (
                    <button key={`${result.kind}-${result.ref_id}`} onClick={() => result.kind === "message" && setSelectedEventId(result.ref_id)}>
                      <strong><Blurred>{result.title || result.kind}</Blurred></strong>
                      <span><Blurred>{result.preview}</Blurred></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        />
        <SessionInsightStrip
          session={card}
          costUsd={trace.data?.cost.usd}
          costAvailable={trace.data?.cost.available}
        />

        <section className="session-overview" aria-label="Session overview">
            <div className="cost-bento session-summary-grid">
              <SubagentHeatTile
                subagents={subagentList}
                firstEventIds={subagentFirstEventIds}
                onSelectSubagent={inspectSubagent}
                loading={subagents.isLoading}
              />
              <ToolUsageTile activity={toolActivity.data ?? []} loading={toolActivity.isLoading} />
            </div>
        </section>

        <section ref={workspaceRef} className="cost-bento session-workspace" aria-label="Session workspace">
            <section className="tile tile-full session-trace-tile">
              <div className="session-tile-heading">
                <h2>Trace</h2>
                <span className="hint"><ArrowLeftRight size={13} /> spacing · lanes · same-tool streaks</span>
              </div>
              <div className="session-trace-body event-graph">
                {trace.isLoading ? (
                  <div className="empty-state"><LoadingBar caption="Loading session trace…" /></div>
                ) : trace.isError || !trace.data ? (
                  <div className="empty-state">Could not load the session trace.</div>
                ) : (
                  <TraceView
                    trace={trace.data}
                    selectedEventId={selectedEventId}
                    playheadTimestamp={selectedTimestamp}
                    subagentLabels={subagentLabels}
                    onSelect={setSelectedEventId}
                  />
                )}
              </div>
            </section>
            <TimelinePanel
              items={timelineItems}
              selectedEventId={selectedEventId}
              sameToolStreakContexts={sameToolStreakContexts}
              onSelect={setSelectedEventId}
            />
            <InspectorPanel
              session={card}
              event={selectedEvent.data}
              sameToolStreakContext={selectedEventId !== null ? sameToolStreakContexts.get(selectedEventId) : undefined}
              subagents={subagentList}
              findings={findings.data ?? []}
              loading={selectedEvent.isLoading || subagents.isLoading || findings.isLoading}
              onSelectEvent={setSelectedEventId}
            />
        </section>
      </div>
    </main>
  );
}

export default SessionWorkspace;
