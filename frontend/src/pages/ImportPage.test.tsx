import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImportPage from "./ImportPage";
import * as client from "../api/client";

function renderPage(onViewCosts?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportPage onViewCosts={onViewCosts} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(client, "getRuntimeConfig").mockResolvedValue({
    app_version: "9.8.7",
    import_root: "/srv/Data",
    database_path: "/srv/ccfr.sqlite3",
    is_docker: false,
  });
  vi.spyOn(client, "listImports").mockResolvedValue([]);
  vi.spyOn(client, "getCacheStats").mockResolvedValue({
    project_count: 0, session_count: 0, event_count: 0,
    subagent_count: 0, persisted_output_count: 0,
    observed_date_from: null, observed_date_to: null,
    last_successful_sync_at: null, latest_import_error_count: 0,
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
  it("offers View costs after a first successful sync without leaving its results", async () => {
    const onViewCosts = vi.fn();
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Alpha", display_name: "Alpha", imported: false, session_count: 0, last_imported_at: null },
    ]);
    vi.spyOn(client, "createImport").mockImplementation(async () => {
      vi.mocked(client.getCacheStats).mockResolvedValue({
        project_count: 1, session_count: 1, event_count: 2,
        subagent_count: 0, persisted_output_count: 0,
        observed_date_from: "2026-06-01", observed_date_to: "2026-06-01",
        last_successful_sync_at: "2026-06-01T12:00:00Z", latest_import_error_count: 0,
      });
      return {
        import_id: 1, source_path: "/srv/Data", project_count: 1, session_count: 1,
        event_count: 2, subagent_count: 0, persisted_output_count: 0,
        file_count: 1, error_count: 0, errors: [],
      };
    });
    renderPage(onViewCosts);
    await screen.findByText("d--Alpha");
    expect(screen.queryByRole("button", { name: "View costs" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync new and updated" }));
    const viewCosts = await screen.findByRole("button", { name: "View costs" });
    await waitFor(() => expect(viewCosts).toBeEnabled());
    expect(screen.getByRole("heading", { name: "Projects in source" })).toBeInTheDocument();
    expect(onViewCosts).not.toHaveBeenCalled();
    fireEvent.click(viewCosts);
    expect(onViewCosts).toHaveBeenCalledOnce();
  });

  it("lists source projects and imports one against the active root", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Alpha", display_name: "Alpha", imported: true, session_count: 3, last_imported_at: "2026-05-31T00:00:00Z" },
      { name: "d--Beta", display_name: "Beta", imported: false, session_count: 0, last_imported_at: null },
    ]);
    const createImport = vi.spyOn(client, "createImport").mockResolvedValue({
      import_id: 1, source_path: "/srv/Data", project_count: 1, session_count: 1,
      event_count: 1, subagent_count: 0, persisted_output_count: 0,
      file_count: 1, error_count: 0, errors: [],
    });

    renderPage();

    expect(await screen.findByText("d--Alpha")).toBeInTheDocument();
    expect(screen.getByText("d--Beta")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import Beta/i }));

    await waitFor(() => expect(createImport).toHaveBeenCalledWith("/srv/Data", "d--Beta"));
  });

  it("locks import controls while reimporting an already imported project", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Alpha", display_name: "Alpha", imported: true, session_count: 3, last_imported_at: "2026-05-31T00:00:00Z" },
      { name: "d--Beta", display_name: "Beta", imported: false, session_count: 0, last_imported_at: null },
    ]);
    const createImport = vi.spyOn(client, "createImport").mockImplementation(
      () => new Promise(() => undefined),
    );

    renderPage();

    const reimport = await screen.findByRole("button", { name: /Re-import Alpha/i });
    fireEvent.click(reimport);

    await waitFor(() => expect(reimport).toBeDisabled());
    expect(screen.getByRole("button", { name: /Sync new and updated/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Import Beta/i })).toBeDisabled();

    fireEvent.click(reimport);
    expect(createImport).toHaveBeenCalledTimes(1);
    expect(createImport).toHaveBeenCalledWith("/srv/Data", "d--Alpha");
  });

  it("polls progress while importing and renders live metric totals", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Beta", display_name: "Beta", imported: false, session_count: 0, last_imported_at: null },
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
        persisted_output_count: 5,
        observed_date_from: "2026-01-01",
        observed_date_to: "2026-06-03",
        last_successful_sync_at: "2026-06-01T00:00:00Z",
        latest_import_error_count: 0,
      },
      summary: {
        project_count: 1,
        session_count: 1,
        event_count: 9876,
        subagent_count: 31,
        persisted_output_count: 5,
        file_count: 10,
        error_count: 0,
      },
      updated_at: "2026-06-03T00:00:00Z",
    });

    renderPage();

    const importButton = await screen.findByRole("button", { name: /Import Beta/i });
    expect(client.getImportProgress).not.toHaveBeenCalled();

    fireEvent.click(importButton);

    const band = screen.getByLabelText("Local data summary");
    await waitFor(() => expect(client.getImportProgress).toHaveBeenCalled());
    await waitFor(() => expect(band).toHaveTextContent("24"));
    expect(band).toHaveClass("is-live");
  });

  it("refreshes project import statuses while a batch import is running", async () => {
    const beforeImport = [
      { name: "d--Alpha", display_name: "Alpha", imported: false, session_count: 0, last_imported_at: null },
      { name: "d--Beta", display_name: "Beta", imported: false, session_count: 0, last_imported_at: null },
    ];
    const afterFirstProject = [
      { name: "d--Alpha", display_name: "Alpha", imported: true, session_count: 3, last_imported_at: "2026-06-03T00:00:00Z" },
      beforeImport[1],
    ];
    vi.spyOn(client, "discoverSourceProjects")
      .mockResolvedValueOnce(beforeImport)
      .mockResolvedValue(afterFirstProject);
    vi.spyOn(client, "createImport").mockImplementation(
      () => new Promise(() => undefined),
    );

    renderPage();

    const alpha = await screen.findByText("d--Alpha");
    const beta = screen.getByText("d--Beta");
    expect(alpha.closest(".import-row")).not.toHaveClass("is-imported");
    expect(beta.closest(".import-row")).not.toHaveClass("is-imported");

    fireEvent.click(screen.getByRole("button", { name: /Sync new and updated/i }));

    await waitFor(
      () => expect(alpha.closest(".import-row")).toHaveClass("is-imported"),
      { timeout: 2_000 },
    );
    expect(beta.closest(".import-row")).not.toHaveClass("is-imported");
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
      subagent_count: 57, persisted_output_count: 0,
      observed_date_from: "2026-01-01", observed_date_to: "2026-06-01",
      last_successful_sync_at: "2026-06-03T00:00:00Z", latest_import_error_count: 0,
    });

    renderPage();

    const diagnostics = await screen.findByLabelText("Import diagnostics");
    await waitFor(() => expect(diagnostics).toHaveTextContent("3,679 events"));
    const band = screen.getByLabelText("Local data summary");
    expect(band).toHaveTextContent("Sessions");
    expect(band).toHaveTextContent("13");
  });

  it("offers demo data when the source and cache are both empty", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([]);
    const loadDemo = vi.spyOn(client, "loadDemoData").mockResolvedValue({
      import_id: 1, source_path: "/demo", project_count: 3, session_count: 46,
      event_count: 900, subagent_count: 26, persisted_output_count: 4,
      file_count: 120, error_count: 0, errors: [],
    });

    renderPage();

    const button = await screen.findByRole("button", { name: /Load demo data/i });
    fireEvent.click(button);

    await waitFor(() => expect(loadDemo).toHaveBeenCalledTimes(1));
  });

  it("hides the demo card once projects exist in the source", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Alpha", display_name: "Alpha", imported: false, session_count: 0, last_imported_at: null },
    ]);
    vi.spyOn(client, "loadDemoData").mockResolvedValue({
      import_id: 1, source_path: "/demo", project_count: 3, session_count: 46,
      event_count: 900, subagent_count: 26, persisted_output_count: 4,
      file_count: 120, error_count: 0, errors: [],
    });

    renderPage();

    expect(await screen.findByText("d--Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load demo data/i })).not.toBeInTheDocument();
  });

  it("uses sync language and shows a human project name above the source folder", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      {
        name: "d--Encoded-Project",
        display_name: "payments-api",
        imported: true,
        session_count: 12,
        last_imported_at: "2026-06-01T12:00:00Z",
      },
    ] as never);

    renderPage();

    expect(await screen.findByText("payments-api")).toBeInTheDocument();
    expect(screen.getByText("d--Encoded-Project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync new and updated" })).toBeInTheDocument();
    expect(screen.queryByText("Import all new")).not.toBeInTheDocument();
  });

  it("keeps decision metrics primary and persistent skipped records in diagnostics", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([]);
    vi.mocked(client.getCacheStats).mockResolvedValue({
      project_count: 3,
      session_count: 42,
      event_count: 9_876,
      subagent_count: 19,
      persisted_output_count: 2,
      observed_date_from: "2026-01-03",
      observed_date_to: "2026-05-09",
      last_successful_sync_at: "2026-06-01T12:00:00Z",
      latest_import_error_count: 1,
    } as never);
    vi.mocked(client.listImports).mockResolvedValue([
      {
        id: 7,
        source_path: "/srv/Data/d--Encoded-Project",
        imported_at: "2026-06-01T12:00:00Z",
        file_count: 12,
        status: "completed_with_errors",
        error_count: 1,
        errors: [{ path: "session.jsonl", line_no: 7, message: "Invalid JSON" }],
      },
    ]);

    renderPage();

    const summary = await screen.findByLabelText("Local data summary");
    expect(summary).toHaveTextContent("Projects");
    expect(summary).toHaveTextContent("Sessions");
    expect(summary).toHaveTextContent("Observed coverage");
    expect(summary).toHaveTextContent("Last successful sync");
    expect(summary).toHaveTextContent("Skipped / errors");
    expect(summary).not.toHaveTextContent("Events");
    expect(summary).not.toHaveTextContent("Subagents");
    expect(summary).not.toHaveTextContent("Memory");
    expect(summary).not.toHaveTextContent("Large outputs");

    const diagnostics = screen.getByLabelText("Import diagnostics");
    await waitFor(() => expect(diagnostics).toHaveTextContent("Invalid JSON"));
    expect(diagnostics).toHaveTextContent("9,876 events");
    expect(diagnostics).toHaveTextContent("19 subagents");
    expect(diagnostics).not.toHaveTextContent(/memory/i);
    expect(diagnostics).toHaveTextContent("Invalid JSON");
    expect(diagnostics).toHaveTextContent("session.jsonl");
  });

  it("describes the exact local reset scope and preserves team bundles", async () => {
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([]);
    const resetImports = vi.spyOn(client, "resetImports").mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Reset local data" }));

    expect(confirm).toHaveBeenCalledWith(
      "Reset local session data? This removes local imports, projects, sessions, and derived analytics. Imported team bundles are preserved.",
    );
    await waitFor(() => expect(resetImports).toHaveBeenCalledTimes(1));
  });
});
