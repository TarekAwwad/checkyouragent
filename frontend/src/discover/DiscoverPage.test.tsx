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
    meta: { project_id: null, min_support: 5, total_sessions: 0, cost_available: false },
    sections: {
      cost: { key: "cost", title: "Cost drivers", target_label: "High-cost sessions", description: "", available: true, unavailable_reason: null, baseline_count: 0, positive_count: 0, results: [] },
    },
  });
});

describe("DiscoverPage", () => {
  it("renders the active ready technique", async () => {
    renderPage("subgroup");
    expect(await screen.findByRole("heading", { name: "What drives high-cost sessions?" })).toBeInTheDocument();
  });

  it("renders a coming-soon placeholder for a soon technique", () => {
    renderPage("sequence");
    expect(screen.getByText("Sequence mining")).toBeInTheDocument();
    expect(screen.getByText("This discovery technique isn't available yet.")).toBeInTheDocument();
    expect(getDiscoveryAnalytics).not.toHaveBeenCalled();
  });
});
