import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamBundleExport from "./TeamBundleExport";

vi.mock("../api/client", () => ({
  getRuntimeConfig: vi.fn(),
  getTeamPreview: vi.fn(),
  getTeamProjects: vi.fn(),
  exportTeamBundle: vi.fn(),
}));

import { exportTeamBundle, getRuntimeConfig, getTeamPreview, getTeamProjects } from "../api/client";

const previewPayload = {
  manifest: {
    privacy_level: "structural",
    session_count: 3,
    sequence_step_count: 3,
    included_fields: ["Token counts + cache breakdown"],
    excluded: ["Prompts and your messages", "File paths"],
    fingerprint_caveat: "Local team bundles are structural fingerprints.",
  },
  bundle: { sessions: [{ sid: "s-a", models: ["claude-opus-4-8"], sequence: [] }] },
};

const projectsPayload = {
  projects: [
    { export_name: "d--Alpha", default_label: "alpha", session_count: 2, tokens: 1200 },
    { export_name: "d--Beta", default_label: "beta", session_count: 1, tokens: 300 },
  ],
  prefs: {},
};

function renderExport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TeamBundleExport />
    </QueryClientProvider>,
  );
}

describe("TeamBundleExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRuntimeConfig).mockResolvedValue({
      import_root: "D:\\Data",
      team_bundle_root: "D:\\TeamBundles",
      database_path: "D:\\Data\\ccfr.sqlite3",
      is_docker: false,
    } as never);
    vi.mocked(getTeamProjects).mockResolvedValue(projectsPayload as never);
    vi.mocked(getTeamPreview).mockResolvedValue(previewPayload as never);
    vi.mocked(exportTeamBundle).mockResolvedValue({
      path: "D:\\TeamBundles\\team-bundle-a.json",
      bundle_id: "bundle-a",
      session_count: 3,
    } as never);
  });

  it("renders the level ladder with structural active and future rungs disabled", async () => {
    renderExport();
    const structural = await screen.findByRole("radio", { name: "Structural" });
    expect(structural).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Team" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: /Sessions/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Raw/ })).toBeDisabled();
  });

  it("defaults every project to selected and exports a structural bundle without a name", async () => {
    renderExport();
    const exportBtn = await screen.findByRole("button", { name: /Export bundle/i });
    await waitFor(() => expect(exportBtn).toBeEnabled());
    fireEvent.click(exportBtn);

    await waitFor(() => expect(exportTeamBundle).toHaveBeenCalledTimes(1));
    const body = vi.mocked(exportTeamBundle).mock.calls[0][0];
    expect(body.privacy_level).toBe("structural");
    expect(body.member_name).toBeNull();
    expect(body.projects.map((p) => p.export_name)).toEqual(["d--Alpha", "d--Beta"]);
    expect(await screen.findByText(/team-bundle-a\.json/)).toBeInTheDocument();
  });

  it("requires a member name at the team level", async () => {
    renderExport();
    fireEvent.click(await screen.findByRole("radio", { name: "Team" }));
    const exportBtn = screen.getByRole("button", { name: /Export bundle/i });
    await waitFor(() => expect(exportBtn).toBeDisabled());
    expect(screen.getByText(/Enter your name to export a team-level bundle/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Team member name"), { target: { value: "Avery" } });
    await waitFor(() => expect(exportBtn).toBeEnabled());
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportTeamBundle).toHaveBeenCalled());
    const body = vi.mocked(exportTeamBundle).mock.calls[0][0];
    expect(body.privacy_level).toBe("team");
    expect(body.member_name).toBe("Avery");
  });

  it("drops deselected projects from the export body", async () => {
    renderExport();
    fireEvent.click(await screen.findByLabelText("Include beta"));
    const exportBtn = screen.getByRole("button", { name: /Export bundle/i });
    await waitFor(() => expect(exportBtn).toBeEnabled());
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportTeamBundle).toHaveBeenCalled());
    const body = vi.mocked(exportTeamBundle).mock.calls[0][0];
    expect(body.projects.map((p) => p.export_name)).toEqual(["d--Alpha"]);
  });

  it("sends edited labels committed on blur", async () => {
    renderExport();
    fireEvent.click(await screen.findByRole("radio", { name: "Team" }));
    const label = await screen.findByLabelText("Label for alpha");
    fireEvent.change(label, { target: { value: "Payments API" } });
    fireEvent.blur(label);
    fireEvent.change(screen.getByLabelText("Team member name"), { target: { value: "Avery" } });

    const exportBtn = screen.getByRole("button", { name: /Export bundle/i });
    await waitFor(() => expect(exportBtn).toBeEnabled());
    fireEvent.click(exportBtn);
    await waitFor(() => expect(exportTeamBundle).toHaveBeenCalled());
    const body = vi.mocked(exportTeamBundle).mock.calls[0][0];
    expect(body.projects.find((p) => p.export_name === "d--Alpha")?.label).toBe("Payments API");
  });

  it("prefills level, name, and deselection from persisted prefs", async () => {
    vi.mocked(getTeamProjects).mockResolvedValue({
      ...projectsPayload,
      prefs: { member_name: "Avery", privacy_level: "team", deselected: ["d--Beta"], project_labels: {} },
    } as never);
    renderExport();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Team" })).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByLabelText("Team member name")).toHaveValue("Avery");
    expect(screen.getByLabelText("Include beta")).not.toBeChecked();
  });

  it("never sends a member name in a structural export after a team prefill", async () => {
    // A returning user whose last export was team-level has a persisted name in prefs.
    vi.mocked(getTeamProjects).mockResolvedValue({
      ...projectsPayload,
      prefs: { member_name: "Avery", privacy_level: "team", deselected: [], project_labels: {} },
    } as never);
    renderExport();
    // Prefilled to team; the name field is visible and holds "Avery"...
    await waitFor(() => expect(screen.getByRole("radio", { name: "Team" })).toHaveAttribute("aria-checked", "true"));
    // ...then they drop back to Structural, where the name field is no longer rendered.
    fireEvent.click(screen.getByRole("radio", { name: "Structural" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Structural" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.queryByLabelText("Team member name")).not.toBeInTheDocument();

    const exportBtn = screen.getByRole("button", { name: /Export bundle/i });
    await waitFor(() => expect(exportBtn).toBeEnabled());
    fireEvent.click(exportBtn);

    await waitFor(() => expect(exportTeamBundle).toHaveBeenCalled());
    const body = vi.mocked(exportTeamBundle).mock.calls[0][0];
    // A structural bundle must never carry a name, even one left over from prefs.
    expect(body.privacy_level).toBe("structural");
    expect(body.member_name).toBeNull();
  });

  it("disables export when the selection has no sessions", async () => {
    vi.mocked(getTeamPreview).mockResolvedValue({
      manifest: { ...previewPayload.manifest, session_count: 0 },
      bundle: { sessions: [] },
    } as never);
    renderExport();
    const exportBtn = await screen.findByRole("button", { name: /Export bundle/i });
    await waitFor(() => expect(exportBtn).toBeDisabled());
    expect(screen.getByText(/No sessions in the current selection/i)).toBeInTheDocument();
  });
});
