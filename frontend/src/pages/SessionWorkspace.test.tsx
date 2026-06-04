import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionCard } from "../api/types";
import SessionWorkspace from "./SessionWorkspace";

vi.mock("../api/client", () => ({
  getSession: vi.fn(async (id: number) => baseSession(id)),
  getTimeline: vi.fn(async () => []),
  getTrace: vi.fn(async () => ({
    session_id: 1,
    first_ts: null,
    last_ts: null,
    lanes: [],
    spans: [],
    cost: {
      usd: 0.48,
      available: true,
      unpriced_models: [],
      tokens: { base_input: 600, cache_write_5m: 0, cache_write_1h: 0, cache_read: 400, output: 500 },
    },
  })),
  getSubagents: vi.fn(async () => []),
  getSessionFindings: vi.fn(async () => []),
  getEvent: vi.fn(async () => null),
  search: vi.fn(async () => []),
}));

vi.mock("../timeline/TimelinePanel", () => ({
  default: () => <section className="timeline-panel" data-testid="timeline-panel">Timeline</section>,
}));

vi.mock("../inspector/InspectorPanel", () => ({
  default: () => <section className="inspector-panel" data-testid="inspector-panel">Inspector</section>,
}));

vi.mock("../trace/TraceView", () => ({
  default: () => <div data-testid="trace-view">Trace</div>,
}));

function baseSession(id: number): SessionCard {
  return {
    id,
    project_id: 1,
    project_name: "Claude Analytics",
    session_id: "session-1",
    title: "Balanced layout pass",
    first_ts: "2026-06-03T10:00:00Z",
    last_ts: "2026-06-03T10:22:00Z",
    cwd: "D:\\Code\\Claude-code-forensic",
    version: "1.2.3",
    entrypoint: "claude",
    git_branch: "feat/session-layout",
    event_count: 50,
    turn_count: 4,
    tool_call_count: 10,
    subagent_count: 0,
    error_count: 3,
    system_count: 3,
    persisted_output_count: 0,
    input_tokens: 1000,
    output_tokens: 500,
    loop_count: 2,
    max_repeat: 7,
    duration_seconds: 1320,
    max_agent_events: 100,
    finding_count: 1,
    pattern_risk_score: 42,
    top_finding_category: null,
    top_finding_severity: null,
    top_finding_title: null,
    cost_usd: 0.48,
    cost_available: true,
  };
}

function renderWorkspace() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionWorkspace session={baseSession(1)} />
    </QueryClientProvider>,
  );
}

describe("SessionWorkspace", () => {
  it("uses the shared cost page shell with summary and workspace on one page", async () => {
    const { container } = renderWorkspace();

    expect(await screen.findByRole("heading", { name: "Balanced layout pass" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search inside session")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Overview" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workspace" })).not.toBeInTheDocument();
    expect(container.querySelector(".cost-page.session-page")).not.toBeNull();
    expect(container.querySelector(".cost-page-inner.session-page-inner")).not.toBeNull();
    expect(container.querySelector(".session-page-inner")).not.toBeNull();
    expect(container.querySelector(".session-toolbar")).not.toBeNull();
    expect(container.querySelector(".session-overview .session-summary-grid")).not.toBeNull();
    expect(container.querySelector(".session-workspace")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Event density" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Subagents - 0" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tool usage" })).toBeInTheDocument();
  });

  it("renders trace timeline and inspector without switching tabs", async () => {
    renderWorkspace();

    expect(await screen.findByTestId("trace-view")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-panel")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-panel")).toBeInTheDocument();
  });
});
