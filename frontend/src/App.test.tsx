import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import * as client from "./api/client";
import type { SessionCard } from "./api/types";

vi.mock("./api/client", () => ({
  listImports: vi.fn(async () => []),
  listProjects: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  discoverSourceProjects: vi.fn(async () => []),
  getSettings: vi.fn(async () => ({ historical_pricing: true, privacy_mode: false })),
  updateSettings: vi.fn(async (s: { historical_pricing: boolean; privacy_mode: boolean }) => s),
  getTeamProjects: vi.fn(async () => ({ projects: [], prefs: {} })),
  getTeamPreview: vi.fn(async () => ({
    manifest: {
      session_count: 0,
      sequence_step_count: 0,
      included_fields: [],
      excluded: [],
      fingerprint_caveat: "Local team bundles are structural fingerprints.",
    },
    bundle: { sessions: [] },
  })),
  exportTeamBundle: vi.fn(async () => ({ path: "/srv/team-bundles/team-bundle.json", bundle_id: "bundle", session_count: 0 })),
  importTeamBundle: vi.fn(async () => ({ bundle_id: "bundle", member_id: "member", session_count: 0, imported: true })),
  importTeamBundleFile: vi.fn(async () => ({ bundle_id: "bundle", member_id: "member", imported: true, session_count: 0 })),
  listTeamImports: vi.fn(async () => []),
  getTeamDashboard: vi.fn(async () => ({
    meta: { bundle_count: 0, member_count: 0, project_count: 0, session_count: 0, date_from: null, date_to: null },
    tokens: { input: 0, output: 0, base: 0, cache_5m: 0, cache_1h: 0, cache_read: 0, total: 0 },
    stats: {},
    providers: [],
    models: [],
    stop_reasons: [],
    risk_categories: [],
    subagents: [],
    members: [],
    over_time: [],
    sequence: [],
  })),
  getRuntimeConfig: vi.fn(async () => ({
    app_version: "9.8.7",
    import_root: "/srv/Data",
    team_bundle_root: "/srv/team-bundles",
    database_path: "/srv/ccfr.sqlite3",
    is_docker: false,
  })),
  getCacheStats: vi.fn(async () => ({
    project_count: 0, session_count: 0, event_count: 0,
    subagent_count: 0, persisted_output_count: 0,
    observed_date_from: null, observed_date_to: null,
    last_successful_sync_at: null, latest_import_error_count: 0,
  })),
  getImportProgress: vi.fn(async () => ({
    active: false, import_id: null, project_count: 0, session_count: 0,
    event_count: 0, subagent_count: 0, persisted_output_count: 0,
  })),
  getCostAnalytics: vi.fn(async () => ({
    meta: { available: false, unpriced_models: [], costs_partial: false, costs_are_lower_bound: false, total_usd: 0, total_tokens: 0,
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
    meta: {
      project_id: null, min_support: 5, total_sessions: 12, total_tool_calls: 34,
      cost_available: true, unpriced_models: [],
    },
    sections: {
      cost_associations: {
        key: "cost_associations", title: "Cost associations", target_label: "High estimated API-equivalent cost",
        description: "", observation_unit: "session", available: true, unavailable_reason: null,
        baseline_count: 12, positive_count: 3, results: [{
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
        key: "tool_error_associations", title: "Tool-error associations", target_label: "Recorded tool error",
        description: "", observation_unit: "tool_call", available: true, unavailable_reason: null,
        baseline_count: 34, positive_count: 2, results: [],
      },
    },
  })),
}));

vi.mock("./pages/SessionWorkspace", () => ({
  default: ({
    backLabel,
    historical,
    initialEventId,
    onBack,
  }: {
    backLabel?: string;
    historical?: boolean;
    initialEventId?: number | null;
    onBack?: () => void;
  }) => (
    <main aria-label="Session workspace">
      {backLabel && onBack && (
        <button type="button" onClick={onBack}>
          {backLabel}
        </button>
      )}
      <span data-testid="session-historical-pricing">{String(historical)}</span>
      <span data-testid="session-initial-event">{initialEventId ?? "none"}</span>
    </main>
  ),
}));

vi.mock("./analytics/CostAnalyticsPage", () => ({
  default: ({
    onOpenSession,
    historical,
    onHistoricalChange,
  }: {
    onOpenSession: (sessionId: number) => void;
    historical: boolean;
    onHistoricalChange: (value: boolean) => void;
  }) => (
    <main>
      <button type="button" onClick={() => onOpenSession(7)}>
        Open cost session
      </button>
      <label>
        <input
          type="checkbox"
          aria-label="Historical pricing"
          checked={historical}
          onChange={(event) => onHistoricalChange(event.target.checked)}
        />
        Historical pricing
      </label>
    </main>
  ),
}));

vi.mock("./discover/DiscoverPage", () => ({
  default: ({
    onOpenSession,
  }: {
    onOpenSession: (sessionId: number, eventId?: number | null) => void;
  }) => (
    <main>
      <h1>What drives usage patterns</h1>
      <button type="button" onClick={() => onOpenSession(7, 42)}>
        Open explore event
      </button>
    </main>
  ),
}));

function appSession(id: number): SessionCard {
  return {
    id,
    project_id: 1,
    project_name: "Example Project",
    session_id: "session-7",
    title: "App test session",
    first_ts: "2026-06-03T10:00:00Z",
    last_ts: "2026-06-03T10:22:00Z",
    cwd: "D:\\Code\\Claude-code-forensic",
    version: "1.2.3",
    entrypoint: "claude",
    git_branch: "feat/session-origin",
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

function mockImportedSession() {
  vi.mocked(client.listImports).mockResolvedValue([
    { import_id: 1, source_path: "/srv/Data" },
  ] as never);
  vi.mocked(client.listSessions).mockResolvedValue([appSession(7)] as never);
}

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.mocked(client.listImports).mockResolvedValue([] as never);
  vi.mocked(client.listProjects).mockResolvedValue([] as never);
  vi.mocked(client.listSessions).mockResolvedValue([] as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("App", () => {
  it("renders the import screen shell", async () => {
    renderApp();

    expect(await screen.findByText("Check Your Agent")).toBeInTheDocument();
    expect(await screen.findByLabelText("Check Your Agent version 9.8.7")).toHaveTextContent("v9.8.7");
    expect(await screen.findByText("Mounted source")).toBeInTheDocument();
  });

  it("lets you navigate back to Import after an import exists", async () => {
    vi.mocked(client.listImports).mockResolvedValue([
      { import_id: 1, source_path: "/srv/Data" },
    ] as never);

    renderApp();

    // With imports present, the app auto-advances to Sessions on first load.
    await waitFor(() => expect(screen.getByRole("button", { name: "Sessions" })).toHaveClass("active"));

    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    // The Import view must stick, not bounce back to Triage.
    expect(await screen.findByText("Projects in source")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toHaveClass("active"));
  });

  it("shows the Cost tab in the top nav", async () => {
    renderApp();
    expect(await screen.findByRole("button", { name: "Cost" })).toBeInTheDocument();
  });

  it("keeps historical pricing on the Cost page and persists it through settings", async () => {
    renderApp();
    expect(await screen.findByRole("button", { name: "Cost" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Historical pricing" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    const control = await screen.findByRole("checkbox", { name: "Historical pricing" });
    expect(control).toBeChecked();
    fireEvent.click(control);

    await waitFor(() => expect(vi.mocked(client.updateSettings).mock.calls.some(([settings]) => (
      settings.historical_pricing === false && settings.privacy_mode === false
    ))).toBe(true));
  });

  it("shows the Explore nav item and switches to the discovery view", async () => {
    renderApp();
    const tab = await screen.findByRole("button", { name: "Explore" });

    fireEvent.click(tab);

    await waitFor(() => expect(tab).toHaveClass("active"));
    // The technique subnav appears and the subgroup headline renders.
    expect(await screen.findByRole("button", { name: "Subgroups" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /What drives/ })).toBeInTheDocument();
  });

  it("switches to team scope and shows the team overview", async () => {
    renderApp();
    // Explore is a local-only view, present in the default (local) scope.
    expect(await screen.findByRole("button", { name: "Explore" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));

    // Team scope hides the drilldown-only views (Cost stays, Explore goes)...
    await waitFor(() => expect(screen.queryByRole("button", { name: "Explore" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Cost" })).toBeInTheDocument();
    // ...and Overview renders the team overview (empty in this mock).
    expect(await screen.findByText(/No team bundles imported yet/i)).toBeInTheDocument();
  });

  it("exposes a local-only Export view and a team-only bundle Import", async () => {
    renderApp();

    // Local scope: Export shares this machine's bundle.
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));
    expect(await screen.findByRole("heading", { name: /Export a team bundle/i })).toBeInTheDocument();

    // Team scope drops Export (nothing local to share) and the Import view
    // becomes the team-bundle importer, not the projects importer.
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Export" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("heading", { name: /Import a team bundle/i })).toBeInTheDocument();
    expect(screen.queryByText("Projects in source")).not.toBeInTheDocument();
  });

  it("returns from a session to the originating Sessions view", async () => {
    mockImportedSession();
    renderApp();

    fireEvent.click(await screen.findByText("App test session"));

    expect(screen.getByTestId("session-historical-pricing")).toHaveTextContent("true");

    fireEvent.click(await screen.findByRole("button", { name: "Back to Sessions" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Sessions" })).toHaveClass("active"));
    expect(await screen.findByText("App test session")).toBeInTheDocument();
  });

  it("adds sessions to browser history and restores the originating view on popstate", async () => {
    mockImportedSession();
    const pushState = vi.spyOn(window.history, "pushState");
    renderApp();

    fireEvent.click(await screen.findByText("App test session"));

    expect(pushState).toHaveBeenCalledWith(
      {
        cya: {
          view: "session",
          sessionId: 7,
          origin: "map",
          eventId: null,
        },
      },
      "",
      "#session/7",
    );

    window.dispatchEvent(new PopStateEvent("popstate", { state: { cya: { view: "map" } } }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Sessions" })).toHaveClass("active"));
    expect(await screen.findByText("App test session")).toBeInTheDocument();
  });

  it("uses Backspace as session Back only outside editable controls", async () => {
    mockImportedSession();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    renderApp();

    fireEvent.click(await screen.findByText("App test session"));
    fireEvent.keyDown(document.body, { key: "Backspace" });

    expect(back).toHaveBeenCalledTimes(1);

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "Backspace" });

    expect(back).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("returns from a session to the originating Cost view", async () => {
    mockImportedSession();
    renderApp();
    await screen.findByText("App test session");

    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open cost session" }));

    fireEvent.click(await screen.findByRole("button", { name: "Back to Cost" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Cost" })).toHaveClass("active"));
    expect(screen.getByRole("button", { name: "Open cost session" })).toBeInTheDocument();
  });

  it("returns from a deep-linked session to Explore and preserves the event focus", async () => {
    mockImportedSession();
    renderApp();
    await screen.findByText("App test session");

    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open explore event" }));

    expect(await screen.findByRole("button", { name: "Back to Explore" })).toBeInTheDocument();
    expect(screen.getByTestId("session-initial-event")).toHaveTextContent("42");

    fireEvent.click(screen.getByRole("button", { name: "Back to Explore" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Explore" })).toHaveClass("active"));
    expect(screen.getByRole("button", { name: "Open explore event" })).toBeInTheDocument();
  });

  it("opens the glossary modal from the sidebar help button", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Open glossary" }));

    expect(screen.getByRole("heading", { name: "Glossary" })).toBeInTheDocument();
    expect(screen.getByText("Subagent")).toBeInTheDocument();
  });

  it("shows the first-run glossary hint and dismisses it on 'Got it'", async () => {
    renderApp();

    expect(await screen.findByText("Not sure what a term means?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(screen.queryByText("Not sure what a term means?")).not.toBeInTheDocument();
    expect(localStorage.getItem("ccfr-glossary-hint-seen")).toBe("1");
  });

  it("retires the glossary hint once the glossary is opened", async () => {
    renderApp();

    fireEvent.click(await screen.findByRole("button", { name: "Open glossary" }));

    expect(screen.queryByText("Not sure what a term means?")).not.toBeInTheDocument();
    expect(localStorage.getItem("ccfr-glossary-hint-seen")).toBe("1");
  });

  it("hides the hint when it has already been seen", async () => {
    localStorage.setItem("ccfr-glossary-hint-seen", "1");
    renderApp();

    await screen.findByRole("button", { name: "Open glossary" });
    expect(screen.queryByText("Not sure what a term means?")).not.toBeInTheDocument();
  });
});
