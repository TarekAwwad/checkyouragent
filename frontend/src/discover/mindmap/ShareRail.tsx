import React from "react";
import type { UsagePhase } from "../../api/types";

interface Props {
  phases: UsagePhase[];
  selectedPhaseKey: string | null;
  onSelect: (phaseKey: string) => void;
  /** Optional second column of shares (compare mode). */
  previousShares?: Record<string, number>;
}

/** The precision rail: exact stacked shares next to the organic map. */
export default function ShareRail({ phases, selectedPhaseKey, onSelect, previousShares }: Props) {
  const active = phases.filter((p) => p.share > 0);
  return (
    <div className="mindmap-rail" aria-label="Exact phase shares">
      {active.map((phase) => {
        const pctNow = Math.round(phase.share * 100);
        const before = previousShares?.[phase.key];
        return (
          <button key={phase.key} type="button"
                  className={`mindmap-rail-row${selectedPhaseKey === phase.key ? " is-selected" : ""}`}
                  onClick={() => onSelect(phase.key)}>
            <span className="mindmap-rail-bar">
              <span className={`mindmap-rail-fill is-${phase.key}`}
                    style={{ width: `${Math.max(2, phase.share * 100)}%` }} />
              {before !== undefined && (
                <span className="mindmap-rail-ghost"
                      style={{ width: `${Math.max(1, before * 100)}%` }} />
              )}
            </span>
            <span className="mindmap-rail-text">{phase.label} {pctNow}%</span>
          </button>
        );
      })}
    </div>
  );
}
