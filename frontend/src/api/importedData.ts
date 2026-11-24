import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { getImportProgress } from "./client";

/**
 * Query-key prefixes for data read from the local index: imported sessions and
 * everything analyzed from them. An import, a demo load, or a local reset
 * changes all of it. Session ids are reassigned when a project is re-imported
 * or the cache is reset, so per-session keys go stale too.
 */
export const IMPORTED_DATA_QUERY_KEYS: readonly QueryKey[] = [
  // Import page and shell
  ["source-projects"],
  ["imports"],
  ["projects"],
  ["sessions"],
  ["stats"],
  ["cost-analytics", "local"],
  // Session workspace
  ["session"],
  ["timeline"],
  ["trace"],
  ["subagents"],
  ["tool-activity"],
  ["findings"],
  ["event"],
  ["search"],
  ["session-turn-costs"],
  // Explore
  ["context-economics"],
  ["session-context-economics"],
  ["usage-map"],
  ["usage-map-prev"],
  ["usage-map-evidence"],
  ["usage-characteristics"],
  ["discovery"],
  ["limits"],
  // Team export reads the local projects and sessions
  ["team-projects"],
  ["team-preview"],
];

/** Query-key prefixes that an import, demo load, or local reset leaves valid. */
export const NON_IMPORTED_QUERY_KEYS: readonly string[] = [
  "config",
  "settings",
  "import-progress",
  // Team bundles survive a local reset and change only through team import.
  "team-import-list",
  "team-dashboard",
];

/** Refetch everything derived from imported data after it changes. */
export async function invalidateImportedData(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    IMPORTED_DATA_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}

/** Progress polling while idle (only while the tab is visible) and while an import runs. */
export const IMPORT_POLL_IDLE_MS = 10_000;
export const IMPORT_POLL_ACTIVE_MS = 1_000;

interface HandledVersion {
  version: number;
  refresh: Promise<void>;
}

// The last server data_version each app has refreshed for, and that refresh.
const handledVersions = new WeakMap<QueryClient, HandledVersion>();

/**
 * Refresh imported data once per server data_version. The first version the
 * watcher sees is a baseline; a local change refreshes even without one.
 * Returns the refresh already running when the version was handled before.
 */
function refreshForDataVersion(
  queryClient: QueryClient,
  version: number,
  { local }: { local: boolean },
): Promise<void> {
  const handled = handledVersions.get(queryClient);
  if (handled?.version === version) return handled.refresh;
  const refresh = handled || local ? invalidateImportedData(queryClient) : Promise.resolve();
  handledVersions.set(queryClient, { version, refresh });
  return refresh;
}

/**
 * After this tab's import, demo load or reset: read the new data_version and
 * refresh now, unless the watcher already refreshed for it.
 */
export async function refreshAfterLocalChange(queryClient: QueryClient): Promise<void> {
  // A poll sent before the change finished would answer with the old version.
  await queryClient.cancelQueries({ queryKey: ["import-progress"] });
  let version: number;
  try {
    const progress = await queryClient.fetchQuery({
      queryKey: ["import-progress"],
      queryFn: getImportProgress,
      staleTime: 0,
    });
    version = progress.data_version;
  } catch {
    // The data changed either way; the watcher may refresh once more later.
    await invalidateImportedData(queryClient);
    return;
  }
  await refreshForDataVersion(queryClient, version, { local: true });
}

/**
 * Mount once per app. Refreshes imported data when any import, demo load or
 * reset finishes, including ones started from another tab or before a reload.
 */
export function useImportedDataWatcher(): void {
  const queryClient = useQueryClient();
  const progress = useQuery({
    queryKey: ["import-progress"],
    queryFn: getImportProgress,
    refetchInterval: (query) =>
      query.state.data?.active ? IMPORT_POLL_ACTIVE_MS : IMPORT_POLL_IDLE_MS,
  });
  const version = progress.data?.data_version;
  useEffect(() => {
    if (typeof version === "number") {
      void refreshForDataVersion(queryClient, version, { local: false });
    }
  }, [queryClient, version]);
}
