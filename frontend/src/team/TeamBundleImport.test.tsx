import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TeamBundleImport from "./TeamBundleImport";

vi.mock("../api/client", () => ({
  getRuntimeConfig: vi.fn(),
  listTeamImports: vi.fn(),
  importTeamBundle: vi.fn(),
  importTeamBundleFile: vi.fn(),
  deleteTeamMember: vi.fn(),
}));

import {
  deleteTeamMember,
  getRuntimeConfig,
  importTeamBundle,
  importTeamBundleFile,
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
      status: "imported",
    });
    vi.mocked(importTeamBundleFile).mockImplementation(async (filename: string) => ({
      bundle_id: `bundle-${filename}`,
      member_id: filename,
      session_count: 2,
      imported: true,
      status: "imported",
    }));
    vi.mocked(deleteTeamMember).mockResolvedValue({
      member_id: "alice",
      bundles_removed: 1,
    } as never);
  });

  it("renders import controls, the root, and the imported list — but no export control", async () => {
    renderImport();

    expect(await screen.findByRole("heading", { name: /Import a team bundle/i })).toBeInTheDocument();
    expect(await screen.findByText("D:\\TeamBundles")).toBeInTheDocument();
    expect(screen.getByLabelText("Choose local team bundle files")).toBeInTheDocument();
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

  it("imports multiple selected files, calling importTeamBundleFile once per file in order", async () => {
    renderImport();

    const bundleA = { bundle_id: "alice-bundle" };
    const bundleB = { bundle_id: "bob-bundle" };
    const files = [
      new File([JSON.stringify(bundleA)], "alice.json", { type: "application/json" }),
      new File([JSON.stringify(bundleB)], "bob.json", { type: "application/json" }),
    ];

    const input = await screen.findByLabelText(/Choose local team bundle file/i);
    fireEvent.change(input, { target: { files } });

    fireEvent.click(screen.getByRole("button", { name: /Import/i }));

    await waitFor(() => expect(importTeamBundleFile).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(importTeamBundleFile).mock.calls;
    expect(calls[0][0]).toBe("alice.json");
    expect(calls[0][1]).toEqual(bundleA);
    expect(calls[1][0]).toBe("bob.json");
    expect(calls[1][1]).toEqual(bundleB);

    // Both files show up in the per-file result list.
    expect(await screen.findByText("alice.json")).toBeInTheDocument();
    expect(await screen.findByText("bob.json")).toBeInTheDocument();
  });

  it("reports a per-file failure without blocking the other files in the batch", async () => {
    vi.mocked(importTeamBundleFile).mockImplementation(async (filename: string) => {
      if (filename === "bob.json") throw new Error("boom");
      return {
        bundle_id: `bundle-${filename}`,
        member_id: filename,
        session_count: 2,
        imported: true,
        status: "imported",
      };
    });
    renderImport();

    const files = [
      new File([JSON.stringify({ bundle_id: "a" })], "alice.json", { type: "application/json" }),
      new File([JSON.stringify({ bundle_id: "b" })], "bob.json", { type: "application/json" }),
    ];
    const input = await screen.findByLabelText(/Choose local team bundle file/i);
    fireEvent.change(input, { target: { files } });

    fireEvent.click(screen.getByRole("button", { name: /Import/i }));

    // Every file is still attempted even though one throws.
    await waitFor(() => expect(importTeamBundleFile).toHaveBeenCalledTimes(2));
    // The successful file's outcome is reported alongside the failed one.
    expect(await screen.findByText("alice.json")).toBeInTheDocument();
    expect(await screen.findByText("bob.json")).toBeInTheDocument();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it("records a failure for a file with invalid JSON and still imports the valid ones", async () => {
    renderImport();

    const files = [
      new File(["this is not json"], "broken.json", { type: "application/json" }),
      new File([JSON.stringify({ bundle_id: "ok" })], "good.json", { type: "application/json" }),
    ];
    const input = await screen.findByLabelText(/Choose local team bundle file/i);
    fireEvent.change(input, { target: { files } });

    fireEvent.click(screen.getByRole("button", { name: /Import/i }));

    // Only the parseable file reaches the API.
    await waitFor(() => expect(importTeamBundleFile).toHaveBeenCalledTimes(1));
    expect(vi.mocked(importTeamBundleFile).mock.calls[0][0]).toBe("good.json");
    expect(await screen.findByText("broken.json")).toBeInTheDocument();
    expect(await screen.findByText("good.json")).toBeInTheDocument();
  });

  it("shows the replaced-bundle message when the import supersedes a previous one", async () => {
    vi.mocked(importTeamBundle).mockResolvedValue({
      bundle_id: "b",
      member_id: "m",
      session_count: 2,
      imported: true,
      status: "replaced",
    });
    renderImport();

    const pathInput = await screen.findByLabelText("Optional server-visible team bundle path");
    fireEvent.change(pathInput, { target: { value: "D:\\TeamBundles\\shared.json" } });

    fireEvent.click(screen.getByRole("button", { name: "Import bundle" }));

    await waitFor(() => expect(importTeamBundle).toHaveBeenCalledWith("D:\\TeamBundles\\shared.json"));
    expect(await screen.findByText("Replaced this member's previous bundle.")).toBeInTheDocument();
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

  it("shows the member name and privacy level for imported bundles", async () => {
    vi.mocked(listTeamImports).mockResolvedValue([
      {
        id: 1,
        bundle_id: "b-1",
        profile: "team",
        schema_version: 2,
        member_id: "1111",
        member_name: "Avery",
        privacy_level: "team",
        generated_at: "2026-07-03",
        imported_at: "2026-07-03T10:00:00Z",
        source_path: "D:\\TeamBundles\\a.json",
        session_count: 3,
      },
    ] as never);
    renderImport();

    expect(await screen.findByText("Avery")).toBeInTheDocument();
    expect(screen.getByText("team")).toBeInTheDocument(); // level tag
    expect(screen.getByRole("button", { name: "Remove Avery" })).toBeInTheDocument();
  });

  it("removes a member's bundles via the row button after confirming", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(listTeamImports).mockResolvedValue([
      {
        id: 1,
        bundle_id: "b".repeat(64),
        profile: "team_strict",
        schema_version: 1,
        member_id: "alice",
        generated_at: "2026-06-18",
        app_version: "0.1.0",
        imported_at: "2026-06-19T00:00:00Z",
        source_path: "a.json",
        session_count: 3,
      },
    ] as never);
    renderImport();

    const button = await screen.findByRole("button", { name: /remove alice/i });
    fireEvent.click(button);

    await waitFor(() => expect(deleteTeamMember).toHaveBeenCalledWith("alice"));
  });

  it("does not remove bundles if user declines the confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(listTeamImports).mockResolvedValue([
      {
        id: 1,
        bundle_id: "b".repeat(64),
        profile: "team_strict",
        schema_version: 1,
        member_id: "alice",
        generated_at: "2026-06-18",
        app_version: "0.1.0",
        imported_at: "2026-06-19T00:00:00Z",
        source_path: "a.json",
        session_count: 3,
      },
    ] as never);
    renderImport();

    const button = await screen.findByRole("button", { name: /remove alice/i });
    fireEvent.click(button);

    await Promise.resolve();
    expect(deleteTeamMember).not.toHaveBeenCalled();
  });
});
