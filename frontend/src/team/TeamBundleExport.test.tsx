import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamBundleExport from "./TeamBundleExport";

vi.mock("../api/client", () => ({
  getRuntimeConfig: vi.fn(),
  getTeamPreview: vi.fn(),
  exportTeamBundle: vi.fn(),
}));

import { exportTeamBundle, getRuntimeConfig, getTeamPreview } from "../api/client";

const previewPayload = {
  manifest: {
    session_count: 2,
    sequence_step_count: 3,
    included_fields: ["Token counts + cache breakdown"],
    excluded: ["Prompts and your messages", "File paths"],
    fingerprint_caveat: "Local team bundles are structural fingerprints.",
  },
  bundle: { sessions: [{ sid: "s-a", models: ["claude-opus-4-8"], sequence: [] }] },
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
    vi.mocked(getTeamPreview).mockResolvedValue(previewPayload as never);
    vi.mocked(exportTeamBundle).mockResolvedValue({
      path: "D:\\TeamBundles\\team-bundle-a.json",
      bundle_id: "bundle-a",
      session_count: 2,
    } as never);
  });

  it("renders the export control, the root, and the privacy ledger — but no import controls", async () => {
    renderExport();

    expect(await screen.findByRole("heading", { name: /Export a team bundle/i })).toBeInTheDocument();
    expect(await screen.findByText("D:\\TeamBundles")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export bundle/i })).toBeInTheDocument();
    expect(await screen.findByText(/What stays vs. what goes into the team bundle/i)).toBeInTheDocument();

    // Import lives on its own view now — nothing to import from here.
    expect(screen.queryByLabelText("Choose local team bundle file")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import bundle" })).not.toBeInTheDocument();
  });

  it("exports a team bundle and shows the written path", async () => {
    renderExport();

    const exportBtn = await screen.findByRole("button", { name: /Export bundle/i });
    await waitFor(() => expect(exportBtn).toBeEnabled());
    fireEvent.click(exportBtn);

    await waitFor(() => expect(exportTeamBundle).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/team-bundle-a\.json/)).toBeInTheDocument();
  });

  it("disables export when the local machine has no sessions", async () => {
    vi.mocked(getTeamPreview).mockResolvedValue({
      manifest: { ...previewPayload.manifest, session_count: 0 },
      bundle: { sessions: [] },
    } as never);
    renderExport();

    const exportBtn = await screen.findByRole("button", { name: /Export bundle/i });
    await waitFor(() => expect(exportBtn).toBeDisabled());
    expect(screen.getByText(/No local sessions are available for export/i)).toBeInTheDocument();
  });
});
