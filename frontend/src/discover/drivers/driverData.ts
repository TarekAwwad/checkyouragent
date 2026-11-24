import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getUsageCharacteristics } from "../../api/client";
import type { UsageCharacteristicsResponse } from "../../api/types";

export type Preset = "today" | "7d" | "30d" | "all";

export const PRESETS: Preset[] = ["today", "7d", "30d", "all"];

// Same vocabulary as the Cost page's range picker (analytics/FilterBar.tsx).
export const PRESET_LABELS: Record<Preset, string> = {
  today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time",
};

export interface DateWindow {
  dateFrom: string | null;
  dateTo: string | null;
}

// YYYY-MM-DD of the local calendar day. toISOString() would give the UTC day,
// which is yesterday or tomorrow for part of every day outside UTC.
export function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Inclusive local-date windows ending today: Today is one day, Last 7 days is
// today and the 6 before it, Last 30 days today and the 29 before it. All time
// sends no dates, so the backend reads the whole history.
export function windowFor(preset: Preset, now: Date = new Date()): DateWindow {
  if (preset === "all") return { dateFrom: null, dateTo: null };
  const back = preset === "7d" ? 6 : preset === "30d" ? 29 : 0;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
  return { dateFrom: localIsoDate(from), dateTo: localIsoDate(now) };
}

// "<1%" and ">99%" keep a sliver or a near-total share from rounding to a
// misleading 0% or 100%.
export function formatShare(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  if (share > 0.99 && share < 1) return ">99%";
  return `${Math.round(share * 100)}%`;
}

// The usage-characteristics fetch behind the Explore "Usage drivers" page.
// Keep the ["usage-characteristics", ...] key prefix: import invalidation
// matches on it.
export function useUsageCharacteristics(
  projectId: number | null,
  preset: Preset,
): UseQueryResult<UsageCharacteristicsResponse> {
  return useQuery({
    queryKey: ["usage-characteristics", projectId, preset],
    queryFn: () => {
      const win = windowFor(preset);
      return getUsageCharacteristics({
        projectId, dateFrom: win.dateFrom, dateTo: win.dateTo,
      });
    },
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}
