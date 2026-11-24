// frontend/src/discover/DiscoverPage.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api/types";
import { TestScopeProvider } from "../shell/TestScopeProvider";

const { getDiscoveryAnalytics, getLimits } = vi.hoisted(() => ({
  getDiscoveryAnalytics: vi.fn(),
  getLimits: vi.fn(),
}));
vi.mock("../api/client", () => ({ getDiscoveryAnalytics, getLimits }));

import DiscoverPage from "./DiscoverPage";

const projects: Project[] = [];

function renderPage(technique: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TestScopeProvider>
        <DiscoverPage projects={projects} onOpenSession={vi.fn()} technique={technique} />
      </TestScopeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getLimits.mockReset();
  getLimits.mockResolvedValue({
    meta: {
      window: { date_from: null, date_to: null },
      cost_available: true, costs_partial: false,
      total_hits: 0, total_windows: 0, minutes_until_reset: 0,
      hits_per_week_recent: 0, hit_counts: {}, plan_history: [],
    },
    hits: [], windows: [], eras: [],
  });
  getDiscoveryAnalytics.mockReset();
  getDiscoveryAnalytics.mockResolvedValue({
    meta: {
      project_id: null, min_support: 5, total_sessions: 12, total_tool_calls: 30,
      cost_available: true, unpriced_models: [],
    },
    sections: {
      cost_associations: {
        key: "cost_associations",
        title: "Cost associations",
        target_label: "High estimated API-equivalent cost",
        description: "",
        observation_unit: "session",
        available: true,
        unavailable_reason: null,
        baseline_count: 12,
        positive_count: 3,
        results: [{
          id: "model:sonnet",
          title: "Sonnet-heavy sessions",
          summary: "",
          selectors: ["model = sonnet"],
          support: 6,
          positive_support: 3,
          complement_count: 6,
          complement_positive_count: 0,
          baseline_rate: 0.25,
          subgroup_rate: 0.5,
          complement_rate: 0,
          effect_size: 0.5,
          subgroup_rate_low: 0.22,
          examples: [],
        }],
      },
      tool_error_associations: {
        key: "tool_error_associations",
        title: "Tool-error associations",
        target_label: "Recorded tool error",
        description: "",
        observation_unit: "tool_call",
        available: true,
        unavailable_reason: null,
        baseline_count: 30,
        positive_count: 0,
        results: [],
      },
    },
  });
});

describe("DiscoverPage", () => {
  it("renders the active ready technique", async () => {
    renderPage("subgroup");
    expect(
      await screen.findByRole("heading", { name: "Experimental subgroup associations" }),
    ).toBeInTheDocument();
  });

  it("falls back to the default technique (limits) for an unregistered key", async () => {
    renderPage("sequence");
    expect(
      await screen.findByRole("heading", { name: "Limit hits" }),
    ).toBeInTheDocument();
  });
});
