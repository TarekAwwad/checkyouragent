import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TimelinePanel from "./TimelinePanel";
import type { TimelineItem } from "../api/types";

function item(partial: Partial<TimelineItem> & { id: string; event_id: number; kind: string; title: string }): TimelineItem {
  return {
    id: partial.id,
    event_id: partial.event_id,
    kind: partial.kind,
    title: partial.title,
    timestamp: partial.timestamp ?? null,
    preview: partial.preview ?? null,
    event_type: partial.event_type ?? partial.kind,
    role: partial.role ?? null,
    tool_name: partial.tool_name ?? null,
    agent_id: partial.agent_id ?? null,
    is_sidechain: partial.is_sidechain ?? false,
    related_event_ids: partial.related_event_ids ?? [],
  };
}

const items: TimelineItem[] = [
  item({ id: "evt-1", event_id: 1, kind: "user_turn", title: "Prompt" }),
  item({ id: "evt-2", event_id: 2, kind: "assistant", title: "Plan" }),
  item({ id: "evt-3", event_id: 3, kind: "tool_call", title: "Read file" }),
];

describe("TimelinePanel", () => {
  it("scrolls the selected replay event into view when selection changes", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    const { rerender } = render(
      <TimelinePanel
        items={items}
        selectedEventId={1}
        cursorIndex={0}
        playing={false}
        onSelect={() => {}}
        onCursorChange={() => {}}
        onPlayingChange={() => {}}
      />,
    );

    const initialCalls = scrollIntoView.mock.calls.length;

    rerender(
      <TimelinePanel
        items={items}
        selectedEventId={3}
        cursorIndex={2}
        playing={false}
        onSelect={() => {}}
        onCursorChange={() => {}}
        onPlayingChange={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /Read file/i })).toHaveClass("selected");
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("marks replay rows that are part of a loop run", () => {
    render(
      <TimelinePanel
        items={items}
        selectedEventId={3}
        cursorIndex={2}
        playing={false}
        loopContexts={new Map([
          [3, {
            eventId: 3,
            runId: "main-tool-loop-1",
            toolName: "Read",
            position: 2,
            count: 3,
            startEventId: 2,
            endEventId: 4,
          }],
        ])}
        onSelect={() => {}}
        onCursorChange={() => {}}
        onPlayingChange={() => {}}
      />,
    );

    expect(screen.getByText("Loop 2/3")).toBeInTheDocument();
    expect(screen.getByTitle(/Read repeated 3 times consecutively/)).toBeInTheDocument();
  });

  it("collapses a turn with more than five events to the first three plus show more", () => {
    const big: TimelineItem[] = [
      item({ id: "u", event_id: 1, kind: "user_turn", title: "Prompt" }),
      ...Array.from({ length: 6 }, (_, i) =>
        item({ id: `t${i}`, event_id: 10 + i, kind: "assistant", title: `Step ${i + 1}` })),
    ];
    render(
      <TimelinePanel
        items={big}
        selectedEventId={null}
        cursorIndex={0}
        playing={false}
        onSelect={() => {}}
        onCursorChange={() => {}}
        onPlayingChange={() => {}}
      />,
    );

    // First 3 items of the turn visible (user prompt + Step 1 + Step 2); later hidden.
    expect(screen.getByText("Step 1")).toBeInTheDocument();
    expect(screen.getByText("Step 2")).toBeInTheDocument();
    expect(screen.queryByText("Step 3")).not.toBeInTheDocument();
    expect(screen.queryByText("Step 6")).not.toBeInTheDocument();

    const moreButton = screen.getByRole("button", { name: /show \d+ more/ });
    fireEvent.click(moreButton);

    expect(screen.getByText("Step 6")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show \d+ more/ })).not.toBeInTheDocument();
  });

  it("keeps a large turn expanded when it contains an error event", () => {
    const big: TimelineItem[] = [
      item({ id: "u", event_id: 1, kind: "user_turn", title: "Prompt" }),
      item({ id: "e1", event_id: 11, kind: "assistant", title: "Step 1" }),
      item({ id: "e2", event_id: 12, kind: "assistant", title: "Step 2" }),
      item({ id: "e3", event_id: 13, kind: "assistant", title: "Step 3" }),
      item({ id: "err", event_id: 14, kind: "system", title: "Tool error" }),
      item({ id: "e5", event_id: 15, kind: "assistant", title: "Step 5" }),
      item({ id: "e6", event_id: 16, kind: "assistant", title: "Step 6" }),
    ];
    render(
      <TimelinePanel
        items={big}
        selectedEventId={null}
        cursorIndex={0}
        playing={false}
        onSelect={() => {}}
        onCursorChange={() => {}}
        onPlayingChange={() => {}}
      />,
    );

    expect(screen.getByText("Tool error")).toBeInTheDocument();
    expect(screen.getByText("Step 6")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show \d+ more/ })).not.toBeInTheDocument();
  });

  it("auto-expands a collapsed turn when the selection lands inside it", () => {
    const big: TimelineItem[] = [
      item({ id: "u", event_id: 1, kind: "user_turn", title: "Prompt" }),
      ...Array.from({ length: 6 }, (_, i) =>
        item({ id: `t${i}`, event_id: 10 + i, kind: "assistant", title: `Step ${i + 1}` })),
    ];
    // Select an event (event_id 15 => "Step 6") that lives in the collapsed tail.
    render(
      <TimelinePanel
        items={big}
        selectedEventId={15}
        cursorIndex={6}
        playing={false}
        onSelect={() => {}}
        onCursorChange={() => {}}
        onPlayingChange={() => {}}
      />,
    );

    expect(screen.getByText("Step 6")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show \d+ more/ })).not.toBeInTheDocument();
  });
});
