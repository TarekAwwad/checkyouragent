import type { QueryClient, QueryKey } from "@tanstack/react-query";

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
