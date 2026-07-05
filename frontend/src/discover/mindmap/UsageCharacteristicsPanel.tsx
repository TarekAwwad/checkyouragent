import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getUsageCharacteristics } from "../../api/client";
import LoadingBar from "../../components/LoadingBar";

type Preset = "day" | "week" | "month" | "all";

const PRESET_LABELS: Record<Preset, string> = {
  day: "Day", week: "Week", month: "Month", all: "All",
};

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

interface Props {
  projectId: number | null;
  /** Gate the query: the dialog passes its open state; the page passes true. */
  enabled: boolean;
}

// The reusable body of the "What's driving your usage" panel: a range selector,
// the /usage-style subtitle, the independent-characteristic rows, and the
// cost-vs-limits caveat. Rendered inline by the Explore "Usage drivers" page and
// inside the mindmap's dialog. Returns a fragment (no wrapper element) so the
// dialog's flex layout and CSS are unchanged. Independent, overlapping
// characteristics — not a breakdown.
export default function UsageCharacteristicsPanel({ projectId, enabled }: Props) {
  const [preset, setPreset] = React.useState<Preset>("week");
  const win = windowFor(preset);
  const query = useQuery({
    queryKey: ["usage-characteristics", projectId, preset],
    queryFn: () => getUsageCharacteristics({
      projectId, dateFrom: win.dateFrom, dateTo: win.dateTo,
    }),
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const data = query.data;

  return (
    <>
      <div className="segmented-control" role="group" aria-label="Window">
        {(["day", "week", "month", "all"] as const).map((p) => (
          <button key={p} type="button" aria-pressed={preset === p}
                  className={preset === p ? "active" : ""}
                  onClick={() => setPreset(p)}>
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      <p className="uc-subtitle">
        Independent characteristics of your usage — not a breakdown. Day and Week
        mirror Claude Code's /usage; Month and All draw on your full history.
      </p>

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

      {data && <p className="uc-caveat">{data.meta.basis_note}</p>}
    </>
  );
}
