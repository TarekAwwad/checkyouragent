import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";

vi.mock("./api/client", () => ({
  listImports: vi.fn(async () => []),
  listProjects: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  discoverSourceProjects: vi.fn(async () => []),
  getRuntimeConfig: vi.fn(async () => ({ import_root: "/srv/Data", database_path: "/srv/ccfr.sqlite3", is_docker: false })),
  getCacheStats: vi.fn(async () => ({
    project_count: 0, session_count: 0, event_count: 0,
    subagent_count: 0, memory_count: 0, persisted_output_count: 0,
  })),
  getImportProgress: vi.fn(async () => ({
    active: false, import_id: null, project_count: 0, session_count: 0,
    event_count: 0, subagent_count: 0, memory_count: 0, persisted_output_count: 0,
  })),
  getCostAnalytics: vi.fn(async () => ({
    meta: { available: false, unpriced_models: [], total_usd: 0, total_tokens: 0,
      available_projects: [], available_models: [], bucket: "day" },
    treemap: [], over_time: [],
    categories: { base_input: { tokens: 0, usd: 0 }, cache_write_5m: { tokens: 0, usd: 0 },
      cache_write_1h: { tokens: 0, usd: 0 }, cache_read: { tokens: 0, usd: 0 }, output: { tokens: 0, usd: 0 } },
    by_model: [],
    sessions: [],
    cache_economics: {
      observed_input_usd: 0, no_cache_input_usd: 0, net_savings_usd: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, by_model: [],
    },
    spikes: [],
  })),
  getDiscoveryAnalytics: vi.fn(async () => ({
    meta: { project_id: null, min_support: 5, total_sessions: 12, cost_available: true },
    sections: {
      cost: {
        key: "cost", title: "Cost drivers", target_label: "High-cost sessions",
        description: "", available: true, unavailable_reason: null,
        baseline_count: 12, positive_count: 3, results: [{
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
      fanout_cost: {
        key: "fanout_cost", title: "Fanout cost drivers", target_label: "High-cost sessions",
        description: "", available: false, unavailable_reason: "Price table unavailable.",
        baseline_count: 0, positive_count: 0, results: [],
      },
      tool_errors: {
        key: "tool_errors", title: "Tool error drivers", target_label: "Tool calls with errors",
        description: "", available: true, unavailable_reason: null,
        baseline_count: 0, positive_count: 0, results: [],
      },
      rejections: {
        key: "rejections", title: "Rejection drivers", target_label: "Rejected slices",
        description: "", available: true, unavailable_reason: null,
        baseline_count: 0, positive_count: 0, results: [],
      },
    },
  })),
}));

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.clearAllMocks());

describe("App", () => {
  it("renders the import screen shell", async () => {
    renderApp();

    expect(await screen.findByText("Claude Analytics")).toBeInTheDocument();
    expect(await screen.findByText("Mounted source")).toBeInTheDocument();
  });

  it("lets you navigate back to Import after an import exists", async () => {
    vi.mocked(client.listImports).mockResolvedValue([
      { import_id: 1, source_path: "/srv/Data" },
    ] as never);

    renderApp();

    // With imports present, the app auto-advances to Triage on first load.
    await waitFor(() => expect(screen.getByRole("button", { name: "Triage" })).toHaveClass("active"));

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    // The Import view must stick, not bounce back to Triage.
    expect(await screen.findByText("Projects in source")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toHaveClass("active"));
  });

  it("shows the Cost tab in the top nav", async () => {
    renderApp();
    expect(await screen.findByRole("button", { name: "Cost" })).toBeInTheDocument();
  });

  it("shows the Discover nav item and switches to the discovery view", async () => {
    renderApp();
    const tab = await screen.findByRole("button", { name: "Discover" });

    fireEvent.click(tab);

    await waitFor(() => expect(tab).toHaveClass("active"));
    // The technique subnav appears and the subgroup headline renders.
    expect(await screen.findByRole("button", { name: "Subgroups" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /What drives/ })).toBeInTheDocument();
  });

  it("opens the glossary modal from the sidebar help button", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Open glossary" }));

    expect(screen.getByRole("heading", { name: "Glossary" })).toBeInTheDocument();
    expect(screen.getByText("Subagent")).toBeInTheDocument();
  });
});
