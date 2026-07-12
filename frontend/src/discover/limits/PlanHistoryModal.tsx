import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../../api/client";
import type { PlanEra } from "../../api/types";

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
          <p className="limit-footnote">
            Which subscription you were on, and since when. Eras split the
            timeline and the measured cap zones. Leave empty for a single view.
          </p>
          {(rows ?? []).map((row, i) => (
            <div key={i} className="plan-row">
              <input aria-label={`Plan name ${i + 1}`} placeholder="Pro / Max 5x / Max 20x"
                     value={row.plan}
                     onChange={(e) => setRow(i, { plan: e.target.value })} />
              <input aria-label={`Start date ${i + 1}`} type="date" value={row.start_date}
                     onChange={(e) => setRow(i, { start_date: e.target.value })} />
              <button type="button" aria-label={`Remove plan ${i + 1}`}
                      onClick={() => setRows((r) => r!.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <div className="plan-actions">
            <button type="button"
                    onClick={() => setRows((r) => [...(r ?? []), { plan: "", start_date: "" }])}>
              Add plan
            </button>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" disabled={saving || rows === null} onClick={save}>
              {saving ? "Saving" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
