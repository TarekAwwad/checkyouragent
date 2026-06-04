import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderInput, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react";
import { createImport, discoverSourceProjects, getCacheStats, getImportProgress, getRuntimeConfig, resetImports } from "../api/client";
import type { DiscoveredProject } from "../api/types";
import { useImportRoot } from "./useImportRoot";

function ImportPage() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: getRuntimeConfig });
  const isDocker = config.data?.is_docker ?? false;
  const { root, isOverridden, setRoot, resetToDefault } = useImportRoot(config.data?.import_root);

  const [draft, setDraft] = useState(root);
  useEffect(() => setDraft(root), [root]);

  const projects = useQuery({
    queryKey: ["source-projects", root],
    queryFn: () => discoverSourceProjects(root),
    enabled: root.length > 0,
  });
  const stats = useQuery({ queryKey: ["stats"], queryFn: getCacheStats });

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["source-projects"] }),
      queryClient.invalidateQueries({ queryKey: ["imports"] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      queryClient.invalidateQueries({ queryKey: ["stats"] }),
    ]);
  };

  const importOne = useMutation({
    mutationFn: (name: string) => createImport(root, name),
    onSuccess: invalidateAll,
  });
  const importAll = useMutation({
    mutationFn: () => createImport(root, null),
    onSuccess: invalidateAll,
  });
  const reset = useMutation({
    mutationFn: () => resetImports(),
    onSuccess: invalidateAll,
  });

  const importPending = importOne.isPending || importAll.isPending;
  const mutationPending = importPending || reset.isPending;
  const progress = useQuery({
    queryKey: ["import-progress"],
    queryFn: getImportProgress,
    enabled: importPending,
    refetchInterval: importPending ? 750 : false,
  });
  const pendingName = importOne.isPending ? (importOne.variables as string) : null;

  const discovered = projects.data ?? [];
  const importedCount = discovered.filter((p) => p.imported).length;
  const liveTotals = importPending && progress.data?.active ? progress.data.totals : null;
  const metricTotals = liveTotals ?? stats.data;

  return (
    <main className="page import-page">
      <section className="source-console">
        <div className="console-label">
          <p className="eyebrow">
            Mounted source
            {isDocker && <span className="docker-badge">Docker</span>}
          </p>
          {isOverridden && !isDocker && (
            <button type="button" className="link-reset" onClick={resetToDefault}>
              Reset to default
            </button>
          )}
        </div>

        <form
          className={`scan-field${projects.isFetching ? " is-scanning" : ""}${isDocker ? " is-locked" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!isDocker) setRoot(draft);
          }}
        >
          <span className="scan-glyph" aria-hidden>
            {projects.isFetching ? <RefreshCw size={15} className="spin" /> : <FolderInput size={15} />}
          </span>
          <input
            aria-label="Import source root"
            value={draft}
            onChange={(e) => { if (!isDocker) setDraft(e.target.value); }}
            readOnly={isDocker}
            placeholder={config.isLoading ? "Loading source root…" : "Path to the Claude Code export root"}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          {!isDocker && (
            <button type="submit" className="scan-btn" disabled={!draft.trim() || draft.trim() === root}>
              <Search size={14} />
              <span>Scan</span>
            </button>
          )}
        </form>

        <div className="console-foot">
          {isDocker ? (
            <p className="muted">
              Source path is fixed by the Docker volume mount. To change it, update the <code>volumes</code> mapping in <code>docker-compose.yml</code> and restart the container.
            </p>
          ) : (
            <p className="muted">
              Import projects individually from the read-only export into a rebuildable SQLite cache.
            </p>
          )}
          <div className="console-actions">
            <button
              className="primary-action"
              onClick={() => importAll.mutate()}
              disabled={mutationPending || root.length === 0}
            >
              {importAll.isPending ? <RefreshCw size={15} className="spin" /> : <FolderInput size={15} />}
              <span>{importAll.isPending ? "Importing…" : "Import all new"}</span>
            </button>
            <button
              className="ghost-action danger"
              onClick={() => {
                if (window.confirm("Clear the entire local cache? This removes all imported projects.")) reset.mutate();
              }}
              disabled={mutationPending}
            >
              {reset.isPending ? <RefreshCw size={15} className="spin" /> : <Trash2 size={15} />}
              <span>Reset cache</span>
            </button>
          </div>
        </div>
      </section>

      <section className={`metric-band${liveTotals ? " is-live" : ""}`} aria-label="Cache totals">
        <Metric label="Projects" value={metricTotals?.project_count ?? 0} />
        <Metric label="Sessions" value={metricTotals?.session_count ?? 0} />
        <Metric label="Events" value={metricTotals?.event_count ?? 0} />
        <Metric label="Subagents" value={metricTotals?.subagent_count ?? 0} />
        <Metric label="Memory" value={metricTotals?.memory_count ?? 0} />
        <Metric label="Large outputs" value={metricTotals?.persisted_output_count ?? 0} />
      </section>

      <section className="card history-card">
        <div className="card-head">
          <h2>Projects in source</h2>
          {discovered.length > 0 && (
            <span className="card-count">
              <b>{importedCount}</b> of {discovered.length} imported
            </span>
          )}
        </div>
        {projects.isFetching && <p className="muted card-pad">Scanning source…</p>}
        {projects.error && <p className="error-text card-pad">{(projects.error as Error).message}</p>}
        {root.length > 0 && discovered.length === 0 && !projects.isFetching && !projects.error && (
          <p className="muted card-pad">No project folders found in the source root.</p>
        )}
        {discovered.map((project: DiscoveredProject) => {
          const busy = pendingName === project.name;
          return (
            <div className={`import-row${project.imported ? " is-imported" : ""}`} key={project.name}>
              <span className={`status-dot${project.imported ? " on" : ""}`} aria-hidden="true" />
              <span className="path">{project.name}</span>
              <span className="row-meta">
                {project.imported ? (
                  <>
                    <b>{project.session_count.toLocaleString()}</b> session{project.session_count === 1 ? "" : "s"}
                    {project.last_imported_at && (
                      <span className="row-time"> · {formatImported(project.last_imported_at)}</span>
                    )}
                  </>
                ) : (
                  <span className="muted">Not imported</span>
                )}
              </span>
              <button
                className="ghost-action"
                onClick={() => importOne.mutate(project.name)}
                disabled={mutationPending}
                aria-label={`${project.imported ? "Re-import" : "Import"} ${project.name}`}
              >
                {busy ? <RefreshCw size={14} className="spin" /> : project.imported ? <RotateCcw size={14} /> : <FolderInput size={14} />}
                <span>{busy ? "Importing…" : project.imported ? "Re-import" : "Import"}</span>
              </button>
            </div>
          );
        })}
        {(importOne.error || importAll.error || reset.error) && (
          <p className="error-text card-pad">{((importOne.error || importAll.error || reset.error) as Error).message}</p>
        )}
      </section>
    </main>
  );
}

function formatImported(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "imported";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

export default ImportPage;
