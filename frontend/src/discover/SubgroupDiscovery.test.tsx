import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryDriver, DiscoveryResponse, Project } from "../api/types";

const { getDiscoveryAnalytics } = vi.hoisted(() => ({ getDiscoveryAnalytics: vi.fn() }));
vi.mock("../api/client", () => ({ getDiscoveryAnalytics }));

import SubgroupDiscovery from "./SubgroupDiscovery";
import { TestScopeProvider } from "../shell/TestScopeProvider";

const projects: Project[] = [
  {
    id: 1,
    export_name: "alpha",
    display_name: "alpha",
    inferred_cwd: null,
    session_count: 3,
    event_count: 30,
    subagent_count: 12,
    cost_usd: 12,
    cost_available: true,
  },
];

function driver(overrides: Partial<DiscoveryDriver> = {}): DiscoveryDriver {
  return {
    id: "fanout=has_subagents|model=sonnet",
    title: "Has subagents + Uses claude-sonnet-4-6",
    summary: "Has subagents and Uses claude-sonnet-4-6 is associated with a 45.8 percentage-point higher observed rate than the complement.",
    selectors: ["Has subagents", "Uses claude-sonnet-4-6"],
    support: 11,
    positive_support: 6,
    complement_count: 46,
    complement_positive_count: 4,
    baseline_rate: 0.1754,
    subgroup_rate: 0.545,
    complement_rate: 0.087,
    effect_size: 0.458,
    subgroup_rate_low: 0.36,
    examples: [
      {
        id: 7,
        kind: "session",
        event_id: null,
        session_id: "s1",
        title: "Review handoff files and summarize roadmap",
        project_name: "Hermes",
        metric: 88.5,
        metric_label: "estimated cost",
        detail: "12 subagents, 20 tools",
      },
    ],
    ...overrides,
  };
}

const payload: DiscoveryResponse = {
  meta: { project_id: null, min_support: 5, total_sessions: 57,
          total_tool_calls: 100, cost_available: true, unpriced_models: [] },
  sections: {
    cost_associations: {
      key: "cost_associations",
      title: "Cost associations",
      target_label: "High estimated API-equivalent cost",
      description: "Session attributes associated with the observed top estimated-cost band.",
      observation_unit: "session",
      available: true,
      unavailable_reason: null,
      baseline_count: 57,
      positive_count: 10,
      results: [driver()],
    },
    tool_error_associations: {
      key: "tool_error_associations",
      title: "Tool error associations",
      target_label: "Tool calls with errors",
      description: "Tool-call attributes associated with observed error results.",
      observation_unit: "tool_call",
      available: true,
      unavailable_reason: null,
      baseline_count: 100,
      positive_count: 10,
      results: [driver({
        id: "tool_family=Bash:test",
        title: "Bash Test commands",
        selectors: ["Bash Test commands"],
        support: 20,
        positive_support: 8,
        complement_count: 80,
        complement_positive_count: 2,
        baseline_rate: 0.05,
        subgroup_rate: 0.4,
        complement_rate: 0.025,
        effect_size: 0.375,
        examples: [{
          id: 7, kind: "tool_call", event_id: 101, session_id: "s1",
          title: "Review handoff files and summarize roadmap", project_name: "Hermes",
          metric: 1, metric_label: "tool error", detail: "Bash test command",
        }],
      })],
    },
  },
};

function renderPage(onOpenSession = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onOpenSession,
    ...render(
      <QueryClientProvider client={queryClient}>
        <TestScopeProvider projects={projects.map((p) => ({ id: p.id, name: p.display_name }))}>
          <SubgroupDiscovery onOpenSession={onOpenSession} />
        </TestScopeProvider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  getDiscoveryAnalytics.mockReset();
  getDiscoveryAnalytics.mockResolvedValue(payload);
});

describe("SubgroupDiscovery", () => {
  it("presents experimental associations, declared units, effects, and receipts", async () => {
    const onOpenSession = vi.fn();
    renderPage(onOpenSession);

    expect(await screen.findByRole("heading", { name: "Subgroups" }))
      .toBeInTheDocument();
    expect(screen.getByText("Observed associations, not causes.")).toBeInTheDocument();
    expect(screen.getByText("Experimental")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Observed cost association" }))
      .toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Associations" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Evidence receipts" })).toBeInTheDocument();
    expect(await screen.findAllByText("Has subagents + Uses claude-sonnet-4-6"))
      .not.toHaveLength(0);
    expect(await screen.findByText(/Matching sessions had high estimated API-equivalent cost 54.5%/))
      .toBeInTheDocument();
    expect(await screen.findByText(/compared with 8.7% among other sessions/))
      .toBeInTheDocument();
    expect(await screen.findByText("6 of 11 matching sessions had this outcome."))
      .toBeInTheDocument();
    expect(await screen.findByText("4 of 46 other sessions had this outcome."))
      .toBeInTheDocument();
    expect(await screen.findByText("11 matching sessions")).toBeInTheDocument();
    expect((await screen.findAllByText("+45.8 pts")).length).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText(/Overall baseline 17.5%/)).toBeInTheDocument();
    expect(await screen.findByText("Unit: session")).toBeInTheDocument();
    expect(await screen.findAllByText("54.5%")).not.toHaveLength(0);
    expect(await screen.findAllByText("8.7%")).not.toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/drives|(?<!not )causes|more likely/i);

    fireEvent.click(screen.getByRole("button", { name: /Open receipt/ }));

    expect(onOpenSession).toHaveBeenCalledWith(7, null);
  });

  it("shows only valid sections and opens a tool-call event receipt", async () => {
    const onOpenSession = vi.fn();
    renderPage(onOpenSession);

    expect(await screen.findAllByRole("tab")).toHaveLength(2);
    fireEvent.click(await screen.findByRole("tab", { name: "Tool errors" }));

    expect(await screen.findAllByText("Bash Test commands")).not.toHaveLength(0);
    expect(await screen.findAllByText("40.0%")).not.toHaveLength(0);
    expect(screen.getByText("Unit: tool call")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open receipt/ }));
    expect(onOpenSession).toHaveBeenCalledWith(7, 101);
  });

  it("passes project and minimum support filters to the API", async () => {
    renderPage();
    await screen.findAllByRole("heading", { name: "Subgroups" });

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Minimum support"), { target: { value: "10" } });

    await waitFor(() => {
      expect(getDiscoveryAnalytics).toHaveBeenLastCalledWith({ projectId: 1, minSupport: 10 });
    });
  });

  it("shows an empty imported-session state", async () => {
    getDiscoveryAnalytics.mockResolvedValueOnce({
      ...payload,
      meta: { ...payload.meta, total_sessions: 0 },
      sections: {
        ...payload.sections,
        cost_associations: {
          ...payload.sections.cost_associations,
          baseline_count: 0, positive_count: 0, results: [],
        },
      },
    });

    renderPage();

    expect(await screen.findByText("No imported sessions available.")).toBeInTheDocument();
  });

  it("explains when cost associations are unavailable because pricing is incomplete", async () => {
    getDiscoveryAnalytics.mockResolvedValueOnce({
      ...payload,
      meta: { ...payload.meta, cost_available: false, unpriced_models: ["custom-model"] },
      sections: {
        ...payload.sections,
        cost_associations: {
          ...payload.sections.cost_associations,
          available: false,
          unavailable_reason: "Complete pricing coverage is required for cost associations.",
          results: [],
        },
      },
    });

    renderPage();

    expect(await screen.findByText("Cost associations unavailable.")).toBeInTheDocument();
    expect(screen.getByText(/complete pricing coverage/i)).toBeInTheDocument();
    expect(screen.getByText(/custom-model/)).toBeInTheDocument();
  });

  it("renders an error state when discovery fails", async () => {
    getDiscoveryAnalytics.mockReset();
    getDiscoveryAnalytics.mockRejectedValue(new Error("boom"));

    renderPage();

    expect(await screen.findByText("Discovery failed.")).toBeInTheDocument();
  });
});
