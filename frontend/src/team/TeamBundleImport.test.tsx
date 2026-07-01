import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamBundleImport from "./TeamBundleImport";

vi.mock("../api/client", () => ({
  getRuntimeConfig: vi.fn(),
  listTeamImports: vi.fn(),
  importTeamBundle: vi.fn(),
  importTeamBundleFile: vi.fn(),
}));

import {
  getRuntimeConfig,
  importTeamBundle,
  listTeamImports,
} from "../api/client";

function renderImport() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TeamBundleImport />
    </QueryClientProvider>,
  );
}

describe("TeamBundleImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRuntimeConfig).mockResolvedValue({
      import_root: "D:\\Data",
      team_bundle_root: "D:\\TeamBundles",
      database_path: "D:\\Data\\ccfr.sqlite3",
      is_docker: false,
    } as never);
    vi.mocked(listTeamImports).mockResolvedValue([] as never);
    vi.mocked(importTeamBundle).mockResolvedValue({
      bundle_id: "b",
      member_id: "m",
      session_count: 2,
      imported: true,
    } as never);
  });

  it("renders import controls, the root, and the imported list — but no export control", async () => {
    renderImport();

    expect(await screen.findByRole("heading", { name: /Import a team bundle/i })).toBeInTheDocument();
    expect(await screen.findByText("D:\\TeamBundles")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose local team bundle file")).toBeInTheDocument();
    expect(screen.getByLabelText("Optional server-visible team bundle path")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import bundle" })).toBeInTheDocument();
    expect(screen.getByText(/No team bundles have been imported yet/i)).toBeInTheDocument();

    // Export lives on its own local-scope view now.
    expect(screen.queryByRole("button", { name: /Export bundle/i })).not.toBeInTheDocument();
  });

  it("imports from a server-visible path and shows the result", async () => {
    renderImport();

    const pathInput = await screen.findByLabelText("Optional server-visible team bundle path");
    fireEvent.change(pathInput, { target: { value: "D:\\TeamBundles\\shared.json" } });

    fireEvent.click(screen.getByRole("button", { name: "Import bundle" }));

    await waitFor(() => expect(importTeamBundle).toHaveBeenCalledWith("D:\\TeamBundles\\shared.json"));
    expect(await screen.findByText(/shared\.json/)).toBeInTheDocument();
  });

  it("lists imported team bundles", async () => {
    vi.mocked(listTeamImports).mockResolvedValue([
      {
        id: 1,
        bundle_id: "bundle-x",
        profile: "team_strict",
        schema_version: 1,
        member_id: "alice",
        generated_at: "2026-06-30T00:00:00Z",
        imported_at: "2026-06-30T01:00:00Z",
        source_path: "D:\\TeamBundles\\alice.json",
        session_count: 9,
      },
    ] as never);
    renderImport();

    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText(/9 sessions/)).toBeInTheDocument();
  });
});
