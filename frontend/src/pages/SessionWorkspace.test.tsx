import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionCard } from "../api/types";
import { getSubagents } from "../api/client";
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
  getToolActivity: vi.fn(async () => []),
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
  default: ({ selectedEventId }: { selectedEventId: number | null }) => (
    <div data-testid="trace-view" data-selected-event-id={selectedEventId ?? ""}>Trace</div>
  ),
}));

function baseSession(id: number): SessionCard {
  return {
    id,
    project_id: 1,
    project_name: "Example Project",
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
    duration_seconds: 1320,
    max_agent_events: 100,
    finding_count: 1,
    top_finding_title: null,
    top_finding_basis: null,
    cost_usd: 0.48,
    cost_available: true,
  };
}

function renderWorkspace(options: {
  initialEventId?: number | null;
  section?: string;
  backLabel?: string;
  onBack?: () => void;
  historical?: boolean;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionWorkspace session={baseSession(1)} {...options} />
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
    expect(container.querySelector(".page-header")).not.toBeNull();
    expect(container.querySelector(".session-overview .session-summary-grid")).not.toBeNull();
    expect(container.querySelector(".session-workspace")).not.toBeNull();
    expect(screen.getByText("Estimated API-equivalent cost")).toBeInTheDocument();
    expect(screen.getByText("Turns")).toBeInTheDocument();
    expect(screen.getByText("Session span")).toBeInTheDocument();
    expect(screen.getByText("Observed errors")).toBeInTheDocument();
    expect(screen.queryByText("Risk score")).not.toBeInTheDocument();
    expect(screen.queryByText("Max loop")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Subagents - 0" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Tool activity" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Event density" })).not.toBeInTheDocument();
  });

  it("passes the existing historical-pricing mode to subagent activity", async () => {
    vi.mocked(getSubagents).mockClear();
    renderWorkspace({ historical: false });

    await waitFor(() => expect(getSubagents).toHaveBeenCalledWith(1, false));
  });

  it("keeps Trace visible alongside Timeline and Inspector", async () => {
    renderWorkspace();

    expect(await screen.findByTestId("trace-view")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-panel")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-panel")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show trace" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hide trace" })).not.toBeInTheDocument();
    expect(screen.queryByText(/loops/i)).not.toBeInTheDocument();
  });

  it("shows an origin-aware back control when provided", async () => {
    const onBack = vi.fn();
    renderWorkspace({ backLabel: "Back to Cost", onBack });

    fireEvent.click(await screen.findByRole("button", { name: "Back to Cost" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("keeps a deep-linked event selected in Trace", async () => {
    renderWorkspace({ initialEventId: 42 });

    expect(await screen.findByTestId("trace-view")).toHaveAttribute("data-selected-event-id", "42");
  });

  it("puts the session title and its origin in the header", async () => {
    renderWorkspace({ section: "Cost", backLabel: "Back to Cost", onBack: vi.fn() });
    expect(await screen.findByRole("heading", { level: 1, name: "Balanced layout pass" })).toBeInTheDocument();
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Trace" })).toBeInTheDocument();
  });
});
