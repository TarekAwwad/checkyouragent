import React from "react";
import type { TechniqueProps } from "../techniques";
import UsageCharacteristicsPanel from "../mindmap/UsageCharacteristicsPanel";

// Explore technique: the /usage-style "what's driving your usage" view, promoted
// from the mindmap's dialog to a first-class page. Same shared panel body; the
// page adds a project filter and the standard discover-page chrome. onOpenSession
// is part of the TechniqueProps contract but unused here.
export default function UsageDrivers({ projects }: TechniqueProps) {
  const [projectId, setProjectId] = React.useState<number | null>(null);

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <div className="discover-toolbar" aria-label="Usage drivers controls">
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
        <section className="usage-drivers-body">
          <UsageCharacteristicsPanel projectId={projectId} enabled />
        </section>
      </div>
    </main>
  );
}
