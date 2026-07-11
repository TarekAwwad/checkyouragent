import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getUsageCharacteristics } from "../../api/client";
import type { UsageCharacteristicsResponse } from "../../api/types";
import LoadingBar from "../../components/LoadingBar";

export type Preset = "day" | "week" | "month" | "all";

export const PRESETS: Preset[] = ["day", "week", "month", "all"];

export const PRESET_LABELS: Record<Preset, string> = {
  day: "Day", week: "Week", month: "Month", all: "All",
};

// The /usage-style subtitle shown in the Explore page toolbar.
export const UC_SUBTITLE =
  "Independent characteristics of your usage — not a breakdown. Day and Week " +
  "mirror Claude Code's /usage; Month and All draw on your full history.";

// Day = today; Week = last 7d; Month = last 30d (all inclusive). "All" is the
// whole history (no date filter) — something /usage can't do, since it reports
// rate-limit windows; here we read the full export.
function windowFor(preset: Preset): { dateFrom: string | null; dateTo: string | null } {
  if (preset === "all") return { dateFrom: null, dateTo: null };
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = new Date(today);
  if (preset === "week") from.setDate(from.getDate() - 6);
  else if (preset === "month") from.setDate(from.getDate() - 29);
  return { dateFrom: iso(from), dateTo: iso(today) };
}

// Single home of the usage-characteristics fetch, consumed by the Explore
// "Usage drivers" page.
export function useUsageCharacteristics(
  projectId: number | null,
  preset: Preset,
  enabled: boolean,
): UseQueryResult<UsageCharacteristicsResponse> {
  const win = windowFor(preset);
  return useQuery({
    queryKey: ["usage-characteristics", projectId, preset],
    queryFn: () => getUsageCharacteristics({
      projectId, dateFrom: win.dateFrom, dateTo: win.dateTo,
    }),
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}

// The independent-characteristic rows plus their loading / error / empty
// states, rendered by the Explore page inside a .card body (the
// .usage-drivers-body rules style the .uc-* classes).
export function UsageCharacteristicsRows({
  query,
}: {
  query: UseQueryResult<UsageCharacteristicsResponse>;
}) {
  const data = query.data;
  return (
    <div className="uc-body">
      {query.isPending && <div className="uc-note"><LoadingBar caption="Loading…" /></div>}
      {query.isError && (
        <p className="uc-note">Could not load usage characteristics.</p>
      )}
      {data && data.characteristics.length === 0 && (
        <p className="uc-note">No usage in this window.</p>
      )}
      {data && data.characteristics.map((c) => (
        <div key={c.key} className="uc-row">
          <p className="uc-headline">
            <strong>{Math.round(c.share * 100)}%</strong> of your usage came from {c.headline}
          </p>
          {c.guidance && <p className="uc-guidance">{c.guidance}</p>}
        </div>
      ))}
    </div>
  );
}

