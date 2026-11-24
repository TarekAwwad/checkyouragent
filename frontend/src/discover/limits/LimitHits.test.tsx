import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LimitsResponse, Project } from "../../api/types";
import CapZones from "./CapZones";
import LimitHits from "./LimitHits";
import WindowsTimeline from "./WindowsTimeline";

const payload: LimitsResponse = {
  meta: {
    window: { date_from: null, date_to: null },
    cost_available: true,
    costs_partial: false,
    total_hits: 1,
    total_windows: 2,
    minutes_until_reset: 49.3,
    hits_per_week_recent: 0.25,
    hit_counts: { session: 1 },
    plan_history: [{ plan: "Max 5x", start_date: "2026-06-10" }],
    method_note: "Account-level view: dollars are API-equivalent value.",
  },
  hits: [
    {
      ts: "2026-07-03T09:40:44+00:00", kind: "session",
      reset_at: "2026-07-03T10:30:00+00:00", minutes_until_reset: 49.3,
      usage_at_hit: 76.2, usage_at_hit_tokens: 900000,
      occurrence_count: 2, window_index: 0,
      session_ids: [7], session_titles: ["Ship the release"],
    },
  ],
  windows: [
    { start: "2026-07-03T08:00:00+00:00", end: "2026-07-03T10:30:00+00:00",
      value_usd: 76.2, tokens: 900000, era: "Max 5x", era_index: 0,
      hit_kinds: ["session"] },
    { start: "2026-07-03T14:00:00+00:00", end: "2026-07-03T19:00:00+00:00",
      value_usd: 12.5, tokens: 150000, era: "Max 5x", era_index: 0,
      hit_kinds: [] },
  ],
  eras: [
    {
      era: "Max 5x", window_count: 2, session_hit_count: 1, minutes_until_reset: 49.3,
      hit_level_median_usd: 76.2, hit_level_min_usd: 76.2, hit_level_max_usd: 76.2,
      hit_level_median_tokens: 900000,
      hit_level_min_tokens: 900000,
      hit_level_max_tokens: 900000,
      hit_level_percentile: 0.5, hit_level_percentile_tokens: 0.95,
      usage_at_hit_usd: [76.2], usage_at_hit_tokens: [900000],
      start_date: "2026-06-10", end_date: null, weeks: 1, hits_per_week: 1,
    },
  ],
};

type Era = LimitsResponse["eras"][number];

function periodEra(overrides: Partial<Era>): Era {
  return {
    ...payload.eras[0], era: "Pro", window_count: 1, session_hit_count: 1,
    usage_at_hit_usd: [10], usage_at_hit_tokens: [1000],
    hit_level_median_usd: 10, hit_level_min_usd: 10, hit_level_max_usd: 10,
    hit_level_median_tokens: 1000, hit_level_min_tokens: 1000, hit_level_max_tokens: 1000,
    ...overrides,
  };
}

// Pro -> Max -> Pro where Max left no logged windows: the two Pro periods
// sit next to each other in the window list but are still two periods.
const twoProPeriods: Era[] = [
  periodEra({ start_date: "2026-05-01", end_date: "2026-06-01", weeks: 4, hits_per_week: 2 }),
  periodEra({ start_date: "2026-07-01", end_date: null, weeks: 4, hits_per_week: 0.5,
              usage_at_hit_usd: [30], hit_level_median_usd: 30,
              hit_level_min_usd: 30, hit_level_max_usd: 30 }),
];

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
    expect(await screen.findByText("Time remaining until recorded reset")).toBeInTheDocument();
    expect(screen.getByText("Recorded session-hit windows")).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(screen.queryByText("Time blocked")).not.toBeInTheDocument();
    expect(screen.queryByText("Hits per week")).not.toBeInTheDocument();
    expect(screen.queryByText("Max 5x cap")).not.toBeInTheDocument();
  });

  it("shows the windows timeline with its legend and opens the hit detail on click", async () => {
    const onOpenSession = renderPage();
    await screen.findByText("Time remaining until recorded reset");
    expect(screen.getByRole("img", { name: /5-hour windows timeline/ })).toBeInTheDocument();
    expect(screen.getByText("window usage")).toBeInTheDocument();
    expect(screen.getByText("recorded session-limit hit")).toBeInTheDocument();
    expect(screen.getByText("1.0 hits/wk")).toBeInTheDocument();
    expect(screen.getByText(/x-axis: window start date/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /window 1/i }));
    expect(await screen.findByText(/session limit/)).toBeInTheDocument();
    expect(screen.getByText("Time remaining until recorded reset: 0.8h"))
      .toBeInTheDocument();
    expect(screen.getByText("seen 2 times")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ship the release/ }));
    expect(onOpenSession).toHaveBeenCalledWith(7);
  });

  it("shows observed hit-level metrics with sample and inferred basis", async () => {
    renderPage();
    await screen.findByText("Time remaining until recorded reset");
    expect(screen.getByRole("heading", { name: "Visible usage at recorded hit" }))
      .toBeInTheDocument();
    expect(screen.getByText(/sample: 1 recorded session hit/)).toBeInTheDocument();
    expect(screen.getByText(/median \$76\.2/)).toBeInTheDocument();
    expect(screen.getByText(/range \$76\.2.*\$76\.2/)).toBeInTheDocument();
    expect(screen.getByText(/Observed hit-level percentile p50/)).toBeInTheDocument();
    expect(screen.getByText(/inferred from 2 reconstructed windows/)).toBeInTheDocument();
    expect(screen.getByText("observed min–max range")).toBeInTheDocument();
    expect(screen.queryByText(/avg/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/near-miss/i)).not.toBeInTheDocument();
    expect(screen.getByText(/x-axis: window usage/)).toBeInTheDocument();
  });

  it("switches every usage display and percentile to token volume", async () => {
    renderPage();
    await screen.findByText("Time remaining until recorded reset");
    expect(screen.getByRole("button", { name: "Cost" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));

    expect(screen.getByText("tokens per window")).toBeInTheDocument();
    expect(screen.getByText(/median 900k tok/)).toBeInTheDocument();
    expect(screen.getByText(/Observed hit-level percentile p95/)).toBeInTheDocument();
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

  it("does not render an automatic plan-fit verdict", async () => {
    renderPage();
    await screen.findByText("Time remaining until recorded reset");
    expect(screen.queryByText(
      /comfortably dimensioned|plan fits|well dimensioned|outgrown|headroom|watch the trend/i,
    )).not.toBeInTheDocument();
  });

  it("uses the exact neutral empty state when no session hit was recorded", () => {
    render(<CapZones basis="cost" eras={[{
      era: "", window_count: 1, session_hit_count: 0, minutes_until_reset: 0,
      hit_level_median_usd: null, hit_level_min_usd: null, hit_level_max_usd: null,
      hit_level_median_tokens: null,
      hit_level_min_tokens: null,
      hit_level_max_tokens: null,
      hit_level_percentile: null, hit_level_percentile_tokens: null,
      usage_at_hit_usd: [], usage_at_hit_tokens: [],
      start_date: null, end_date: null, weeks: 1, hits_per_week: 0,
    }]} />);
    expect(screen.getByText(
      "No recorded session-limit hit was found in the available logs.",
    )).toBeInTheDocument();
  });

  it("draws one axis tick when the observed hit level sits at zero usage", () => {
    render(<CapZones basis="cost" eras={[{
      era: "Pro", window_count: 3, session_hit_count: 1, minutes_until_reset: 20,
      hit_level_median_usd: 0, hit_level_min_usd: 0, hit_level_max_usd: 0,
      hit_level_median_tokens: 0,
      hit_level_min_tokens: 0,
      hit_level_max_tokens: 0,
      hit_level_percentile: null, hit_level_percentile_tokens: null,
      usage_at_hit_usd: [0], usage_at_hit_tokens: [0],
      start_date: null, end_date: null, weeks: 1, hits_per_week: 0,
    }]} />);
    // A zero max used to yield ticks [0, 0, 0]: three labels stacked at the
    // same x, and three React children sharing the key 0.
    expect(screen.getAllByText("$0")).toHaveLength(1);
  });

  it("keeps a repeated plan as separate timeline bands, each with its own rate", () => {
    const windows = [
      { start: "2026-05-05T08:00:00+00:00", end: "2026-05-05T13:00:00+00:00",
        value_usd: 10, tokens: 1000, era: "Pro", era_index: 0, hit_kinds: ["session"] },
      { start: "2026-07-05T08:00:00+00:00", end: "2026-07-05T13:00:00+00:00",
        value_usd: 30, tokens: 3000, era: "Pro", era_index: 1, hit_kinds: ["session"] },
    ];
    const { container } = render(
      <WindowsTimeline windows={windows} eras={twoProPeriods}
                       basis="cost" selected={null} onSelectWindow={vi.fn()} />,
    );
    expect(container.querySelectorAll(".limit-era-band")).toHaveLength(2);
    // The first period is one bar wide: its label would sit under the next
    // one's, so it stays off the plot and moves to the bar tooltip.
    expect(screen.getAllByText("Pro")).toHaveLength(1);
    expect(screen.getByText("0.5 hits/wk")).toBeInTheDocument();
    expect(screen.queryByText("2.0 hits/wk")).not.toBeInTheDocument();
    fireEvent.mouseMove(screen.getByRole("button", { name: /window 1/ }));
    expect(screen.getByText(/^plan: Pro · .+ – /)).toBeInTheDocument();
    expect(screen.getByText("2.0 hits/wk in this plan period")).toBeInTheDocument();
  });

  it("gives each plan period its own hit-level row, labelled by its dates", () => {
    // Structure, not month names: the formatter follows the runtime locale
    // and adds a year once the dates are not in the current one.
    const { container } = render(<CapZones basis="cost" eras={twoProPeriods} />);
    const heads = [...container.querySelectorAll(".limit-zone-head strong")]
      .map((el) => el.textContent);
    expect(heads).toHaveLength(2);
    expect(heads[0]).toMatch(/^Pro · .+ – .+/);
    expect(heads[1]).toMatch(/^Pro · since .+/);
    expect(screen.getByText(/2\.0 hits\/wk · median \$10/)).toBeInTheDocument();
    expect(screen.getByText(/0\.5 hits\/wk · median \$30/)).toBeInTheDocument();
  });

  it("lists a plan period without recorded hits instead of hiding it", () => {
    const quiet = periodEra({
      start_date: "2026-08-11", end_date: null, window_count: 45, weeks: 15.08,
      session_hit_count: 0, hits_per_week: 0, usage_at_hit_usd: [], usage_at_hit_tokens: [],
      hit_level_median_usd: null, hit_level_min_usd: null, hit_level_max_usd: null,
      hit_level_median_tokens: null, hit_level_min_tokens: null, hit_level_max_tokens: null,
      hit_level_percentile: null, hit_level_percentile_tokens: null,
    });
    const { container } = render(
      <CapZones basis="cost" eras={[twoProPeriods[0], { ...quiet, era: "Pro" }]} />,
    );
    expect(container.querySelectorAll(".limit-zone-row")).toHaveLength(2);
    // The quiet period keeps an empty lane on the shared scale, so the axis
    // below never reads as belonging to a row without a strip.
    expect(container.querySelectorAll(".limit-zone-strip")).toHaveLength(2);
    expect(container.querySelectorAll(".limit-zone-dot")).toHaveLength(1);
    expect(screen.getByRole("img", { name: /^Pro \(since .+\) no recorded session hits$/ }))
      .toBeInTheDocument();
    expect(screen.getByText(
      "no recorded session hits · 45 reconstructed windows over 15.1 weeks",
    )).toBeInTheDocument();
  });

  it("edits plan history through the modal and saves it to settings", async () => {
    renderPage();
    await screen.findByText("Time remaining until recorded reset");
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
    await screen.findByText("Time remaining until recorded reset");
    fireEvent.click(screen.getByRole("button", { name: "Plan history" }));
    expect(await screen.findByRole("dialog", { name: "Plan history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add plan" })).toBeDisabled();
  });
});
