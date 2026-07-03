import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, FileJson, Lock } from "lucide-react";
import { exportTeamBundle, getRuntimeConfig, getTeamPreview, getTeamProjects } from "../api/client";
import type { TeamExportRequestBody, TeamPrivacyLevel } from "../api/types";
import type { ContributionSession } from "../contribute/specimen";
import { compactInt } from "../contribute/specimen";
import { Blurred } from "../shell/Blurred";
import PrivacyLedger from "../contribute/PrivacyLedger";
import SpecimenModal from "../contribute/SpecimenModal";

const LEVELS: { id: TeamPrivacyLevel; label: string; hint: string }[] = [
  {
    id: "structural",
    label: "Structural",
    hint: "Fully pseudonymous: hashed ids, bucketed names, zero free text.",
  },
  {
    id: "team",
    label: "Team",
    hint: "Adds your name, project names, tool names, and file types — still no conversation content.",
  },
];
// Reserved ladder rungs (raw session sharing) — visible so the ladder reads as one axis.
const PLANNED_LEVELS = ["Sessions", "Raw"];

function sessionsFromBundle(value: unknown): ContributionSession[] {
  return Array.isArray(value) ? (value as ContributionSession[]) : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown export error";
}

// Local-scope "Export": write a content-free team bundle from this machine's
// sessions and share it through a team-approved channel. The exporter picks a
// privacy level: structural (anonymous) or team (named, for per-user/per-project
// dashboards). The privacy ledger spells out exactly what leaves the machine.
export default function TeamBundleExport() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: getRuntimeConfig });
  const projectsQuery = useQuery({ queryKey: ["team-projects"], queryFn: getTeamProjects });
  const [specimenOpen, setSpecimenOpen] = useState(false);

  // null = untouched; fall back to persisted prefs until the user edits a control.
  const [levelState, setLevelState] = useState<TeamPrivacyLevel | null>(null);
  const [nameState, setNameState] = useState<string | null>(null);
  const [deselectedState, setDeselectedState] = useState<Set<string> | null>(null);
  const [labelsState, setLabelsState] = useState<Record<string, string> | null>(null);

  const prefs = projectsQuery.data?.prefs;
  const entries = projectsQuery.data?.projects ?? [];
  const level: TeamPrivacyLevel = levelState ?? (prefs?.privacy_level === "team" ? "team" : "structural");
  const memberName = nameState ?? prefs?.member_name ?? "";
  const deselected = deselectedState ?? new Set(prefs?.deselected ?? []);
  const labels = labelsState ?? prefs?.project_labels ?? {};

  const selected = entries.filter((entry) => !deselected.has(entry.export_name));
  const previewBody: TeamExportRequestBody = useMemo(
    () => ({
      privacy_level: level,
      projects: selected.map((entry) => ({
        export_name: entry.export_name,
        label: labels[entry.export_name]?.trim() || null,
      })),
    }),
    [level, selected, labels],
  );

  const preview = useQuery({
    queryKey: ["team-preview", previewBody],
    queryFn: () => getTeamPreview(previewBody),
    enabled: selected.length > 0,
  });

  const exporter = useMutation({
    // Structural bundles never carry a name — even a stale one still resolved from
    // prefs after switching down from team level (the name field is hidden there).
    mutationFn: () =>
      exportTeamBundle({ ...previewBody, member_name: level === "team" ? memberName.trim() || null : null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["team-projects"] }),
  });

  const manifest = preview.data?.manifest;
  const sessions = sessionsFromBundle(preview.data?.bundle.sessions);
  const sample = sessions[0];
  const sessionCount = manifest?.session_count ?? sessions.length;
  const selectedTokens = selected.reduce((total, entry) => total + entry.tokens, 0);
  const needsName = level === "team" && memberName.trim().length === 0;
  const exportedPath = exporter.data?.path ?? null;
  const bundleRoot = config.data?.team_bundle_root ?? null;

  const toggleProject = (exportName: string) => {
    const next = new Set(deselected);
    if (next.has(exportName)) next.delete(exportName);
    else next.add(exportName);
    setDeselectedState(next);
  };

  const commitLabel = (exportName: string, value: string) => {
    setLabelsState({ ...labels, [exportName]: value.trim() });
  };

  return (
    <main className="page team-flow-page team-export-page">
      <section className="contribute-header team-flow-header" aria-labelledby="team-export-title">
        <div className="contribute-titleblock team-titleblock">
          <h1 id="team-export-title">Export a team bundle</h1>
          <p>
            Package local session structure into a content-free JSON bundle for teammates. The app
            writes locally only, and the privacy level controls whether names travel with it.
          </p>
          <div className="team-root-row">
            <span>team_bundle_root</span>
            <code>
              <Blurred>{bundleRoot || "Not configured"}</Blurred>
            </code>
          </div>
        </div>

        <div className="contribute-metrics team-metrics team-flow-metrics" aria-label="Team export summary">
          <Metric value={`${selected.length}/${entries.length || 0}`} label="Projects" />
          <Metric value={sessionCount} label="Sessions" />
          <Metric value={selectedTokens} label="Tokens" />
          <Metric value={level === "team" ? "Named" : "Anonymous"} label="Privacy" mono={false} />
        </div>
      </section>

      <section className="team-flow-body team-export-layout" aria-label="Team export workspace">
        <div className="team-flow-column">
          <section className="card team-flow-card">
            <div className="card-head">
              <h2>Privacy level</h2>
              <span className="card-count">Local JSON only</span>
            </div>
            <div className="team-flow-card-body team-flow-stack">
              <div className="team-level-selector" role="radiogroup" aria-label="Export privacy level">
                {LEVELS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={level === option.id}
                    className={level === option.id ? "team-level active" : "team-level"}
                    onClick={() => setLevelState(option.id)}
                    title={option.hint}
                  >
                    {option.label}
                  </button>
                ))}
                {PLANNED_LEVELS.map((label) => (
                  <button key={label} type="button" className="team-level planned" disabled title="Planned: raw session sharing">
                    <Lock size={12} aria-hidden="true" /> {label}
                  </button>
                ))}
              </div>
              <p className="team-level-hint">{LEVELS.find((option) => option.id === level)?.hint}</p>

              {level === "team" ? (
                <label className="team-member-name">
                  <span>Your name</span>
                  <input
                    aria-label="Team member name"
                    value={memberName}
                    maxLength={80}
                    placeholder="Shown to everyone who imports this bundle"
                    onChange={(event) => setNameState(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
          </section>

          <section className="card team-flow-card">
            <div className="card-head">
              <h2>Export workflow</h2>
              <span className="card-count">Share through your approved channel</span>
            </div>
            <div className="team-flow-card-body team-flow-stack">
              <p className="team-flow-copy">
                Writes a local JSON bundle under team_bundle_root. Each export replaces your previous
                bundle for teammates who import it.
              </p>
              <button
                type="button"
                className="contribute-primary-button"
                onClick={() => exporter.mutate()}
                disabled={exporter.isPending || selected.length === 0 || sessionCount === 0 || needsName}
              >
                {exporter.isSuccess ? <Check size={15} strokeWidth={3} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
                {exporter.isPending ? "Exporting…" : "Export bundle"}
              </button>
              <div className="team-flow-errors" aria-live="polite">
                {needsName && <span className="flow-error">Enter your name to export a team-level bundle.</span>}
                {selected.length === 0 && <span className="flow-error">Select at least one project.</span>}
                {selected.length > 0 && sessionCount === 0 && (
                  <span className="flow-error">No sessions in the current selection.</span>
                )}
                {exporter.isError && (
                  <span className="flow-error">Export failed: {errorMessage(exporter.error)}. No local team bundle was written.</span>
                )}
              </div>
              {exportedPath ? (
                <div className="flow-result">
                  <FileJson size={14} aria-hidden="true" />
                  <code>
                    <Blurred>{exportedPath}</Blurred>
                  </code>
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <div className="team-flow-column team-flow-column-wide">
          <section className="card team-flow-card team-scroll-card team-project-picker" aria-label="Projects to export">
            <div className="card-head">
              <h2>Projects in this bundle</h2>
              <span className="card-count">
                <b>{selected.length}</b> of {entries.length}
              </span>
            </div>
            <div className="team-flow-card-body team-flow-scroll-body">
              <p className="team-picker-note">
                Each export replaces your entire previous bundle for teammates who import it. Unchecked
                projects are removed from their dashboards, and deselection is remembered for next time.
              </p>
              {projectsQuery.isError ? (
                <p className="flow-error">Could not read the local project list.</p>
              ) : (
                <ul>
                  {entries.map((entry) => {
                    const checked = !deselected.has(entry.export_name);
                    const committed = labels[entry.export_name];
                    return (
                      <li key={entry.export_name} className={checked ? undefined : "is-disabled"}>
                        <input
                          type="checkbox"
                          checked={checked}
                          aria-label={`Include ${entry.default_label}`}
                          onChange={() => toggleProject(entry.export_name)}
                        />
                        <div className="team-project-copy">
                          {level === "team" ? (
                            <input
                              className="team-project-label"
                              aria-label={`Label for ${entry.default_label}`}
                              key={`${entry.export_name}:${committed ?? ""}`}
                              defaultValue={committed || entry.default_label}
                              maxLength={120}
                              disabled={!checked}
                              onBlur={(event) => commitLabel(entry.export_name, event.target.value)}
                            />
                          ) : (
                            <span className="team-project-label-static">
                              <Blurred>{entry.default_label}</Blurred>
                            </span>
                          )}
                          <span className="team-project-export-id">
                            <Blurred>{entry.export_name}</Blurred>
                          </span>
                        </div>
                        <span className="team-project-meta">
                          {compactInt(entry.session_count)} sessions · {compactInt(entry.tokens)} tok
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {manifest ? (
            <section className="card team-flow-card team-ledger-card">
              <PrivacyLedger
                title="What stays vs. what goes into the team bundle"
                caveat={manifest.fingerprint_caveat}
                excluded={manifest.excluded}
                included={manifest.included_fields}
                staysTitle="Stays on this machine"
                travelsTitle="Goes into the team bundle"
                specimenDescription="Inspect the exact first session in the team bundle."
                emptyDescription="No sessions are available for a team bundle yet."
                hasSpecimen={Boolean(sample)}
                onInspectSpecimen={() => setSpecimenOpen(true)}
              />
            </section>
          ) : null}
        </div>
      </section>

      {sample ? (
        <SpecimenModal
          sample={sample}
          open={specimenOpen}
          onClose={() => setSpecimenOpen(false)}
          title="First team bundle session"
          description="The exact first session in the team bundle, shown as structured fields or raw JSON."
          blurRaw
        />
      ) : null}
    </main>
  );
}

function Metric({
  value,
  label,
  mono = true,
}: {
  value: number | string;
  label: string;
  mono?: boolean;
}) {
  return (
    <div className="contribute-metric">
      <strong className={mono ? undefined : "team-metric-text"}>
        {typeof value === "number" ? compactInt(value) : value}
      </strong>
      <span>{label}</span>
    </div>
  );
}
