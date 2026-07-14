import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../../api/client";
import type { PlanEra } from "../../api/types";

// The subscription tiers a cap can belong to. A saved value outside this list
// (from an older cache or a hand-edited settings file) is kept as an extra
// option so opening the editor never silently rewrites history.
const PLAN_OPTIONS = ["Pro", "Max 5x", "Max 20x", "Team", "Enterprise"];

// Small editor for the optional subscription history. Rows are {plan, start
// date}; the backend sanitizes and sorts. Saving invalidates the limits query
// so eras recompute immediately.
export default function PlanHistoryModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [rows, setRows] = React.useState<PlanEra[] | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    getSettings().then((settings) => {
      if (alive) setRows(settings.plan_history ?? []);
    });
    return () => { alive = false; };
  }, []);

  const setRow = (index: number, patch: Partial<PlanEra>) =>
    setRows((r) => r!.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = async () => {
    setSaving(true);
    try {
      const settings = await getSettings();
      await updateSettings({
        ...settings,
        plan_history: (rows ?? []).filter((row) => row.plan && row.start_date),
      });
      await queryClient.invalidateQueries({ queryKey: ["limits"] });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-label="Plan history"
           onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>Plan history</h2>
        </div>
        <div className="card-pad">
          <p className="plan-intro">
            Which subscription you were on, and since when. Eras split the
            timeline and the measured cap zones. Leave empty for a single view.
          </p>
          {rows !== null && rows.length === 0 && (
            <p className="plan-empty">No plans recorded yet.</p>
          )}
          {(rows ?? []).map((row, i) => (
            <div key={i} className="plan-row">
              <select aria-label={`Plan name ${i + 1}`} value={row.plan}
                      onChange={(e) => setRow(i, { plan: e.target.value })}>
                <option value="" disabled>Select plan</option>
                {row.plan !== "" && !PLAN_OPTIONS.includes(row.plan) && (
                  <option value={row.plan}>{row.plan}</option>
                )}
                {PLAN_OPTIONS.map((plan) => (
                  <option key={plan} value={plan}>{plan}</option>
                ))}
              </select>
              <input aria-label={`Start date ${i + 1}`} type="date" value={row.start_date}
                     onChange={(e) => setRow(i, { start_date: e.target.value })} />
              <button type="button" className="plan-remove" aria-label={`Remove plan ${i + 1}`}
                      title="Remove plan"
                      onClick={() => setRows((r) => r!.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <div className="plan-actions">
            {/* Disabled until the saved history arrives: a row added before
                then would be overwritten by the fetch callback. */}
            <button type="button" className="ghost-action" disabled={rows === null}
                    onClick={() => setRows((r) => [...(r ?? []), { plan: "", start_date: "" }])}>
              Add plan
            </button>
            <button type="button" className="ghost-action" onClick={onClose}>Cancel</button>
            <button type="button" className="primary-action"
                    disabled={saving || rows === null} onClick={save}>
              {saving ? "Saving" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
