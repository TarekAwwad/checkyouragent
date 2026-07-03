import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportTeamBundle,
  getCostAnalytics,
  getTeamDashboard,
  getTeamPreview,
  getTeamProjects,
  importTeamBundle,
  importTeamBundleFile,
  listTeamImports,
} from "./client";
import type { TeamExportRequestBody } from "./types";

function okJson(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

describe("api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests are sent with cache disabled so toggled state can't serve stale data", async () => {
    await getCostAnalytics({});
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBe("no-store");
  });

  it("getCostAnalytics encodes the historical pricing mode in the URL when given", async () => {
    await getCostAnalytics({ dateFrom: "2026-05-18" }, false);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("historical=false");

    fetchMock.mockClear();
    await getCostAnalytics({ dateFrom: "2026-05-18" }, true);
    expect(fetchMock.mock.calls[0][0] as string).toContain("historical=true");
  });

  it("omits the historical param when the mode is not provided", async () => {
    await getCostAnalytics({ dateFrom: "2026-05-18" });
    expect(fetchMock.mock.calls[0][0] as string).not.toContain("historical=");
  });

  it("surfaces FastAPI error details as the thrown message", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "bundle_id does not match bundle content" }), { status: 400 }),
    );

    await expect(importTeamBundleFile("bad.json", {})).rejects.toThrow("bundle_id does not match bundle content");
  });

  it("uses the planned team bundle API routes", async () => {
    await getTeamProjects();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/team/projects");

    const exportBody: TeamExportRequestBody = {
      privacy_level: "structural",
      projects: [{ export_name: "d--Alpha", label: null }],
    };

    await getTeamPreview(exportBody);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/team/export-preview");
    const previewInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(previewInit.method).toBe("POST");
    expect(JSON.parse(String(previewInit.body))).toEqual(exportBody);

    await exportTeamBundle(exportBody);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/team/export");
    const exportInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(exportInit.method).toBe("POST");
    expect(JSON.parse(String(exportInit.body))).toEqual(exportBody);

    await importTeamBundle("D:\\TeamBundles\\team-a.json");
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/team/import");
    const importInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(importInit.method).toBe("POST");
    expect(JSON.parse(String(importInit.body))).toEqual({ path: "D:\\TeamBundles\\team-a.json" });

    await importTeamBundleFile("team-a.json", { profile: "team_strict" });
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/team/import-bundle");
    const fileImportInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(fileImportInit.method).toBe("POST");
    expect(JSON.parse(String(fileImportInit.body))).toEqual({
      filename: "team-a.json",
      bundle: { profile: "team_strict" },
    });

    await listTeamImports();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/team/imports");

    await getTeamDashboard();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/team/dashboard");
  });
});
