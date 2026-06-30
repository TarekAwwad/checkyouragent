import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Check, Download, FileJson, Lock, ScanSearch } from "lucide-react";
import { exportContribution, getContributionPreview } from "../api/client";
import { type ContributionSession, compactInt } from "./specimen";
import SpecimenModal from "./SpecimenModal";

// Contributions go to an open, public dataset repo. Step 2 deep-links to GitHub's
// file-upload page for the contributions/ folder; for anyone without write access
// GitHub forks and opens a pull request automatically. The app never uploads
// anything itself — this is the user's own click, and the dataset stays auditable.
// TODO(confirm): create the dataset repo, then confirm owner/name + default branch.
const CONTRIBUTION_UPLOAD_URL =
  "https://github.com/TarekAwwad/claude-code-usage-corpus/upload/main/contributions";

export default function ContributePage() {
  const preview = useQuery({ queryKey: ["contribution-preview"], queryFn: getContributionPreview });
  const exporter = useMutation({ mutationFn: exportContribution });
  const [specimenOpen, setSpecimenOpen] = useState(false);

  const sessions = useMemo(
    () => (preview.data?.bundle.sessions ?? []) as ContributionSession[],
    [preview.data],
  );

  if (preview.isLoading) {
    return (
      <main className="page contribute-page">
        <div className="contribute-state">Building privacy-preserving preview...</div>
      </main>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <main className="page contribute-page">
        <div className="contribute-state panel-error">
          <strong>Contribution preview failed.</strong>
          <span>Could not build a contribution preview.</span>
        </div>
      </main>
    );
  }

  const { manifest } = preview.data;
  const sample = sessions[0];
  const exportedPath = exporter.data?.path;
  const exported = exporter.isSuccess && Boolean(exportedPath);
  const sessionCount = compactInt(manifest.session_count);
  const sequenceStepCount = compactInt(manifest.sequence_step_count);

  return (
    <main className="page contribute-page">
      <section className="contribute-header" aria-labelledby="contribute-title">
        <div className="contribute-titleblock">
          <h1 id="contribute-title">Contribute usage structure</h1>
          <p>
            Share aggregate session shape for usage-pattern research without prompts, assistant text,
            file paths, command text, or other free-form content.
          </p>
        </div>

        <div className="contribute-metrics" aria-label="Contribution preview">
          <div className="contribute-metric">
            <strong>{sessionCount}</strong>
            <span>Sessions</span>
          </div>
          <div className="contribute-metric">
            <strong>{sequenceStepCount}</strong>
            <span>Sequence steps</span>
          </div>
        </div>
      </section>

      <section className="contribute-flow" aria-label="Contribution workflow">
        <div className={`flow-step ${exported ? "is-complete" : "is-current"}`}>
          <span className="flow-index">{exported ? <Check size={13} strokeWidth={3} /> : "1"}</span>
          <div className="flow-content">
            <h2>Export locally</h2>
            <p>Creates a JSON file in your configured data directory. Nothing is uploaded by the app.</p>
            <button
              type="button"
              className="contribute-primary-button"
              onClick={() => exporter.mutate()}
              disabled={exporter.isPending}
            >
              <Download size={15} aria-hidden="true" />
              {exporter.isPending ? "Exporting..." : "Export bundle"}
            </button>
            {exported ? (
              <div className="flow-result">
                <FileJson size={14} aria-hidden="true" />
                <code>{exportedPath}</code>
              </div>
            ) : null}
            {exporter.isError && <span className="flow-error">Export failed; nothing was written.</span>}
          </div>
        </div>

        <ArrowRight className="flow-arrow" size={18} aria-hidden="true" />

        <div className={`flow-step ${exported ? "is-current" : "is-waiting"}`}>
          <span className="flow-index">2</span>
          <div className="flow-content">
            <h2>Add to the dataset</h2>
            <p>Drag the file into the public dataset. GitHub opens a pull request you can review — open and auditable, nothing hidden.</p>
            <a
              className={exported ? "contribute-primary-button" : "contribute-secondary-button"}
              href={CONTRIBUTION_UPLOAD_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              Upload to the dataset <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      <section className="privacy-ledger" aria-labelledby="privacy-ledger-title">
        <div className="privacy-ledger-head">
          <h2 id="privacy-ledger-title">What stays vs. what travels</h2>
          <p className="privacy-note" role="note">{manifest.fingerprint_caveat}</p>
        </div>

        <div className="privacy-grid">
          <section className="privacy-column stays" aria-labelledby="privacy-stays">
            <h2 id="privacy-stays">
              <Lock size={13} aria-hidden="true" /> Stays on this machine
            </h2>
            <ul>
              {manifest.excluded.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </section>

          <section className="privacy-column travels" aria-labelledby="privacy-travels">
            <h2 id="privacy-travels">
              <ArrowUpRight size={13} aria-hidden="true" /> Travels in the bundle
            </h2>
            <ul>
              {manifest.included_fields.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </section>
        </div>

        <div className="ledger-foot">
          {sample ? (
            <>
              <span>Full transparency — inspect the exact first session that will be exported.</span>
              <button
                type="button"
                className="specimen-trigger"
                onClick={() => setSpecimenOpen(true)}
              >
                <ScanSearch size={14} aria-hidden="true" /> Inspect specimen
              </button>
            </>
          ) : (
            <span>No sessions are available for export yet.</span>
          )}
        </div>
      </section>

      {sample ? (
        <SpecimenModal sample={sample} open={specimenOpen} onClose={() => setSpecimenOpen(false)} />
      ) : null}
    </main>
  );
}
