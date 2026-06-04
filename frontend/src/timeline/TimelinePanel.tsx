import React from "react";
import { Bot, Pause, Play, Repeat, SkipBack, SkipForward, User, Wrench, AlertTriangle } from "lucide-react";
import type { TimelineItem } from "../api/types";
import { groupTurns } from "../trace/useTurns";
import type { Turn } from "../trace/useTurns";
import type { LoopContext } from "../trace/loopContext";
import { loopExplanation } from "../trace/loopContext";
import { isErrorItem } from "../session/sessionAnalytics";

interface Props {
  items: TimelineItem[];
  selectedEventId: number | null;
  cursorIndex: number;
  playing: boolean;
  loopContexts?: Map<number, LoopContext>;
  onSelect: (eventId: number) => void;
  onCursorChange: (cursorIndex: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

const COLLAPSE_THRESHOLD = 5;
const COLLAPSED_VISIBLE = 3;

function TimelinePanel({
  items,
  selectedEventId,
  cursorIndex,
  playing,
  loopContexts,
  onSelect,
  onCursorChange,
  onPlayingChange,
}: Props) {
  const safeCursor = items.length === 0 ? 0 : Math.min(cursorIndex, items.length - 1);
  const selectedButtonRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (selectedEventId === null) return;
    selectedButtonRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedEventId]);

  const turns = React.useMemo(() => groupTurns(items), [items]);

  return (
    <aside className="timeline-panel">
      <div className="panel-header">
        <h2>Event Timeline</h2>
        <div className="icon-actions">
          <button title="Back" disabled={items.length === 0 || safeCursor === 0} onClick={() => onCursorChange(Math.max(safeCursor - 1, 0))}>
            <SkipBack size={16} />
          </button>
          <button title={playing ? "Pause" : "Play"} disabled={items.length === 0} onClick={() => onPlayingChange(!playing)}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button title="Forward" disabled={items.length === 0 || safeCursor === items.length - 1} onClick={() => onCursorChange(Math.min(safeCursor + 1, items.length - 1))}>
            <SkipForward size={16} />
          </button>
        </div>
      </div>
      <div className="replay-progress">
        <span>{items.length === 0 ? 0 : safeCursor + 1}</span>
        <div>
          <i style={{ width: `${items.length === 0 ? 0 : ((safeCursor + 1) / items.length) * 100}%` }} />
        </div>
        <span>{items.length}</span>
      </div>
      <div className="timeline-list">
        {turns.map((turn) => (
          <TurnGroup
            key={turn.id}
            turn={turn}
            loopContexts={loopContexts}
            selectedEventId={selectedEventId}
            selectedButtonRef={selectedButtonRef}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}

function TurnGroup({
  turn,
  loopContexts,
  selectedEventId,
  selectedButtonRef,
  onSelect,
}: {
  turn: Turn;
  loopContexts?: Map<number, LoopContext>;
  selectedEventId: number | null;
  selectedButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  onSelect: (eventId: number) => void;
}) {
  // A turn starts expanded when it has few events, or contains an error/loop.
  const hasAttention = React.useMemo(
    () => turn.items.some((item) => isErrorItem(item) || loopContexts?.has(item.event_id)),
    [turn.items, loopContexts],
  );
  const collapsible = turn.items.length > COLLAPSE_THRESHOLD && !hasAttention;
  const [expanded, setExpanded] = React.useState(!collapsible);

  // Auto-expand when the active selection lands on a hidden event in this group.
  const selectedInGroup =
    selectedEventId !== null && turn.items.some((item) => item.event_id === selectedEventId);
  React.useEffect(() => {
    if (selectedInGroup) setExpanded(true);
  }, [selectedInGroup]);

  const visible = collapsible && !expanded ? turn.items.slice(0, COLLAPSED_VISIBLE) : turn.items;
  const hiddenCount = turn.items.length - visible.length;

  return (
    <details open className="turn-group">
      <summary>{turn.title}</summary>
      <ol>
        {visible.map((item) => (
          <TimelineRow
            key={item.id}
            item={item}
            loopContext={loopContexts?.get(item.event_id)}
            selected={selectedEventId === item.event_id}
            selectedButtonRef={selectedButtonRef}
            onSelect={onSelect}
          />
        ))}
      </ol>
      {hiddenCount > 0 && (
        <button type="button" className="turn-show-more" onClick={() => setExpanded(true)}>
          show {hiddenCount} more
        </button>
      )}
    </details>
  );
}

function TimelineRow({
  item,
  loopContext,
  selected,
  selectedButtonRef,
  onSelect,
}: {
  item: TimelineItem;
  loopContext?: LoopContext;
  selected: boolean;
  selectedButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  onSelect: (eventId: number) => void;
}) {
  return (
    <li>
      <button
        ref={selected ? selectedButtonRef : null}
        className={`${selected ? "selected " : ""}kind-${item.kind}`}
        onClick={() => onSelect(item.event_id)}
      >
        {iconForItem(item)}
        <span>
          <strong>{item.title}</strong>
          {loopContext && (
            <span className="timeline-loop-badge" title={loopExplanation(loopContext)}>
              <Repeat size={11} /> Loop {loopContext.position}/{loopContext.count}
            </span>
          )}
          <small>{item.timestamp ? new Date(item.timestamp).toLocaleString() : item.event_type}</small>
          {item.preview && <em>{item.preview}</em>}
        </span>
      </button>
    </li>
  );
}

function iconForItem(item: TimelineItem) {
  if (item.kind === "user_turn") return <User size={15} />;
  if (item.kind === "tool_call" || item.kind === "tool_result") return <Wrench size={15} />;
  if (item.kind === "subagent_event") return <Bot size={15} />;
  if (item.kind === "system") return <AlertTriangle size={15} />;
  return <Bot size={15} />;
}

export default TimelinePanel;
