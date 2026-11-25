import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamOverview from "./TeamOverview";

vi.mock("../api/client", () => ({ getTeamDashboard: vi.fn() }));

import { getTeamDashboard } from "../api/client";

const dashboard = {
  meta: { bundle_count: 2, member_count: 3, project_count: 4, session_count: 9, date_from: "2026-06-01", date_to: "2026-06-05" },
  tokens: { input: 12_000, output: 5_000, base: 0, cache_5m: 0, cache_1h: 0, cache_read: 0, total: 27_000 },
  stats: { errors: 7, turns: 18, tool_calls: 24, loops: 2, max_repeat: 5 },
  reliability: { error_count: 7, session_count: 9, errors_per_session: 7 / 9 },
  providers: [{ provider: "claude", session_count: 9 }],
  models: [
    { model: "opus", tokens: 18_000 },
    { model: "sonnet", tokens: 9_000 },
  ],
  stop_reasons: [],
  // Legacy fields deliberately remain in this fixture: the Overview must not
  // render them even while v1/v2 bundle readers still accept them.
  risk_categories: [
    { category: "cost_context_blowup", session_count: 5 },
    { category: "permission_friction", session_count: 3 },
  ],
  subagents: [],
  sequence: [{ sym: "CALL:inspect:Read", count: 4 }],
  members: [
    { member_name: "Avery", member_ids: ["1111"], bundle_count: 1, project_count: 1, session_count: 3, tokens: 900, error_count: 6, errors_per_session: 2 },
    { member_name: "Morgan", member_ids: ["2222"], bundle_count: 1, project_count: 2, session_count: 6, tokens: 100, error_count: 1, errors_per_session: 1 / 6 },
  ],
  projects: [],
  tools: [],
  file_types: [],
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
    expect(screen.getByText(/aggregated activity and reliability/i)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/risk patterns/i);
    fireEvent.click(screen.getByRole("button", { name: /Go to Import/i }));
    expect(onGoToImport).toHaveBeenCalled();
  });

  it("renders normalized reliability and token-weighted model activity without deprecated inventory", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue(dashboard as never);
    renderOverview();

    const totals = await screen.findByLabelText("Team totals");
    expect(within(totals).getByText("Members").closest(".cost-insight")).toHaveTextContent("3");
    expect(within(totals).getByText("Projects").closest(".cost-insight")).toHaveTextContent("4");
    expect(within(totals).getByText("Sessions").closest(".cost-insight")).toHaveTextContent("9");
    expect(within(totals).getByText("Tokens").closest(".cost-insight")).toHaveTextContent("27k");

    expect(screen.getByRole("img", { name: "Token activity over time" })).toBeInTheDocument();

    const reliability = screen.getByLabelText("Recorded errors per session by member");
    expect(within(reliability).getByText("Avery")).toBeInTheDocument();
    expect(within(reliability).getByText("6 errors / 3 sessions")).toBeInTheDocument();
    expect(screen.getByText("7 errors / 9 sessions")).toBeInTheDocument();

    const modelMix = screen.getByLabelText("Team model token mix");
    expect(within(modelMix).getByText("opus")).toBeInTheDocument();
    expect(within(modelMix).getByText("sonnet")).toBeInTheDocument();
    expect(within(modelMix).getByText("18k")).toBeInTheDocument();

    expect(screen.queryByText("Risk patterns")).not.toBeInTheDocument();
    expect(screen.queryByText("Loops")).not.toBeInTheDocument();
    expect(screen.queryByText("Top sequence symbols")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/quality|poor performance/i);
  });

  it("renders member, project, toolchain, and file-type breakdowns", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({
      ...dashboard,
      members: [
        { member_name: "Avery", member_ids: ["1111"], bundle_count: 1, project_count: 1, session_count: 3, tokens: 900, error_count: 2, errors_per_session: 2 / 3 },
        { member_name: "member-2222abcd", member_ids: ["2222abcd"], bundle_count: 1, project_count: 1, session_count: 1, tokens: 100, error_count: 0, errors_per_session: 0 },
      ],
      projects: [
        { project_key: "alpha", project_name: "alpha", member_count: 2, session_count: 4, tokens: 1000 },
      ],
      tools: [{ name: "Read", call_count: 12, session_count: 3 }],
      file_types: [{ ext: "py", count: 9, session_count: 3 }],
    } as never);
    renderOverview();

    expect(await screen.findByText("Token volume by member")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Token volume by member")).getByText("Avery")).toBeInTheDocument();
    expect(screen.getByText("Token volume by project")).toBeInTheDocument();
    expect(screen.getByText("Toolchain")).toBeInTheDocument();
    expect(screen.getByText(".py")).toBeInTheDocument();
  });

  it("hides the toolchain row when no team-level bundles exist", async () => {
    vi.mocked(getTeamDashboard).mockResolvedValue({
      ...dashboard,
      members: [
        { member_name: "member-1111abcd", member_ids: ["1111abcd"], bundle_count: 1, project_count: 1, session_count: 3, tokens: 900, error_count: 0, errors_per_session: 0 },
      ],
      projects: [{ project_key: "a1b2c3d4", project_name: "a1b2c3d4", member_count: 1, session_count: 3, tokens: 900 }],
      tools: [],
      file_types: [],
    } as never);
    renderOverview();

    expect(await screen.findByText("Token volume by member")).toBeInTheDocument();
    expect(screen.queryByText("Toolchain")).not.toBeInTheDocument();
  });

  it("shows the header with a fixed scope while loading", () => {
    vi.mocked(getTeamDashboard).mockReturnValue(new Promise(() => undefined) as never);
    renderOverview();
    expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Scope" })).getByText("All projects")).toBeInTheDocument();
  });
});
