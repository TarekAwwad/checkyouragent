import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { CostAnalyticsResponse, SessionCard } from "./api/types";

vi.mock("./api/client", () => ({
  getRuntimeConfig: vi.fn(), listProjects: vi.fn(), listSessions: vi.fn(), listTeamImports: vi.fn(),
  getSettings: vi.fn(), updateSettings: vi.fn(), getCostAnalytics: vi.fn(), getTeamCostAnalytics: vi.fn(),
  getSessionTurnCosts: vi.fn(),
}));

vi.mock("./pages/SessionWorkspace", () => ({
  default: ({ onBack, backLabel }: { onBack: () => void; backLabel: string }) => (
    <main aria-label="Session workspace"><button onClick={onBack}>{backLabel}</button></main>
  ),
}));

const opus = "claude-opus-4-8";
const sonnet = "claude-sonnet-4-6";
const payload: CostAnalyticsResponse = {
  meta: {
    available: true, unpriced_models: [], costs_partial: false, costs_are_lower_bound: false,
    total_usd: 20, total_tokens: 1000, bucket: "day",
    available_projects: [{ id: 1, name: "Example Project" }], available_models: [opus, sonnet],
  },
  treemap: [],
  over_time: [{
    bucket: "2026-05-02", per_model: { [opus]: 12, [sonnet]: 8 }, total_usd: 20,
    session_count: 2, priced_session_count: 2, unpriced_models: [], costs_are_lower_bound: false,
    baseline_usd: null, delta_usd: null, delta_pct: null, is_spike: false,
    sessions: [{ id: 7, session_id: "session-7", title: "Cost contributor", project_name: "Example Project", usd: 12, tokens: 600 }],
  }],
  categories: {
    base_input: { tokens: 1000, usd: 20 }, cache_write_5m: { tokens: 0, usd: 0 },
    cache_write_1h: { tokens: 0, usd: 0 }, cache_read: { tokens: 0, usd: 0 }, output: { tokens: 0, usd: 0 },
  },
  by_model: [opus, sonnet].map((model, index) => ({
    model, usd: index === 0 ? 12 : 8, tokens: 500, input_tokens: 500,
    output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, effective_usd_per_million: 0,
  })),
  sessions: [], spikes: [],
  cache_economics: { observed_input_usd: 20, no_cache_input_usd: 20, net_savings_usd: 0, cache_read_tokens: 0, cache_write_tokens: 0, by_model: [] },
};

function session(id: number, cost: number): SessionCard {
  return {
    id, project_id: 1, project_name: "Example Project", session_id: `session-${id}`,
    title: `Release review ${id}`, first_ts: "2026-05-02T00:00:00Z", last_ts: "2026-05-02T01:00:00Z",
    cwd: null, version: null, entrypoint: null, git_branch: null,
    event_count: 10, turn_count: 2, tool_call_count: 4, subagent_count: 0, error_count: 1,
    system_count: 0, persisted_output_count: 0, input_tokens: 500, output_tokens: 0,
    duration_seconds: 3600, max_agent_events: 0, finding_count: 0, top_finding_title: null,
    top_finding_basis: null, cost_usd: cost, cost_available: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.mocked(client.getRuntimeConfig).mockResolvedValue({ app_version: "0.4.0", import_root: "/demo", database_path: "/demo/cache.sqlite3", is_docker: false });
  vi.mocked(client.listProjects).mockResolvedValue([{ id: 1, export_name: "example", display_name: "Example Project", inferred_cwd: null, session_count: 2, event_count: 20, subagent_count: 0, cost_usd: 20, cost_available: true }]);
  vi.mocked(client.listSessions).mockResolvedValue([session(7, 12), session(8, 8)]);
  vi.mocked(client.listTeamImports).mockResolvedValue([{ id: 1, bundle_id: "bundle", member_id: "member", profile: "team", schema_version: 3, generated_at: "2026-05-02", imported_at: "2026-05-02", source_path: "/demo/bundle.json", session_count: 2 }]);
  vi.mocked(client.getSettings).mockResolvedValue({ historical_pricing: true, privacy_mode: false });
  vi.mocked(client.updateSettings).mockImplementation(async (settings) => settings as never);
  vi.mocked(client.getCostAnalytics).mockResolvedValue(payload);
  vi.mocked(client.getTeamCostAnalytics).mockResolvedValue(payload);
});

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);
  return { ...view, queryClient };
}

async function openCostSession() {
  fireEvent.click(await screen.findByRole("button", { name: /May 2, 2026.*2 sessions priced/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open session" }));
  await screen.findByRole("main", { name: "Session workspace" });
}

describe("investigation context", () => {
  it("restores Cost filters, preset, selected period, chart view, and scroll after app Back", async () => {
    const view = renderApp();
    await screen.findByRole("heading", { name: "Spend over time" });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-05-01" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: opus } });
    fireEvent.click(screen.getByRole("radio", { name: "Spend by model" }));
    fireEvent.click(screen.getByRole("button", { name: "Show only opus-4-8" }));
    const page = view.container.querySelector<HTMLElement>(".cost-page")!;
    page.scrollTop = 240;
    fireEvent.scroll(page);
    await openCostSession();

    fireEvent.click(screen.getByRole("button", { name: "Back to Cost" }));
    await screen.findByRole("heading", { name: "Spend over time" });
    expect(screen.getByLabelText("Date range")).toHaveValue("custom");
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-05-01");
    expect(screen.getByLabelText("Project")).toHaveValue("1");
    expect(screen.getByLabelText("Model")).toHaveValue(opus);
    expect(screen.getByRole("radio", { name: "Spend by model" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Show all models" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Sessions for May 2, 2026")).toBeInTheDocument();
    expect(view.container.querySelector<HTMLElement>(".cost-page")!.scrollTop).toBe(240);
  });

  it("restores Sessions search, project, error filter, sort, and table scroll after browser Back", async () => {
    const view = renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    await screen.findByText("Release review 7");
    fireEvent.change(screen.getByPlaceholderText("Search sessions"), { target: { value: "release review" } });
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "1" } });
    fireEvent.click(screen.getByLabelText("Errors only"));
    fireEvent.change(screen.getByLabelText("Sort sessions"), { target: { value: "cost_usd" } });
    const table = view.container.querySelector<HTMLElement>(".triage-table-wrap")!;
    table.scrollTop = 180;
    fireEvent.scroll(table);
    fireEvent.click(screen.getByText("Release review 7"));
    await screen.findByRole("main", { name: "Session workspace" });

    act(() => window.history.back());
    await screen.findByPlaceholderText("Search sessions");
    expect(screen.getByPlaceholderText("Search sessions")).toHaveValue("release review");
    expect(screen.getByLabelText("Project")).toHaveValue("1");
    expect(screen.getByLabelText("Errors only")).toBeChecked();
    expect(screen.getByLabelText("Sort sessions")).toHaveValue("cost_usd");
    expect(view.container.querySelector<HTMLElement>(".triage-table-wrap")!.scrollTop).toBe(180);
  });

  it("keeps local and team investigation filters separate across scope changes", async () => {
    renderApp();
    await screen.findByRole("heading", { name: "Spend over time" });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-05-01" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: opus } });
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    await waitFor(() => expect(screen.getByLabelText("Start date")).toHaveValue(""));
    expect(screen.getByLabelText("Model")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-05-02" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: sonnet } });
    fireEvent.click(screen.getByRole("button", { name: "This machine" }));
    await waitFor(() => expect(screen.getByLabelText("Start date")).toHaveValue("2026-05-01"));
    expect(screen.getByLabelText("Model")).toHaveValue(opus);
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    await waitFor(() => expect(screen.getByLabelText("Start date")).toHaveValue("2026-05-02"));
    expect(screen.getByLabelText("Model")).toHaveValue(sonnet);
  });

  it("waits for uncached Cost results before restoring scroll", async () => {
    const view = renderApp();
    await screen.findByRole("heading", { name: "Spend over time" });
    const page = view.container.querySelector<HTMLElement>(".cost-page")!;
    page.scrollTop = 300;
    fireEvent.scroll(page);
    await openCostSession();
    view.queryClient.removeQueries({ queryKey: ["cost-analytics"] });
    let finish!: (data: CostAnalyticsResponse) => void;
    vi.mocked(client.getCostAnalytics).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Cost" }));
    await screen.findByText("Loading cost analytics…");
    fireEvent.scroll(view.container.querySelector<HTMLElement>(".cost-page")!, { target: { scrollTop: 0 } });
    await act(async () => finish(payload));
    await waitFor(() => expect(view.container.querySelector<HTMLElement>(".cost-page")!.scrollTop).toBe(300));
  });

  it("clears stale context when the local index is reset", async () => {
    const view = renderApp();
    await screen.findByRole("heading", { name: "Spend over time" });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-05-01" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: opus } });
    await act(async () => { view.queryClient.setQueryData(["sessions", {}], []); });
    await waitFor(() => expect(screen.getByLabelText("Start date")).toHaveValue(""));
    expect(screen.getByLabelText("Model")).toHaveValue("");
    expect(screen.getByLabelText("Date range")).toHaveValue("all");
  });
});
