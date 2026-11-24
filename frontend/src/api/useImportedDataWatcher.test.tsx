import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "./client";
import type { ImportProgress } from "./types";
import {
  IMPORT_POLL_ACTIVE_MS,
  IMPORT_POLL_IDLE_MS,
  refreshAfterLocalChange,
  useImportedDataWatcher,
} from "./importedData";
import ImportPage from "../pages/ImportPage";

function progress(dataVersion: number, active = false): ImportProgress {
  return {
    active,
    import_id: active ? 7 : null,
    status: active ? "importing" : "idle",
    source_path: null,
    project: null,
    totals: null,
    summary: null,
    updated_at: null,
    data_version: dataVersion,
  };
}

// What GET /api/imports/progress answers right now.
let server: ImportProgress;
let queryClient: QueryClient;
let invalidate: ReturnType<typeof vi.spyOn>;

/** How many times imported data was refreshed: one ["projects"] invalidation each. */
function refreshes(): number {
  return invalidate.mock.calls.filter(
    ([filters]: [{ queryKey?: readonly unknown[] } | undefined]) => filters?.queryKey?.[0] === "projects",
  ).length;
}

function Watcher() {
  useImportedDataWatcher();
  return null;
}

function renderApp(page?: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <Watcher />
      {page}
    </QueryClientProvider>,
  );
}

// Poll timers restart when each response lands, a few milliseconds after the
// interval elapses, so each step leaves a little slack.
const SLACK_MS = 50;

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  server = progress(0);
  vi.spyOn(client, "getImportProgress").mockImplementation(async () => server);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidate = vi.spyOn(queryClient, "invalidateQueries");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useImportedDataWatcher", () => {
  it("polls slowly while idle and never refreshes for an unchanged version", async () => {
    renderApp();
    await advance(0);
    expect(client.getImportProgress).toHaveBeenCalledTimes(1);

    await advance(6 * IMPORT_POLL_IDLE_MS);

    expect(client.getImportProgress).toHaveBeenCalledTimes(7);
    expect(refreshes()).toBe(0);
  });

  it("refreshes once when an import started elsewhere finishes", async () => {
    renderApp();
    await advance(0);

    // Another tab starts an import: the next slow poll sees it, then polls fast.
    server = progress(0, true);
    await advance(IMPORT_POLL_IDLE_MS + SLACK_MS);
    const callsWhileActive = vi.mocked(client.getImportProgress).mock.calls.length;
    await advance(IMPORT_POLL_ACTIVE_MS + SLACK_MS);
    expect(client.getImportProgress).toHaveBeenCalledTimes(callsWhileActive + 1);
    expect(refreshes()).toBe(0);

    server = progress(1);
    await advance(IMPORT_POLL_ACTIVE_MS + SLACK_MS);
    expect(refreshes()).toBe(1);

    // Back to slow polling, and the same version is not refreshed again.
    const callsAfter = vi.mocked(client.getImportProgress).mock.calls.length;
    await advance(3 * IMPORT_POLL_IDLE_MS);
    expect(client.getImportProgress).toHaveBeenCalledTimes(callsAfter + 3);
    expect(refreshes()).toBe(1);
  });

  it("refreshes once for an import that started and finished between two polls", async () => {
    renderApp();
    await advance(0);

    server = progress(1);
    await advance(IMPORT_POLL_IDLE_MS);
    await advance(2 * IMPORT_POLL_IDLE_MS);

    expect(refreshes()).toBe(1);
  });

  it("refreshes once for this tab's import, at once and not again on later polls", async () => {
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
    vi.spyOn(client, "discoverSourceProjects").mockResolvedValue([
      { name: "d--Beta", display_name: "Beta", imported: false, session_count: 0, last_imported_at: null },
    ]);
    vi.spyOn(client, "createImport").mockImplementation(async () => {
      server = progress(1);
      return {
        import_id: 1, source_path: "/srv/Data", project_count: 1, session_count: 1,
        event_count: 1, subagent_count: 0, persisted_output_count: 0,
        file_count: 1, error_count: 0, errors: [],
      };
    });

    renderApp(<ImportPage />);
    // The source scan starts only after the config query has rendered.
    for (let step = 0; step < 10 && !screen.queryByRole("button", { name: /Import Beta/i }); step++) {
      await advance(10);
    }
    fireEvent.click(screen.getByRole("button", { name: /Import Beta/i }));
    // Well before the next slow poll.
    await advance(100);
    expect(refreshes()).toBe(1);
    expect(client.createImport).toHaveBeenCalledTimes(1);

    await advance(3 * IMPORT_POLL_IDLE_MS);
    expect(refreshes()).toBe(1);
  });

  it("does not refresh again when the watcher saw the change before this tab's response", async () => {
    renderApp();
    await advance(0);
    server = progress(0, true);
    await advance(IMPORT_POLL_IDLE_MS + SLACK_MS);
    server = progress(1);
    await advance(IMPORT_POLL_ACTIVE_MS + SLACK_MS);
    expect(refreshes()).toBe(1);

    await act(() => refreshAfterLocalChange(queryClient));

    expect(refreshes()).toBe(1);
  });
});
