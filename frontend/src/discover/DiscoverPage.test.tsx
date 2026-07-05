// frontend/src/discover/DiscoverPage.test.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api/types";

const { getDiscoveryAnalytics } = vi.hoisted(() => ({ getDiscoveryAnalytics: vi.fn() }));
vi.mock("../api/client", () => ({ getDiscoveryAnalytics }));

import DiscoverPage from "./DiscoverPage";

const projects: Project[] = [];

function renderPage(technique: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <DiscoverPage projects={projects} onOpenSession={vi.fn()} technique={technique} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getDiscoveryAnalytics.mockReset();
  getDiscoveryAnalytics.mockResolvedValue({
    meta: { project_id: null, min_support: 5, total_sessions: 12, cost_available: true },
    sections: {
      cost: {
        key: "cost",
        title: "Cost drivers",
        target_label: "High-cost sessions",
        description: "",
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
          baseline_rate: 0.25,
          subgroup_rate: 0.5,
          subgroup_rate_low: 0.22,
          lift: 2,
          score: 1,
          examples: [],
        }],
      },
    },
  });
});

describe("DiscoverPage", () => {
  it("renders the active ready technique", async () => {
    renderPage("subgroup");
    expect(await screen.findByRole("heading", { name: "What drives high-cost sessions?" })).toBeInTheDocument();
  });

  it("falls back to the default technique for an unregistered key", async () => {
    renderPage("sequence");
    expect(
      await screen.findByRole("heading", { name: "What drives high-cost sessions?" }),
    ).toBeInTheDocument();
  });
});
