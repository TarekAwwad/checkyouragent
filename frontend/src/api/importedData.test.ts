import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  IMPORTED_DATA_QUERY_KEYS,
  NON_IMPORTED_QUERY_KEYS,
  invalidateImportedData,
} from "./importedData";

const sources = import.meta.glob<string>(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"],
  { query: "?raw", import: "default", eager: true },
);

function queryKeyRoots(): Set<string> {
  const roots = new Set<string>();
  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(/queryKey:\s*\[\s*"([^"]+)"/g)) {
      roots.add(match[1]);
    }
  }
  return roots;
}

describe("invalidateImportedData", () => {
  it("classifies every query key in the app as imported data or not", () => {
    const imported = new Set(IMPORTED_DATA_QUERY_KEYS.map((key) => String(key[0])));
    const roots = queryKeyRoots();
    expect(roots.size).toBeGreaterThan(20);
    // A new query must be added to one of the two lists, so imports and
    // resets never leave its view showing stale results.
    const unclassified = [...roots].filter(
      (root) => !imported.has(root) && !NON_IMPORTED_QUERY_KEYS.includes(root),
    );
    expect(unclassified).toEqual([]);
  });

  it("invalidates the Explore views and keeps settings and team bundles", async () => {
    const queryClient = new QueryClient();
    const keys = [
      ["context-economics", null],
      ["session-context-economics", 4],
      ["usage-map", null, "", ""],
      ["usage-map-prev", null, "2026-05-01", "2026-05-10"],
      ["usage-map-evidence", "phase:explore", null, null, null],
      ["usage-characteristics", null, "30d"],
      ["discovery", null, 5],
      ["limits"],
      ["session", 4],
      ["cost-analytics", "local", {}, true],
      ["cost-analytics", "team", {}, true],
      ["settings"],
      ["team-dashboard"],
    ];
    for (const key of keys) queryClient.setQueryData(key, { ok: true });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await invalidateImportedData(queryClient);

    const stale = keys.filter((key) => queryClient.getQueryState(key)?.isInvalidated);
    expect(stale.map((key) => key[0] === "cost-analytics" ? key.slice(0, 2).join(":") : key[0]))
      .toEqual([
        "context-economics", "session-context-economics", "usage-map", "usage-map-prev",
        "usage-map-evidence", "usage-characteristics", "discovery", "limits", "session",
        "cost-analytics:local",
      ]);
    expect(invalidate).toHaveBeenCalledTimes(IMPORTED_DATA_QUERY_KEYS.length);
  });
});
