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
      usage_at_hit: 76.2, occurrence_count: 2, window_index: 0,
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
      near_miss_count: 0, cap_percentile: 0.5, usage_at_hit_usd: [76.2],
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
  it("renders the stat tiles and the measured cap", async () => {
    renderPage();
    expect(await screen.findByText("limit hits")).toBeInTheDocument();
    expect(screen.getByText("$76.2")).toBeInTheDocument();
    expect(screen.getByText(/Max 5x cap, median/)).toBeInTheDocument();
    expect(screen.getByText(/hits\/week, last 28 days/)).toBeInTheDocument();
  });

  it("shows the windows timeline and opens the hit detail on click", async () => {
    const onOpenSession = renderPage();
    await screen.findByText("limit hits");
    expect(screen.getByRole("img", { name: "5-hour windows timeline" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /window 1/i }));
    expect(await screen.findByText(/session limit/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Ship the release/ }));
    expect(onOpenSession).toHaveBeenCalledWith(7);
  });

  it("shows the cap zone strip per era", async () => {
    renderPage();
    await screen.findByText("limit hits");
    expect(screen.getByText(/1 session hits/)).toBeInTheDocument();
    expect(screen.getByText(/cap at p50 of windows/)).toBeInTheDocument();
  });

  it("shows the headroom message when no session hits exist", () => {
    render(<CapZones eras={[{
      era: "", window_count: 1, session_hit_count: 0, blocked_minutes: 0,
      cap_median_usd: null, cap_min_usd: null, cap_max_usd: null,
      near_miss_count: 0, cap_percentile: null, usage_at_hit_usd: [],
    }]} />);
    expect(screen.getByText(/That is headroom/)).toBeInTheDocument();
  });

  it("edits plan history through the modal and saves it to settings", async () => {
    renderPage();
    await screen.findByText("limit hits");
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
});
