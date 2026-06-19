import { useMutation, useQuery } from "@tanstack/react-query";
import { exportContribution, getContributionPreview } from "../api/client";

export default function ContributePage() {
  const preview = useQuery({ queryKey: ["contribution-preview"], queryFn: getContributionPreview });
  const exporter = useMutation({ mutationFn: exportContribution });

  if (preview.isLoading) return <div className="page">Building privacy-preserving preview…</div>;
  if (preview.isError || !preview.data) return <div className="page">Could not build a contribution preview.</div>;

  const { manifest, bundle } = preview.data;
  const sample = (bundle.sessions as unknown[] | undefined)?.[0];

  return (
    <div className="page contribute-page">
      <h1>Contribute Data</h1>
      <p>
        Share <strong>{manifest.session_count} sessions</strong> ({manifest.sequence_step_count} sequence
        steps) of usage <em>structure</em> to help research more efficient usage patterns. Nothing leaves
        your machine until you click Export.
      </p>

      <section>
        <h2>Included (structure only)</h2>
        <ul>{manifest.included_fields.map((f) => <li key={f}>{f}</li>)}</ul>
      </section>

      <section>
        <h2>Never included</h2>
        <ul>{manifest.excluded.map((f) => <li key={f}>{f}</li>)}</ul>
      </section>

      <p className="caveat" role="note">{manifest.fingerprint_caveat}</p>

      <section>
        <h2>Sample (the literal first row that would be sent)</h2>
        <pre>{JSON.stringify(sample ?? {}, null, 2)}</pre>
      </section>

      <button type="button" onClick={() => exporter.mutate()} disabled={exporter.isPending}>
        {exporter.isPending ? "Exporting…" : "Export bundle"}
      </button>

      {exporter.isSuccess && <p className="export-result">Saved to {exporter.data.path}</p>}
      {exporter.isError && <p className="export-error">Export failed.</p>}
    </div>
  );
}
