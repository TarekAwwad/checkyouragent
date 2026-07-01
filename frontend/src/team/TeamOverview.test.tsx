import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamOverview from "./TeamOverview";

vi.mock("../api/client", () => ({ getTeamDashboard: vi.fn() }));

import { getTeamDashboard } from "../api/client";

const dashboard = {
  meta: { bundle_count: 2, member_count: 3, project_count: 4, session_count: 9, date_from: "2026-06-01", date_to: "2026-06-05" },
  tokens: { input: 12_000, output: 5_000, base: 0, cache_5m: 0, cache_1h: 0, cache_read: 0, total: 27_000 },
  stats: { errors: 7, loops: 2 },
  providers: [{ provider: "claude", session_count: 9 }],
  models: [
    { model: "opus", session_count: 6 },
    { model: "sonnet", session_count: 3 },
  ],
  stop_reasons: [],
  risk_categories: [
    { category: "cost_context_blowup", session_count: 5 },
    { category: "permission_friction", session_count: 3 },
  ],
  subagents: [],
  sequence: [{ sym: "CALL:inspect:Read", count: 4 }],
  members: [],
  over_time: [
    { date: "2026-06-01", session_count: 4, tokens: 12_000 },
    { date: "2026-06-05", session_count: 5, tokens: 15_000 },
  ],
};

function renderOverview(onGoToImport = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TeamOverview onGoToImport={onGoToImport} />
    </QueryClientProvider>,
  );
  return onGoToImport;
}

describe("TeamOverview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a loading state while the dashboard loads", () => {
    vi.mocked(getTeamDashboard).mockReturnValue(new Promise(() => undefined) as never);
    renderOverview();
    expect(screen.getByText(/Loading team overview/i)).toBeInTheDocument();
  });

  it("shows an error state when the dashboard fails", async () => {
    vi.mocked(getTeamDashboard).mockRejectedValue(new Error("boom") as never);
    renderOverview();
    expect(await screen.findByText(/Team overview unavailable/i)).toBeInTheDocument();
  });

  it("prompts for an import when there are no team bundles", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({
      ...dashboard,
      meta: { ...dashboard.meta, session_count: 0, bundle_count: 0 },
    } as never);
    const onGoToImport = renderOverview();

    expect(await screen.findByText(/No team bundles imported yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Go to Import/i }));
    expect(onGoToImport).toHaveBeenCalled();
  });

  it("renders totals, activity, risk, model mix, and symbols", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(dashboard as never);
    renderOverview();

    const totals = await screen.findByLabelText("Team totals");
    expect(within(totals).getByText("Members").closest(".contribute-metric")).toHaveTextContent("3");
    expect(within(totals).getByText("Projects").closest(".contribute-metric")).toHaveTextContent("4");
    expect(within(totals).getByText("Sessions").closest(".contribute-metric")).toHaveTextContent("9");
    expect(within(totals).getByText("Tokens").closest(".contribute-metric")).toHaveTextContent("27k");

    expect(screen.getByRole("img", { name: "Activity over time" })).toBeInTheDocument();

    const risk = screen.getByLabelText("Team risk patterns");
    expect(within(risk).getByText(/cost context blowup/i)).toBeInTheDocument();
    expect(within(risk).getByText(/permission friction/i)).toBeInTheDocument();

    const modelMix = screen.getByLabelText("Team model mix");
    expect(within(modelMix).getByText("opus")).toBeInTheDocument();
    expect(within(modelMix).getByText("sonnet")).toBeInTheDocument();

    expect(screen.getByText(/Read/)).toHaveTextContent("x4");
  });
});
