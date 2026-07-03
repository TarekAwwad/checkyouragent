import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileJson, FolderInput } from "lucide-react";
import {
  deleteTeamMember,
  getRuntimeConfig,
  importTeamBundle,
  importTeamBundleFile,
  listTeamImports,
} from "../api/client";
import type { TeamImportRecord } from "../api/types";
import { Blurred } from "../shell/Blurred";
import { compactInt } from "../contribute/specimen";

function importRecordId(record: TeamImportRecord, index: number): string {
  return record.bundle_id ?? record.member_id ?? record.source_path ?? `team-import-${index}`;
}

type FileImportStatus = "imported" | "replaced" | "duplicate" | "stale" | "failed";

interface FileImportResult {
  filename: string;
  status: FileImportStatus;
  session_count?: number;
  error?: string;
}

// Human-readable outcome for one bundle in a batch — mirrors the backend's
// import status vocabulary so single- and multi-file imports read the same.
function resultMessage(result: FileImportResult): string {
  switch (result.status) {
    case "replaced":
      return "Replaced this member's previous bundle.";
    case "duplicate":
      return "Already imported — nothing changed.";
    case "stale":
      return "Older than this member's current bundle — nothing changed.";
    case "failed":
      return `Import failed: ${result.error ?? "unknown error"}.`;
    case "imported":
    default:
      return `Imported ${result.session_count ?? 0} sessions.`;
  }
}

function readLocalFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read selected team bundle."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown import error";
}

// Team-scope "Import": bring in content-free bundles other members shared. Local
// JSON files only — pick one or more from this browser or point at a server-visible
// path. The app never uploads, and bundles carry no prompts/paths/commands/content.
export default function TeamBundleImport() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: getRuntimeConfig });
  const imports = useQuery({ queryKey: ["team-import-list"], queryFn: listTeamImports });
  const [importPath, setImportPath] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileResults, setFileResults] = useState<FileImportResult[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const importer = useMutation({
    mutationFn: async () => {
      // Browser files take precedence over the server path. Each file is
      // imported sequentially — the backend resolves replace/duplicate/stale
      // from stored state, so order does not matter and sequential writes keep
      // SQLite from contending with itself.
      if (selectedFiles.length) {
        const results: FileImportResult[] = [];
        setProgress({ done: 0, total: selectedFiles.length });
        for (const file of selectedFiles) {
          try {
            const text = await readLocalFile(file);
            const parsed = JSON.parse(text) as unknown;
            const res = await importTeamBundleFile(file.name, parsed);
            results.push({ filename: file.name, status: res.status as FileImportStatus, session_count: res.session_count });
          } catch (error) {
            // One bad file (unreadable, invalid JSON, rejected import) is
            // recorded and skipped so the rest of the batch still imports.
            results.push({ filename: file.name, status: "failed", error: errorMessage(error) });
          }
          setProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
          setFileResults([...results]);
        }
        setProgress(null);
        return results;
      }
      const res = await importTeamBundle(importPath.trim() || null);
      const single: FileImportResult = {
        filename: importPath.trim(),
        status: res.status as FileImportStatus,
        session_count: res.session_count,
      };
      setFileResults([single]);
      return [single];
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-import-list"] });
      queryClient.invalidateQueries({ queryKey: ["team-dashboard"] });
    },
  });

  const removeMember = useMutation({
    mutationFn: (memberId: string) => deleteTeamMember(memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["team-import-list"] });
      queryClient.invalidateQueries({ queryKey: ["team-dashboard"] });
    },
  });

  const importedRecords = imports.data ?? [];
  const importedSessionCount = importedRecords.reduce((total, record) => total + (record.session_count ?? 0), 0);
  const importedMemberCount = new Set(
    importedRecords.map((record, index) => record.member_id ?? record.member_name ?? importRecordId(record, index)),
  ).size;
  const hasFiles = selectedFiles.length > 0;
  const canImport = hasFiles || importPath.trim().length > 0;
  const bundleRoot = config.data?.team_bundle_root ?? null;
  const sourceMode = hasFiles ? (selectedFiles.length > 1 ? "Files" : "File") : importPath.trim() ? "Path" : "Idle";
  const importButtonLabel = selectedFiles.length > 1 ? `Import ${selectedFiles.length} bundles` : "Import bundle";

  return (
    <main className="page team-flow-page team-import-page">
      <section className="contribute-header team-flow-header" aria-labelledby="team-import-title">
        <div className="contribute-titleblock team-titleblock">
          <h1 id="team-import-title">Import a team bundle</h1>
          <p>
            Bring in content-free bundles your teammates shared. You can import one or more local
            JSON files in the browser or a server-visible path without uploading conversation data.
          </p>
          <div className="team-root-row">
            <span>team_bundle_root</span>
            <code>
              <Blurred>{bundleRoot || "Not configured"}</Blurred>
            </code>
          </div>
        </div>

        <div className="contribute-metrics team-metrics team-flow-metrics" aria-label="Team import summary">
          <Metric value={importedRecords.length} label="Bundles" />
          <Metric value={importedMemberCount} label="Members" />
          <Metric value={importedSessionCount} label="Sessions" />
          <Metric value={sourceMode} label="Source" mono={false} />
        </div>
      </section>

      <section className="team-flow-body team-import-layout" aria-label="Team import workspace">
        <div className="team-flow-column">
          <section className="card team-flow-card">
            <div className="card-head">
              <h2>Import sources</h2>
              <span className="card-count">Local JSON only</span>
            </div>
            <div className="team-flow-card-body team-flow-stack">
              <p className="team-flow-copy">
                Choose one or more bundle JSONs from this browser, or point to a server-visible file
                when the backend can already read that location.
              </p>
              <div className="team-mini-summary" aria-label="Supported import sources">
                <span>Browser file</span>
                <span>Server path</span>
                <span>No prompts or content</span>
              </div>
            </div>
          </section>

          <section className="card team-flow-card">
            <div className="card-head">
              <h2>Import workflow</h2>
              <span className="card-count">Replaces stale bundles automatically</span>
            </div>
            <div className="team-flow-card-body team-flow-stack">
              <div className="team-import-controls">
                <label className="team-file-picker">
                  <span>Bundle files</span>
                  <input
                    aria-label="Choose local team bundle files"
                    type="file"
                    multiple
                    accept=".json,application/json"
                    onChange={(event) => {
                      setSelectedFiles(Array.from(event.target.files ?? []));
                      setFileResults(null);
                    }}
                  />
                </label>
                <label className="team-path-field">
                  <span>Server-visible path</span>
                  <input
                    aria-label="Optional server-visible team bundle path"
                    value={importPath}
                    onChange={(event) => setImportPath(event.target.value)}
                    placeholder="Optional server-visible JSON path"
                  />
                </label>
                <button
                  type="button"
                  className="contribute-primary-button"
                  onClick={() => importer.mutate()}
                  disabled={importer.isPending || !canImport}
                >
                  <FolderInput size={15} aria-hidden="true" />
                  {importer.isPending ? "Importing…" : importButtonLabel}
                </button>
              </div>

              {hasFiles && !importer.isPending ? (
                <span className="team-file-count">
                  {selectedFiles.length} file{selectedFiles.length === 1 ? "" : "s"} selected
                </span>
              ) : null}

              {importer.isPending && progress ? (
                <span className="team-import-progress" role="status">
                  Importing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
                </span>
              ) : null}

              {fileResults && fileResults.length > 0 ? (
                <div className="team-import-results" aria-label="Import results">
                  {fileResults.map((result, index) => (
                    <div
                      key={`${result.filename}-${index}`}
                      className={result.status === "failed" ? "flow-result flow-error" : "flow-result"}
                    >
                      <FileJson size={14} aria-hidden="true" />
                      <code>
                        <Blurred>{result.filename}</Blurred>
                      </code>
                      <span>{resultMessage(result)}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {importer.isError && (
                <span className="flow-error">Import failed: {errorMessage(importer.error)}. The team dashboard was not changed.</span>
              )}
            </div>
          </section>
        </div>

        <section className="team-import-list team-flow-card team-scroll-card" aria-label="Imported team bundles">
          <div className="card-head">
            <h2>Imported team bundles</h2>
            <span className="card-count">
              <b>{compactInt(importedRecords.length)}</b> active
            </span>
          </div>
          <div className="team-flow-card-body team-flow-scroll-body">
            <p className="team-flow-copy">
              Newer imports replace older bundles from the same member. Remove a member to drop all
              of their imported bundles from the team dashboard.
            </p>
            {imports.isError ? (
              <p className="flow-error">Could not read the team bundle import list.</p>
            ) : importedRecords.length > 0 ? (
              <ul>
                {importedRecords.map((record, index) => (
                  <li key={importRecordId(record, index)}>
                    <div>
                      <div className="team-import-member-head">
                        <strong>
                          <Blurred>{record.member_name ?? record.member_id ?? record.bundle_id ?? "team bundle"}</Blurred>
                        </strong>
                        <span className="team-level-tag" data-level={record.privacy_level ?? "structural"}>
                          {record.privacy_level ?? "structural"}
                        </span>
                      </div>
                      <span>
                        {compactInt(record.session_count)} sessions
                        {record.generated_at ? ` · generated ${record.generated_at}` : ""}
                      </span>
                    </div>
                    {record.source_path ? (
                      <code>
                        <Blurred>{record.source_path}</Blurred>
                      </code>
                    ) : null}
                    <button
                      type="button"
                      className="team-remove-member"
                      aria-label={`Remove ${record.member_name ?? record.member_id ?? "member"}`}
                      disabled={removeMember.isPending}
                      onClick={() => {
                        const display = record.member_name ?? record.member_id;
                        if (record.member_id && window.confirm(`Remove all imported bundles from ${display}?`)) {
                          removeMember.mutate(record.member_id);
                        }
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No team bundles have been imported yet.</p>
            )}
            {removeMember.isError && (
              <span className="flow-error">Remove failed: {errorMessage(removeMember.error)}. The team dashboard was not changed.</span>
            )}
          </div>
        </section>
      </section>
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
