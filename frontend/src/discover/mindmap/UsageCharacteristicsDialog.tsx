import React from "react";
import { X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getUsageCharacteristics } from "../../api/client";

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: number | null;
}

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

// A /usage-style "what's contributing to your limits usage?" panel. Independent,
// overlapping characteristics — not a breakdown. Native <dialog> for focus
// trapping, Esc, and a backdrop (same pattern as GlossaryDialog).
export default function UsageCharacteristicsDialog({ open, onClose, projectId }: Props) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const [preset, setPreset] = React.useState<Preset>("week");

  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const win = windowFor(preset);
  const query = useQuery({
    queryKey: ["usage-characteristics", projectId, preset],
    queryFn: () => getUsageCharacteristics({
      projectId, dateFrom: win.dateFrom, dateTo: win.dateTo,
    }),
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const handleClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) onClose();
  };

  const data = query.data;

  return (
    <dialog
      ref={ref}
      className="glossary-dialog usage-characteristics-dialog"
      aria-labelledby="usage-characteristics-title"
      onClose={onClose}
      onClick={handleClick}
    >
      <div className="glossary-panel">
        <header className="glossary-header">
          <h2 id="usage-characteristics-title">What's contributing to your usage?</h2>
          <button type="button" className="glossary-close"
                  aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

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
          These are independent characteristics of your usage, not a breakdown.
        </p>

        <div className="uc-body">
          {query.isPending && <p className="uc-note">Loading…</p>}
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
      </div>
    </dialog>
  );
}
