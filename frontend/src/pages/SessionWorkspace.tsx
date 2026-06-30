import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Search } from "lucide-react";
import { getEvent, getSession, getSessionFindings, getSubagents, getTimeline, getTrace, search } from "../api/client";
import { Blurred } from "../shell/Blurred";
import type { SessionCard } from "../api/types";
import TimelinePanel from "../timeline/TimelinePanel";
import InspectorPanel from "../inspector/InspectorPanel";
import TraceView from "../trace/TraceView";
import { buildLoopContextMap } from "../trace/loopContext";
import SessionInsightStrip from "../session/SessionInsightStrip";
import EventDensityTile from "../session/EventDensityTile";
import ToolUsageTile from "../session/ToolUsageTile";
import SubagentHeatTile from "../session/SubagentHeatTile";

interface Props {
  session: SessionCard;
  /** Event to select on entry (deep-link from analytics views); null = default. */
  initialEventId?: number | null;
}

function SessionWorkspace({ session, initialEventId = null }: Props) {
  const [selectedEventId, setSelectedEventId] = React.useState<number | null>(initialEventId);
  const [cursorIndex, setCursorIndex] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const sessionQuery = useQuery({ queryKey: ["session", session.id], queryFn: () => getSession(session.id), initialData: session });
  const timeline = useQuery({ queryKey: ["timeline", session.id], queryFn: () => getTimeline(session.id) });
  const trace = useQuery({ queryKey: ["trace", session.id], queryFn: () => getTrace(session.id) });
  const subagents = useQuery({ queryKey: ["subagents", session.id], queryFn: () => getSubagents(session.id) });
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
  const loopContexts = React.useMemo(() => buildLoopContextMap(spans), [spans]);
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

  const selectCursor = React.useCallback((nextIndex: number) => {
    if (timelineItems.length === 0) return;
    const boundedIndex = Math.max(0, Math.min(nextIndex, timelineItems.length - 1));
    setCursorIndex(boundedIndex);
    setSelectedEventId(timelineItems[boundedIndex].event_id);
  }, [timelineItems]);

  const selectSubagent = React.useCallback((agentId: string) => {
    const eventId = subagentFirstEventIds.get(agentId);
    if (!eventId) return;
    const index = timelineItems.findIndex((item) => item.event_id === eventId);
    if (index >= 0) setCursorIndex(index);
    setSelectedEventId(eventId);
    setPlaying(false);
  }, [subagentFirstEventIds, timelineItems]);

  React.useEffect(() => {
    setSelectedEventId(initialEventId);
    setCursorIndex(0);
    setPlaying(false);
  }, [session.id, initialEventId]);

  React.useEffect(() => {
    if (!selectedEventId && timelineItems.length) {
      setSelectedEventId(timelineItems[0].event_id);
    }
  }, [selectedEventId, timelineItems]);

  React.useEffect(() => {
    if (selectedEventId === null) return;
    const index = timelineItems.findIndex((item) => item.event_id === selectedEventId);
    if (index >= 0 && index !== cursorIndex) {
      setCursorIndex(index);
    }
  }, [cursorIndex, selectedEventId, timelineItems]);

  React.useEffect(() => {
    if (timelineItems.length === 0) return;
    if (cursorIndex > timelineItems.length - 1) {
      setCursorIndex(timelineItems.length - 1);
    }
  }, [cursorIndex, timelineItems]);

  React.useEffect(() => {
    if (!playing || timelineItems.length === 0) return;
    const id = window.setInterval(() => {
      setCursorIndex((value) => {
        const next = Math.min(value + 1, timelineItems.length - 1);
        setSelectedEventId(timelineItems[next].event_id);
        if (next === timelineItems.length - 1) setPlaying(false);
        return next;
      });
    }, 650);
    return () => window.clearInterval(id);
  }, [playing, timelineItems]);

  const cursorTimestamp = timelineItems[cursorIndex]?.timestamp ?? null;

  return (
    <main className="cost-page session-page">
      <div className="cost-page-inner session-page-inner">
        <div className="cost-filterbar session-toolbar">
          <div className="session-search-wrap">
            <label className="session-search">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search inside session" />
            </label>
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
        </div>
        <SessionInsightStrip session={card} />

        <section className="session-overview" aria-label="Session overview">
            <div className="cost-bento session-summary-grid">
              <EventDensityTile items={timelineItems} loopContexts={loopContexts} loading={timeline.isLoading} />
              <SubagentHeatTile
                subagents={subagentList}
                firstEventIds={subagentFirstEventIds}
                onSelectSubagent={selectSubagent}
              />
              <ToolUsageTile items={timelineItems} loading={timeline.isLoading} />
            </div>
        </section>

        <section className="cost-bento session-workspace" aria-label="Session workspace">
            <section className="tile tile-full session-trace-tile">
              <div className="session-tile-heading">
                <div className="session-title">
                  <p className="crumb">
                    <Blurred>{card.project_name}{card.git_branch ? ` / ${card.git_branch}` : ""}</Blurred>
                  </p>
                  <h2><Blurred>{card.title || card.session_id}</Blurred></h2>
                  <p className="session-meta"><Blurred>{metaParts.length ? metaParts.join(" · ") : card.session_id}</Blurred></p>
                </div>
                <span className="hint"><ArrowLeftRight size={13} /> spacing · lanes · loops</span>
              </div>
              <div className="session-trace-body event-graph">
                {trace.isLoading ? (
                  <div className="empty-state">Loading session trace...</div>
                ) : trace.isError || !trace.data ? (
                  <div className="empty-state">Could not load the session trace.</div>
                ) : (
                  <TraceView trace={trace.data} selectedEventId={selectedEventId} playheadTimestamp={cursorTimestamp} onSelect={setSelectedEventId} />
                )}
              </div>
            </section>
            <TimelinePanel
              items={timelineItems}
              selectedEventId={selectedEventId}
              cursorIndex={cursorIndex}
              playing={playing}
              loopContexts={loopContexts}
              onSelect={setSelectedEventId}
              onCursorChange={selectCursor}
              onPlayingChange={setPlaying}
            />
            <InspectorPanel
              session={card}
              event={selectedEvent.data}
              loopContext={selectedEventId !== null ? loopContexts.get(selectedEventId) : undefined}
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
