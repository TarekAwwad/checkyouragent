import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryDriver, DiscoveryResponse, Project } from "../api/types";

const { getDiscoveryAnalytics } = vi.hoisted(() => ({ getDiscoveryAnalytics: vi.fn() }));
vi.mock("../api/client", () => ({ getDiscoveryAnalytics }));

import SubgroupDiscovery from "./SubgroupDiscovery";

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
    id: "subagents=>10|model=sonnet",
    title: ">10 subagents + Uses claude-sonnet-4-6",
    summary: ">10 subagents and Uses claude-sonnet-4-6 is 5.2x more likely than baseline.",
    selectors: [">10 subagents", "Uses claude-sonnet-4-6"],
    support: 11,
    positive_support: 6,
    baseline_rate: 0.105,
    subgroup_rate: 0.545,
    lift: 5.18,
    score: 0.0849,
    examples: [
      {
        id: 7,
        kind: "session",
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
  meta: { project_id: null, min_support: 5, total_sessions: 57, cost_available: true },
  sections: {
    cost: {
      key: "cost",
      title: "Cost drivers",
      target_label: "High-cost sessions",
      description: "Conditions that make a session more likely to land in the top cost band.",
      available: true,
      unavailable_reason: null,
      baseline_count: 57,
      positive_count: 6,
      results: [driver()],
    },
    fanout_cost: {
      key: "fanout_cost",
      title: "Fanout cost drivers",
      target_label: "High-cost sessions",
      description: "Cost drivers that include subagent fanout or Agent orchestration.",
      available: true,
      unavailable_reason: null,
      baseline_count: 57,
      positive_count: 6,
      results: [driver({ id: "tool=Agent", title: "Uses Agent", selectors: ["Uses Agent"] })],
    },
    tool_errors: {
      key: "tool_errors",
      title: "Tool error drivers",
      target_label: "Tool calls with errors",
      description: "Tool-call conditions that are more likely to end in an error result.",
      available: true,
      unavailable_reason: null,
      baseline_count: 100,
      positive_count: 5,
      results: [driver({
        id: "tool_family=Bash:test",
        title: "Bash Test commands",
        selectors: ["Bash Test commands"],
        support: 20,
        positive_support: 8,
        baseline_rate: 0.05,
        subgroup_rate: 0.4,
        lift: 8,
      })],
    },
    rejections: {
      key: "rejections",
      title: "Rejection drivers",
      target_label: "Rejected slices",
      description: "Workflow features that are more likely to appear in rejected slices.",
      available: true,
      unavailable_reason: null,
      baseline_count: 200,
      positive_count: 10,
      results: [],
    },
  },
};

function renderPage(onOpenSession = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onOpenSession,
    ...render(
      <QueryClientProvider client={queryClient}>
        <SubgroupDiscovery projects={projects} onOpenSession={onOpenSession} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  getDiscoveryAnalytics.mockReset();
  getDiscoveryAnalytics.mockResolvedValue(payload);
});

describe("SubgroupDiscovery", () => {
  it("renders drivers with expanded evidence and opens example sessions", async () => {
    const onOpenSession = vi.fn();
    renderPage(onOpenSession);

    expect(await screen.findByRole("heading", { name: "What drives high-cost sessions?" })).toBeInTheDocument();
    expect(await screen.findByText(">10 subagents + Uses claude-sonnet-4-6")).toBeInTheDocument();
    expect(await screen.findByText("6 of 11 matched items hit this outcome.")).toBeInTheDocument();
    expect(await screen.findByText("54.5%")).toBeInTheDocument();
    expect(await screen.findByText("10.5%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open session/ }));

    expect(onOpenSession).toHaveBeenCalledWith(7);
  });

  it("switches between driver sections", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Tool errors" }));

    expect(await screen.findAllByText("Bash Test commands")).not.toHaveLength(0);
    expect(await screen.findByText("40.0%")).toBeInTheDocument();
  });

  it("passes project and minimum support filters to the API", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "What drives high-cost sessions?" });

    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Minimum support"), { target: { value: "10" } });

    await waitFor(() => {
      expect(getDiscoveryAnalytics).toHaveBeenLastCalledWith({ projectId: 1, minSupport: 10 });
    });
  });

  it("shows an empty imported-session state", async () => {
    getDiscoveryAnalytics.mockResolvedValueOnce({
      ...payload,
      meta: { project_id: null, min_support: 5, total_sessions: 0, cost_available: true },
      sections: {
        ...payload.sections,
        cost: { ...payload.sections.cost, baseline_count: 0, positive_count: 0, results: [] },
      },
    });

    renderPage();

    expect(await screen.findByText("No imported sessions available.")).toBeInTheDocument();
  });

  it("renders an error state when discovery fails", async () => {
    getDiscoveryAnalytics.mockReset();
    getDiscoveryAnalytics.mockRejectedValue(new Error("boom"));

    renderPage();

    expect(await screen.findByText("Discovery failed.")).toBeInTheDocument();
  });
});
