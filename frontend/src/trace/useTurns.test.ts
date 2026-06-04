import { describe, expect, it } from "vitest";
import { groupTurns } from "./useTurns";
import type { TimelineItem } from "../api/types";

function item(partial: Partial<TimelineItem> & { event_id: number; kind: string }): TimelineItem {
  return {
    id: `event-${partial.event_id}`,
    title: "",
    timestamp: null,
    preview: null,
    event_type: partial.kind,
    role: null,
    tool_name: null,
    agent_id: null,
    is_sidechain: false,
    related_event_ids: [],
    ...partial,
  };
}

describe("groupTurns", () => {
  it("returns an empty list for no items", () => {
    expect(groupTurns([])).toEqual([]);
  });

  it("starts a new turn on each user_turn and attaches following items", () => {
    const turns = groupTurns([
      item({ event_id: 1, kind: "user_turn", title: "First ask" }),
      item({ event_id: 2, kind: "assistant" }),
      item({ event_id: 3, kind: "tool_call" }),
      item({ event_id: 4, kind: "user_turn", title: "Second ask" }),
      item({ event_id: 5, kind: "assistant" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].title).toBe("First ask");
    expect(turns[0].items).toHaveLength(3);
    expect(turns[1].title).toBe("Second ask");
    expect(turns[1].items).toHaveLength(2);
  });

  it("groups leading non-user items under a 'Session start' turn", () => {
    const turns = groupTurns([
      item({ event_id: 1, kind: "system" }),
      item({ event_id: 2, kind: "assistant" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].title).toBe("Session start");
    expect(turns[0].items).toHaveLength(2);
  });
});
