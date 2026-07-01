import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Download, FileJson } from "lucide-react";
import { exportTeamBundle, getRuntimeConfig, getTeamPreview } from "../api/client";
import type { ContributionSession } from "../contribute/specimen";
import { Blurred } from "../shell/Blurred";
import PrivacyLedger from "../contribute/PrivacyLedger";
import SpecimenModal from "../contribute/SpecimenModal";

function sessionsFromBundle(value: unknown): ContributionSession[] {
  return Array.isArray(value) ? (value as ContributionSession[]) : [];
}

// Local-scope "Export": write a content-free team bundle from this machine's
// sessions and share it through a team-approved channel. The privacy ledger
// spells out exactly what leaves the machine; nothing is ever uploaded.
export default function TeamBundleExport() {
  const config = useQuery({ queryKey: ["config"], queryFn: getRuntimeConfig });
  const preview = useQuery({ queryKey: ["team-preview"], queryFn: getTeamPreview });
  const [specimenOpen, setSpecimenOpen] = useState(false);

  const exporter = useMutation({ mutationFn: exportTeamBundle });

  const manifest = preview.data?.manifest;
  const sessions = sessionsFromBundle(preview.data?.bundle.sessions);
  const sample = sessions[0];
  const hasLocalSessions = (manifest?.session_count ?? sessions.length) > 0;
  const exportedPath = exporter.data?.path ?? null;
  const bundleRoot = config.data?.team_bundle_root ?? null;

  return (
    <main className="page team-export-page">
      <section className="card team-data-sources" aria-labelledby="team-export-title">
        <div className="card-head">
          <h2 id="team-export-title">Export a team bundle</h2>
          <span className="card-count">Local JSON only — no uploads, no content</span>
        </div>

        <div className="team-ds-root">
          <span>team_bundle_root</span>
          <code>
            <Blurred>{bundleRoot || "Not configured"}</Blurred>
          </code>
        </div>

        <div className="team-ds-single">
          <p>Writes a local JSON bundle under team_bundle_root. Share it through your team-approved channel.</p>
          <button
            type="button"
            className="contribute-primary-button"
            onClick={() => exporter.mutate()}
            disabled={exporter.isPending || !hasLocalSessions}
          >
            {exporter.isSuccess ? <Check size={15} strokeWidth={3} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
            {exporter.isPending ? "Exporting…" : "Export bundle"}
          </button>
          {!hasLocalSessions && <span className="flow-error">No local sessions are available for export.</span>}
          {exportedPath ? (
            <div className="flow-result">
              <FileJson size={14} aria-hidden="true" />
              <code>
                <Blurred>{exportedPath}</Blurred>
              </code>
            </div>
          ) : null}
          {exporter.isError && <span className="flow-error">Export failed; no local team bundle was written.</span>}
        </div>

        {manifest ? (
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
        ) : null}
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
