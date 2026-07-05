import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImportPage from "./ImportPage";
import * as client from "../api/client";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(client, "getRuntimeConfig").mockResolvedValue({
    import_root: "/srv/Data",
    database_path: "/srv/ccfr.sqlite3",
    is_docker: false,
  });
  vi.spyOn(client, "listImports").mockResolvedValue([]);
  vi.spyOn(client, "getCacheStats").mockResolvedValue({
    project_count: 0, session_count: 0, event_count: 0,
    subagent_count: 0, memory_count: 0, persisted_output_count: 0,
  });
  vi.spyOn(client, "getImportProgress").mockResolvedValue({
    active: false,
    import_id: null,
    status: "idle",
    source_path: null,
    project: null,
    totals: null,
    summary: null,
    updated_at: null,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("ImportPage", () => {
  it("lists source projects and imports one against the active root", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Alpha", imported: true, session_count: 3, last_imported_at: "2026-05-31T00:00:00Z" },
      { name: "d--Beta", imported: false, session_count: 0, last_imported_at: null },
    ]);
    const createImport = vi.spyOn(client, "createImport").mockResolvedValue({
      import_id: 1, source_path: "/srv/Data", project_count: 1, session_count: 1,
      event_count: 1, subagent_count: 0, memory_count: 0, persisted_output_count: 0,
      file_count: 1, error_count: 0, errors: [],
    });

    renderPage();

    expect(await screen.findByText("d--Alpha")).toBeInTheDocument();
    expect(screen.getByText("d--Beta")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import d--Beta/i }));

    await waitFor(() => expect(createImport).toHaveBeenCalledWith("/srv/Data", "d--Beta"));
  });

  it("locks import controls while reimporting an already imported project", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Alpha", imported: true, session_count: 3, last_imported_at: "2026-05-31T00:00:00Z" },
      { name: "d--Beta", imported: false, session_count: 0, last_imported_at: null },
    ]);
    const createImport = vi.spyOn(client, "createImport").mockImplementation(
      () => new Promise(() => undefined),
    );

    renderPage();

    const reimport = await screen.findByRole("button", { name: /Re-import d--Alpha/i });
    fireEvent.click(reimport);

    await waitFor(() => expect(reimport).toBeDisabled());
    expect(screen.getByRole("button", { name: /Import all new/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Import d--Beta/i })).toBeDisabled();

    fireEvent.click(reimport);
    expect(createImport).toHaveBeenCalledTimes(1);
    expect(createImport).toHaveBeenCalledWith("/srv/Data", "d--Alpha");
  });

  it("polls progress while importing and renders live metric totals", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Beta", imported: false, session_count: 0, last_imported_at: null },
    ]);
    vi.spyOn(client, "createImport").mockImplementation(
      () => new Promise(() => undefined),
    );
    vi.mocked(client.getImportProgress).mockResolvedValue({
      active: true,
      import_id: 7,
      status: "importing",
      source_path: "/srv/Data/d--Beta",
      project: "d--Beta",
      totals: {
        project_count: 2,
        session_count: 24,
        event_count: 9876,
        subagent_count: 31,
        memory_count: 4,
        persisted_output_count: 5,
      },
      summary: {
        project_count: 1,
        session_count: 1,
        event_count: 9876,
        subagent_count: 31,
        memory_count: 4,
        persisted_output_count: 5,
        file_count: 10,
        error_count: 0,
      },
      updated_at: "2026-06-03T00:00:00Z",
    });

    renderPage();

    const importButton = await screen.findByRole("button", { name: /Import d--Beta/i });
    expect(client.getImportProgress).not.toHaveBeenCalled();

    fireEvent.click(importButton);

    const band = screen.getByLabelText("Cache totals");
    await waitFor(() => expect(client.getImportProgress).toHaveBeenCalled());
    await waitFor(() => expect(band).toHaveTextContent("9,876"));
    expect(band).toHaveClass("is-live");
  });

  it("rescans when a custom root is set", async () => {
    const discover = vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([]);

    renderPage();

    await waitFor(() => expect(discover).toHaveBeenCalledWith("/srv/Data"));

    fireEvent.change(screen.getByLabelText(/import source root/i), {
      target: { value: "/mnt/exports" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Scan$/i }));

    await waitFor(() => expect(discover).toHaveBeenCalledWith("/mnt/exports"));
    expect(localStorage.getItem("ccfr.importRoot")).toBe("/mnt/exports");
  });

  it("shows persistent cache totals without importing this session", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([]);
    vi.mocked(client.getCacheStats).mockResolvedValue({
      project_count: 1, session_count: 13, event_count: 3679,
      subagent_count: 57, memory_count: 0, persisted_output_count: 0,
    });

    renderPage();

    expect(await screen.findByText("3,679")).toBeInTheDocument();
    const band = screen.getByLabelText("Cache totals");
    expect(band).toHaveTextContent("Sessions");
    expect(band).toHaveTextContent("13");
  });

  it("offers demo data when the source and cache are both empty", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([]);
    const loadDemo = vi.spyOn(client, "loadDemoData").mockResolvedValue({
      import_id: 1, source_path: "/demo", project_count: 3, session_count: 46,
      event_count: 900, subagent_count: 26, memory_count: 6, persisted_output_count: 4,
      file_count: 120, error_count: 0, errors: [],
    });

    renderPage();

    const button = await screen.findByRole("button", { name: /Load demo data/i });
    fireEvent.click(button);

    await waitFor(() => expect(loadDemo).toHaveBeenCalledTimes(1));
  });

  it("hides the demo card once projects exist in the source", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Alpha", imported: false, session_count: 0, last_imported_at: null },
    ]);
    vi.spyOn(client, "loadDemoData").mockResolvedValue({
      import_id: 1, source_path: "/demo", project_count: 3, session_count: 46,
      event_count: 900, subagent_count: 26, memory_count: 6, persisted_output_count: 4,
      file_count: 120, error_count: 0, errors: [],
    });

    renderPage();

    expect(await screen.findByText("d--Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load demo data/i })).not.toBeInTheDocument();
  });
});
