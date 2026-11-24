import React from "react";
import {
  RANGE_LABELS, RANGE_PRESETS, presetRange,
  type DateRange, type RangePreset, type ResolvedRange,
} from "../../shell/dateRange";

/** Wait after the last custom-date edit before committing (each commit refetches). */
export const DATE_INPUT_DEBOUNCE_MS = 400;

interface Props {
  range: DateRange;
  /** The window currently on screen; Custom starts from it. */
  resolved: ResolvedRange;
  onChange: (range: DateRange) => void;
}

export default function DateRangeControl({ range, resolved, onChange }: Props) {
  const isCustom = range.preset === "custom";
  const [draft, setDraft] = React.useState({ from: range.from ?? "", to: range.to ?? "" });
  const timer = React.useRef<number | undefined>(undefined);
  const pending = React.useRef<DateRange | null>(null);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;

  // Follow an outside change (another page, a reset) while not editing.
  React.useEffect(() => {
    if (isCustom && pending.current === null) setDraft({ from: range.from ?? "", to: range.to ?? "" });
  }, [isCustom, range.from, range.to]);

  // A pending edit is kept, not dropped, when the page goes away mid-edit.
  React.useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (pending.current) onChangeRef.current(pending.current);
  }, []);

  const edit = (next: { from: string; to: string }) => {
    setDraft(next);
    pending.current = { preset: "custom", from: next.from || null, to: next.to || null };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const committed = pending.current;
      pending.current = null;
      if (committed) onChangeRef.current(committed);
    }, DATE_INPUT_DEBOUNCE_MS);
  };

  const selectPreset = (preset: RangePreset) => {
    window.clearTimeout(timer.current);
    pending.current = null;
    if (preset === "custom") {
      const next = { from: resolved.from ?? "", to: resolved.to ?? "" };
      setDraft(next);
      onChange({ preset: "custom", from: next.from || null, to: next.to || null });
      return;
    }
    onChange(presetRange(preset));
  };

  return (
    <div className="date-range-control">
      <select className="chip-select date-range-select" aria-label="Date range" value={range.preset}
              onChange={(event) => selectPreset(event.target.value as RangePreset)}>
        {RANGE_PRESETS.map((preset) => (
          <option key={preset} value={preset}>{RANGE_LABELS[preset]}</option>
        ))}
      </select>
      {isCustom && (
        <>
          <input type="date" aria-label="Start date" value={draft.from} max={draft.to || undefined}
                 onChange={(event) => edit({ ...draft, from: event.target.value })} />
          <input type="date" aria-label="End date" value={draft.to} min={draft.from || undefined}
                 onChange={(event) => edit({ ...draft, to: event.target.value })} />
        </>
      )}
    </div>
  );
}
