import { AlertTriangle, ArrowUpRight, Lock, ScanSearch } from "lucide-react";

interface Props {
  title?: string;
  caveat: string;
  excluded: string[];
  included: string[];
  staysTitle?: string;
  travelsTitle?: string;
  specimenLabel?: string;
  specimenDescription?: string;
  emptyDescription?: string;
  hasSpecimen: boolean;
  onInspectSpecimen: () => void;
}

export default function PrivacyLedger({
  title = "What stays vs. what travels",
  caveat,
  excluded,
  included,
  staysTitle = "Stays on this machine",
  travelsTitle = "Travels in the bundle",
  specimenLabel = "Inspect specimen",
  specimenDescription = "Inspect the exact first session that will be exported.",
  emptyDescription = "No sessions are available for export yet.",
  hasSpecimen,
  onInspectSpecimen,
}: Props) {
  return (
    <section className="privacy-ledger" aria-labelledby="privacy-ledger-title">
      <div className="privacy-ledger-head">
        <h2 id="privacy-ledger-title">{title}</h2>
        <p className="privacy-note privacy-warning" role="note">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{caveat}</span>
        </p>
      </div>

      <div className="privacy-grid">
        <section className="privacy-column stays" aria-labelledby="privacy-stays">
          <h2 id="privacy-stays">
            <Lock size={13} aria-hidden="true" /> {staysTitle}
          </h2>
          <ul>
            {excluded.map((field) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
        </section>

        <section className="privacy-column travels" aria-labelledby="privacy-travels">
          <h2 id="privacy-travels">
            <ArrowUpRight size={13} aria-hidden="true" /> {travelsTitle}
          </h2>
          <ul>
            {included.map((field) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
        </section>
      </div>

      <div className="ledger-foot">
        {hasSpecimen ? (
          <>
            <span>{specimenDescription}</span>
            <button type="button" className="specimen-trigger" onClick={onInspectSpecimen}>
              <ScanSearch size={14} aria-hidden="true" /> {specimenLabel}
            </button>
          </>
        ) : (
          <span>{emptyDescription}</span>
        )}
      </div>
    </section>
  );
}
