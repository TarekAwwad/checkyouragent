import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionCard, Subagent, TimelineItem, TraceSpan } from "../api/types";
import SessionInsightStrip from "./SessionInsightStrip";
import EventDensityTile from "./EventDensityTile";
import ToolUsageTile from "./ToolUsageTile";
import CostPerTurnTile from "./CostPerTurnTile";
import SubagentHeatTile from "./SubagentHeatTile";

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

function span(partial: Partial<TraceSpan> & { id: string; event_id: number }): TraceSpan {
  return {
    id: partial.id,
    event_id: partial.event_id,
    lane: partial.lane ?? "main",
    kind: partial.kind ?? "assistant",
    input_tokens: partial.input_tokens ?? 0,
    output_tokens: partial.output_tokens ?? 0,
    model: partial.model ?? null,
    start_ts: partial.start_ts ?? null,
    end_ts: partial.end_ts ?? null,
    tool_use_id: partial.tool_use_id ?? null,
    tool_name: partial.tool_name ?? null,
    is_loop: partial.is_loop ?? false,
  };
}

const baseSession: SessionCard = {
  id: 1, project_id: 1, project_name: "ccfr", session_id: "s-1", title: "Debug loop",
  first_ts: "2026-06-03T10:00:00Z", last_ts: "2026-06-03T10:22:00Z", cwd: "~/p/ccfr",
  version: "1.2.3", entrypoint: "$ claude", git_branch: "feat/cost-analytics",
  event_count: 50, turn_count: 4, tool_call_count: 10, subagent_count: 2, error_count: 3,
  system_count: 3, persisted_output_count: 0, input_tokens: 1000, output_tokens: 500,
  loop_count: 2, max_repeat: 7, duration_seconds: 1320, max_agent_events: 100,
  finding_count: 1, pattern_risk_score: 42, top_finding_category: null,
  top_finding_severity: null, top_finding_title: null, cost_usd: 0.48, cost_available: true,
};

describe("SessionInsightStrip", () => {
  it("renders the remaining session quality insight cards", () => {
    render(<SessionInsightStrip session={baseSession} />);
    expect(screen.getByText("Errors")).toBeInTheDocument();
    expect(screen.getByText("x7")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.queryByText("Cost")).not.toBeInTheDocument();
    expect(screen.queryByText("Cache hit")).not.toBeInTheDocument();
  });
});

describe("EventDensityTile", () => {
  it("renders a spend-over-time styled chart with error and loop markers", () => {
    const items = [
      item({ id: "a", event_id: 1, kind: "user_turn", title: "Prompt", timestamp: "2026-06-03T10:00:00Z" }),
      item({ id: "b", event_id: 2, kind: "assistant", title: "Plan", timestamp: "2026-06-03T10:05:00Z" }),
      item({ id: "c", event_id: 3, kind: "system", title: "Tool error", timestamp: "2026-06-03T10:10:00Z" }),
      item({ id: "d", event_id: 4, kind: "tool_call", title: "Bash", timestamp: "2026-06-03T10:20:00Z" }),
    ];
    const loops = new Map([[4, { eventId: 4, runId: "r", toolName: "Bash", position: 1, count: 3, startEventId: 4, endEventId: 6 }]]);
    const { container } = render(<EventDensityTile items={items} loopContexts={loops} />);
    expect(screen.getByText("events")).toBeInTheDocument();
    expect(container.querySelector(".sot-plot")).not.toBeNull();
    expect(container.querySelector('[data-marker="error"]')).not.toBeNull();
    expect(container.querySelector('[data-marker="loop"]')).not.toBeNull();
  });

  it("shows an empty state with no events", () => {
    render(<EventDensityTile items={[]} />);
    expect(screen.getByText("No events")).toBeInTheDocument();
  });
});

describe("ToolUsageTile", () => {
  it("ranks tools by call count", () => {
    const items = [
      item({ id: "1", event_id: 1, kind: "tool_call", title: "Bash", tool_name: "Bash" }),
      item({ id: "2", event_id: 2, kind: "tool_call", title: "Bash", tool_name: "Bash" }),
      item({ id: "3", event_id: 3, kind: "tool_call", title: "Read", tool_name: "Read" }),
      item({ id: "4", event_id: 4, kind: "assistant", title: "msg" }),
    ];
    render(<ToolUsageTile items={items} />);
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows an empty state with no tool calls", () => {
    render(<ToolUsageTile items={[]} />);
    expect(screen.getByText("No tool calls")).toBeInTheDocument();
  });
});

describe("CostPerTurnTile", () => {
  const items = [
    item({ id: "u1", event_id: 1, kind: "user_turn", title: "T1" }),
    item({ id: "a1", event_id: 2, kind: "assistant", title: "reply" }),
    item({ id: "u2", event_id: 3, kind: "user_turn", title: "T2" }),
    item({ id: "a2", event_id: 4, kind: "assistant", title: "reply" }),
  ];
  const spans = [
    span({ id: "s1", event_id: 2, input_tokens: 100, output_tokens: 50 }),
    span({ id: "s2", event_id: 4, input_tokens: 900, output_tokens: 400 }),
  ];

  it("prices turns in USD when cost is available", () => {
    render(<CostPerTurnTile items={items} spans={spans} costUsd={1.45} costAvailable />);
    expect(screen.getByText("T1")).toBeInTheDocument();
    expect(screen.getByText("T2")).toBeInTheDocument();
    expect(screen.queryByText("token volume (no pricing)")).not.toBeInTheDocument();
  });

  it("falls back to token volume with a note when pricing is unavailable", () => {
    render(<CostPerTurnTile items={items} spans={spans} costUsd={0} costAvailable={false} />);
    expect(screen.getByText("token volume (no pricing)")).toBeInTheDocument();
  });
});

describe("SubagentHeatTile", () => {
  it("maps labels chronologically, exposes tooltip mapping, and handles clicks", () => {
    const subagents: Subagent[] = [
      { id: 1, agent_id: "a1", agent_type: "Explore", description: null, name: null, tool_use_id: "tool-1", event_count: 180, first_ts: "2026-06-03T10:10:00Z", last_ts: "2026-06-03T10:20:00Z" },
      { id: 2, agent_id: "a2", agent_type: "Plan", description: null, name: null, tool_use_id: "tool-2", event_count: 60, first_ts: "2026-06-03T10:00:00Z", last_ts: "2026-06-03T10:05:00Z" },
    ];
    const firstEventIds = new Map([["a1", 52], ["a2", 42]]);
    const onSelectSubagent = vi.fn();

    const { container } = render(
      <SubagentHeatTile subagents={subagents} firstEventIds={firstEventIds} onSelectSubagent={onSelectSubagent} />,
    );

    expect(screen.getByText(/Subagents/)).toBeInTheDocument();
    expect(screen.getByText(/240 events total/)).toBeInTheDocument();
    expect(container.querySelectorAll(".heat-cell")).toHaveLength(2);
    expect(container.querySelector(".heat-cell.lvl-3")).not.toBeNull();

    const firstCell = screen.getByRole("button", { name: /A1: Plan/ });
    expect(firstCell).toHaveTextContent("A1");
    expect(firstCell).toHaveAttribute("title", expect.stringContaining("agent_id: a2"));
    expect(firstCell).toHaveAttribute("title", expect.stringContaining("opens event 42"));

    fireEvent.click(firstCell);
    expect(onSelectSubagent).toHaveBeenCalledWith("a2");
  });
});
