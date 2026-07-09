import React from "react";
import type { TechniqueProps } from "../techniques";
import {
  PRESETS,
  PRESET_LABELS,
  UC_SUBTITLE,
  UsageCharacteristicsRows,
  useUsageCharacteristics,
  type Preset,
} from "../mindmap/UsageCharacteristicsPanel";

// Explore technique: the /usage-style "what's driving your usage" view, promoted
// from the mindmap's dialog to a first-class page. Shares the fetch hook and the
// characteristic rows with the dialog, but wears the Explore page shell: a
// .discover-toolbar header (title + subtitle left, range .discover-tabs + project
// filter right) and the rows inside a .card section. onOpenSession is part of the
// TechniqueProps contract but unused here.
export default function UsageDrivers({ projects }: TechniqueProps) {
  const [projectId, setProjectId] = React.useState<number | null>(null);
  const [preset, setPreset] = React.useState<Preset>("week");
  const query = useUsageCharacteristics(projectId, preset, true);

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <div className="discover-toolbar" aria-label="Usage drivers controls">
          <div className="discover-toolbar-lead">
            <h1>Usage drivers</h1>
            <p className="discover-subtitle">{UC_SUBTITLE}</p>
          </div>
          <div className="discover-tabs" role="group" aria-label="Window">
            {PRESETS.map((p) => (
              <button key={p} type="button" aria-pressed={preset === p}
                      className={preset === p ? "active" : ""}
                      onClick={() => setPreset(p)}>
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>
          <div className="cost-filterbar discover-filterbar">
            <select aria-label="Project" value={projectId ?? ""}
                    onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.display_name}</option>
              ))}
            </select>
          </div>
        </div>

        <section className="card" aria-label="Usage characteristics">
          <div className="card-head">
            <h2>What's driving your usage</h2>
          </div>
          <div className="card-pad usage-drivers-body">
            <UsageCharacteristicsRows query={query} />
          </div>
          {query.data && (
            <p className="usage-drivers-footnote">{query.data.meta.basis_note}</p>
          )}
        </section>
      </div>
    </main>
  );
}
