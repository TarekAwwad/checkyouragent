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
// JSON files only — pick one from this browser or point at a server-visible path.
// The app never uploads, and bundles carry no prompts/paths/commands/content.
export default function TeamBundleImport() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: getRuntimeConfig });
  const imports = useQuery({ queryKey: ["team-import-list"], queryFn: listTeamImports });
  const [importPath, setImportPath] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const importer = useMutation({
    mutationFn: async () => {
      if (selectedFile) {
        const text = await readLocalFile(selectedFile);
        return importTeamBundleFile(selectedFile.name, JSON.parse(text) as unknown);
      }
      return importTeamBundle(importPath.trim() || null);
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
  const importTarget = selectedFile?.name || importPath.trim() || "";
  const bundleRoot = config.data?.team_bundle_root ?? null;

  return (
    <main className="page team-import-page">
      <section className="card team-data-sources" aria-labelledby="team-import-title">
        <div className="card-head">
          <h2 id="team-import-title">Import a team bundle</h2>
          <span className="card-count">Local JSON only — no uploads, no content</span>
        </div>

        <div className="team-ds-root">
          <span>team_bundle_root</span>
          <code>
            <Blurred>{bundleRoot || "Not configured"}</Blurred>
          </code>
        </div>

        <div className="team-ds-single">
          <p>Choose a bundle JSON from this browser, or enter a server-visible path.</p>
          <div className="team-import-controls">
            <label className="team-file-picker">
              <span>Bundle file</span>
              <input
                aria-label="Choose local team bundle file"
                type="file"
                accept=".json,application/json"
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <input
              aria-label="Optional server-visible team bundle path"
              value={importPath}
              onChange={(event) => setImportPath(event.target.value)}
              placeholder="Optional server-visible JSON path"
            />
            <button
              type="button"
              className="contribute-primary-button"
              onClick={() => importer.mutate()}
              disabled={importer.isPending || !importTarget}
            >
              <FolderInput size={15} aria-hidden="true" />
              {importer.isPending ? "Importing…" : "Import bundle"}
            </button>
          </div>
          {importer.isSuccess && importer.data ? (
            <div className="flow-result">
              <FileJson size={14} aria-hidden="true" />
              <code>
                <Blurred>{importTarget}</Blurred>
              </code>
              <span>
                {importer.data.status === "replaced" && "Replaced this member's previous bundle."}
                {importer.data.status === "duplicate" && "Already imported — nothing changed."}
                {importer.data.status === "stale" && "Older than this member's current bundle — nothing changed."}
                {importer.data.status === "imported" && `Imported ${importer.data.session_count} sessions.`}
              </span>
            </div>
          ) : null}
          {importer.isError && (
            <span className="flow-error">Import failed: {errorMessage(importer.error)}. The team dashboard was not changed.</span>
          )}
        </div>

        <section className="team-import-list" aria-label="Imported team bundles">
          <div className="team-import-list-head">
            <h3>Imported team bundles</h3>
            <strong>{compactInt(importedRecords.length)}</strong>
          </div>
          {imports.isError ? (
            <p className="flow-error">Could not read the team bundle import list.</p>
          ) : importedRecords.length > 0 ? (
            <ul>
              {importedRecords.map((record, index) => (
                <li key={importRecordId(record, index)}>
                  <div>
                    <strong>
                      <Blurred>{record.member_name ?? record.member_id ?? record.bundle_id ?? "team bundle"}</Blurred>
                    </strong>
                    <span className="team-level-tag">{record.privacy_level ?? "structural"}</span>
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
        </section>
      </section>
    </main>
  );
}
