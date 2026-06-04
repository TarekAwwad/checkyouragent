import type { TimelineItem } from "../api/types";

export interface Turn {
  id: string;
  title: string;
  items: TimelineItem[];
}

// Group a flat timeline into turns: a user event starts a new turn; following
// assistant/tool/subagent/system events attach to it until the next user event.
export function groupTurns(items: TimelineItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.kind === "user_turn" || turns.length === 0) {
      turns.push({
        id: `turn-${item.event_id}`,
        title: item.kind === "user_turn" ? item.title : "Session start",
        items: [item],
      });
    } else {
      turns[turns.length - 1].items.push(item);
    }
  }
  return turns;
}
