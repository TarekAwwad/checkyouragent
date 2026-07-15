import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LimitsResponse, Project } from "../../api/types";
import CapZones from "./CapZones";
import LimitHits from "./LimitHits";

const payload: LimitsResponse = {
  meta: {
    window: { date_from: null, date_to: null },
    cost_available: true,
    costs_partial: false,
    total_hits: 1,
    total_windows: 2,
    blocked_minutes: 49.3,
    hits_per_week_recent: 0.25,
    hit_counts: { session: 1 },
    plan_history: [{ plan: "Max 5x", start_date: "2026-06-10" }],
    method_note: "Account-level view: dollars are API-equivalent value.",
  },
  hits: [
    {
      ts: "2026-07-03T09:40:44+00:00", kind: "session",
      reset_at: "2026-07-03T10:30:00+00:00", blocked_minutes: 49.3,
      usage_at_hit: 76.2, usage_at_hit_tokens: 900000,
      occurrence_count: 2, window_index: 0,
      session_ids: [7], session_titles: ["Ship the release"],
    },
  ],
  windows: [
    { start: "2026-07-03T08:00:00+00:00", end: "2026-07-03T10:30:00+00:00",
      value_usd: 76.2, tokens: 900000, era: "Max 5x", hit_kinds: ["session"] },
    { start: "2026-07-03T14:00:00+00:00", end: "2026-07-03T19:00:00+00:00",
      value_usd: 12.5, tokens: 150000, era: "Max 5x", hit_kinds: [] },
  ],
  eras: [
    {
      era: "Max 5x", window_count: 2, session_hit_count: 1, blocked_minutes: 49.3,
      cap_median_usd: 76.2, cap_min_usd: 76.2, cap_max_usd: 76.2,
      cap_median_tokens: 900000, cap_min_tokens: 900000, cap_max_tokens: 900000,
      near_miss_count: 0, near_miss_count_tokens: 0,
      cap_percentile: 0.5, cap_percentile_tokens: 0.95,
      usage_at_hit_usd: [76.2], usage_at_hit_tokens: [900000],
    },
  ],
};

const updateSettingsMock = vi.fn((s) => Promise.resolve(s));
vi.mock("../../api/client", () => ({
  getLimits: vi.fn(() => Promise.resolve(payload)),
  getSettings: vi.fn(() =>
    Promise.resolve({ historical_pricing: true, privacy_mode: false, plan_history: [] })),
  updateSettings: (s: unknown) => updateSettingsMock(s),
}));

const projects: Project[] = [];

function renderPage(onOpenSession = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LimitHits projects={projects} onOpenSession={onOpenSession} />
    </QueryClientProvider>,
  );
  return onOpenSession;
}

describe("LimitHits", () => {
  it("renders the stat tiles without per-plan cards", async () => {
    renderPage();
    expect(await screen.findByText("Time blocked")).toBeInTheDocument();
    expect(screen.getByText("Capped windows")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 windows hit a cap")).toBeInTheDocument();
    expect(screen.queryByText("Hits per week")).not.toBeInTheDocument();
    expect(screen.queryByText("Max 5x cap")).not.toBeInTheDocument();
  });

  it("shows the windows timeline with its legend and opens the hit detail on click", async () => {
    const onOpenSession = renderPage();
    await screen.findByText("Time blocked");
    expect(screen.getByRole("img", { name: /5-hour windows timeline/ })).toBeInTheDocument();
    expect(screen.getByText("window usage")).toBeInTheDocument();
    expect(screen.getByText("limit hit")).toBeInTheDocument();
    expect(screen.getByText("1.0 hits/wk")).toBeInTheDocument();
    expect(screen.getByText(/x-axis: window start date/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /window 1/i }));
    expect(await screen.findByText(/session limit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ship the release/ }));
    expect(onOpenSession).toHaveBeenCalledWith(7);
  });

  it("shows the per-plan metrics on the cap zone rows", async () => {
    renderPage();
    await screen.findByText("Time blocked");
    expect(screen.getByText(/1 session hit\b/)).toBeInTheDocument();
    expect(screen.getByText(/median \$76\.2/)).toBeInTheDocument();
    expect(screen.getByText(/avg \$76\.2/)).toBeInTheDocument();
    expect(screen.getByText(/0\.8h blocked/)).toBeInTheDocument();
    expect(screen.getByText(/cap at p50 of windows/)).toBeInTheDocument();
    expect(screen.getByText("min-max cap zone")).toBeInTheDocument();
    expect(screen.getByText("avg hit")).toBeInTheDocument();
    expect(screen.getByText(/x-axis: window usage/)).toBeInTheDocument();
  });

  it("switches every usage display and percentile to token volume", async () => {
    renderPage();
    await screen.findByText("Time blocked");
    expect(screen.getByRole("button", { name: "Cost" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));

    expect(screen.getByText("tokens per window")).toBeInTheDocument();
    expect(screen.getByText(/median 900k tok/)).toBeInTheDocument();
    expect(screen.getByText(/cap at p95 of windows/)).toBeInTheDocument();
    expect(screen.getByText(/x-axis: window usage, token volume/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /window 1/i }));
    expect(await screen.findByText(/at 900k tok of window usage/)).toBeInTheDocument();
  });

  it("falls back to tokens when cost is unavailable", async () => {
    const { getLimits } = await import("../../api/client");
    vi.mocked(getLimits).mockResolvedValueOnce({
      ...payload,
      meta: { ...payload.meta, cost_available: false },
    });
    renderPage();

    await screen.findByText(/Price table unavailable/);
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute(
        "aria-pressed", "true",
      );
    });
    expect(screen.getByRole("button", { name: "Cost" })).toBeDisabled();
  });

  it("shows a verdict about the active plan", async () => {
    renderPage();
    await screen.findByText("Time blocked");
    expect(
      screen.getByText(/You hit the Max 5x cap about 1\.0 times a week/),
    ).toBeInTheDocument();
  });

  it("shows the headroom message when no session hits exist", () => {
    render(<CapZones basis="cost" eras={[{
      era: "", window_count: 1, session_hit_count: 0, blocked_minutes: 0,
      cap_median_usd: null, cap_min_usd: null, cap_max_usd: null,
      cap_median_tokens: null, cap_min_tokens: null, cap_max_tokens: null,
      near_miss_count: 0, near_miss_count_tokens: 0,
      cap_percentile: null, cap_percentile_tokens: null,
      usage_at_hit_usd: [], usage_at_hit_tokens: [],
    }]} />);
    expect(screen.getByText(/That is headroom/)).toBeInTheDocument();
  });

  it("draws one axis tick when the measured cap zone sits at zero usage", () => {
    render(<CapZones basis="cost" eras={[{
      era: "Pro", window_count: 3, session_hit_count: 1, blocked_minutes: 20,
      cap_median_usd: 0, cap_min_usd: 0, cap_max_usd: 0,
      cap_median_tokens: 0, cap_min_tokens: 0, cap_max_tokens: 0,
      near_miss_count: 0, near_miss_count_tokens: 0,
      cap_percentile: null, cap_percentile_tokens: null,
      usage_at_hit_usd: [0], usage_at_hit_tokens: [0],
    }]} />);
    // A zero max used to yield ticks [0, 0, 0]: three labels stacked at the
    // same x, and three React children sharing the key 0.
    expect(screen.getAllByText("$0")).toHaveLength(1);
  });

  it("edits plan history through the modal and saves it to settings", async () => {
    renderPage();
    await screen.findByText("Time blocked");
    fireEvent.click(screen.getByRole("button", { name: "Plan history" }));
    expect(await screen.findByRole("dialog", { name: "Plan history" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add plan" }));
    fireEvent.change(screen.getByLabelText("Plan name 1"), { target: { value: "Pro" } });
    fireEvent.change(screen.getByLabelText("Start date 1"), { target: { value: "2026-05-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(updateSettingsMock).toHaveBeenCalled());
    expect(updateSettingsMock.mock.calls[0][0]).toMatchObject({
      plan_history: [{ plan: "Pro", start_date: "2026-05-01" }],
    });
  });

  it("keeps Add plan disabled until the saved history has loaded", async () => {
    // A row added before the settings fetch resolves would be wiped by it.
    const { getSettings } = await import("../../api/client");
    vi.mocked(getSettings).mockImplementationOnce(() => new Promise(() => {}));
    renderPage();
    await screen.findByText("Time blocked");
    fireEvent.click(screen.getByRole("button", { name: "Plan history" }));
    expect(await screen.findByRole("dialog", { name: "Plan history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add plan" })).toBeDisabled();
  });
});
