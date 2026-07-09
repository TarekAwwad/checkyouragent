import React from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getUsageCharacteristics } from "../../api/client";
import type { UsageCharacteristicsResponse } from "../../api/types";
import LoadingBar from "../../components/LoadingBar";

export type Preset = "day" | "week" | "month" | "all";

export const PRESETS: Preset[] = ["day", "week", "month", "all"];

export const PRESET_LABELS: Record<Preset, string> = {
  day: "Day", week: "Week", month: "Month", all: "All",
};

// The /usage-style subtitle, shared verbatim between the dialog body and the
// Explore page toolbar so the copy can't drift.
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

// Single home of the usage-characteristics fetch — the Explore "Usage drivers"
// page and the mindmap dialog both call this, so neither duplicates the query.
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
// states. Shared between the dialog (inside .glossary-panel) and the Explore
// page (inside a .card body) — each context styles the .uc-* classes itself.
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

interface Props {
  projectId: number | null;
  /** Gate the query: the dialog passes its open state. */
  enabled: boolean;
}

// The modal body of the "What's driving your usage" dialog: the segmented
// range pill, the /usage-style subtitle, the shared rows, and the basis
// caveat. Only the mindmap dialog renders this — the Explore "Usage drivers"
// page composes useUsageCharacteristics + UsageCharacteristicsRows into the
// Explore page shell instead (the dialog keeps its modal chrome; the page
// wears the page shell). Returns a fragment (no wrapper element) so the
// dialog's flex layout and CSS are unchanged.
export default function UsageCharacteristicsPanel({ projectId, enabled }: Props) {
  const [preset, setPreset] = React.useState<Preset>("week");
  const query = useUsageCharacteristics(projectId, preset, enabled);
  const data = query.data;

  return (
    <>
      <div className="segmented-control" role="group" aria-label="Window">
        {PRESETS.map((p) => (
          <button key={p} type="button" aria-pressed={preset === p}
                  className={preset === p ? "active" : ""}
                  onClick={() => setPreset(p)}>
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      <p className="uc-subtitle">{UC_SUBTITLE}</p>
      <UsageCharacteristicsRows query={query} />
      {data && <p className="uc-caveat">{data.meta.basis_note}</p>}
    </>
  );
}
