import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FolderInput, RotateCcw, Search, Trash2 } from "lucide-react";
import { createImport, discoverSourceProjects, getCacheStats, getImportProgress, getRuntimeConfig, listImports, loadDemoData, resetImports } from "../api/client";
import type { DiscoveredProject } from "../api/types";
import { useImportRoot } from "./useImportRoot";
import LoadingBar from "../components/LoadingBar";

interface Props {
  onViewCosts?: () => void;
}

function ImportPage({ onViewCosts }: Props) {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["config"], queryFn: getRuntimeConfig });
  const isDocker = config.data?.is_docker ?? false;
  const { root, isOverridden, setRoot, resetToDefault } = useImportRoot(config.data?.import_root);

  const [draft, setDraft] = useState(root);
  useEffect(() => setDraft(root), [root]);

  const stats = useQuery({ queryKey: ["stats"], queryFn: getCacheStats });

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["source-projects"] }),
      queryClient.invalidateQueries({ queryKey: ["imports"] }),
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
      queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      queryClient.invalidateQueries({ queryKey: ["stats"] }),
      queryClient.invalidateQueries({ queryKey: ["cost-analytics", "local"] }),
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
  const loadDemo = useMutation({
    mutationFn: () => loadDemoData(),
    onSuccess: invalidateAll,
  });

  const importPending = importOne.isPending || importAll.isPending;
  const mutationPending = importPending || reset.isPending || loadDemo.isPending;
  const imports = useQuery({
    queryKey: ["imports"],
    queryFn: listImports,
    refetchInterval: importPending ? 750 : false,
  });
  const projects = useQuery({
    queryKey: ["source-projects", root],
    queryFn: () => discoverSourceProjects(root),
    enabled: root.length > 0,
    refetchInterval: importPending ? 750 : false,
  });
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
  const latestImport = imports.data?.[0] ?? null;
  const latestIssues = latestImport?.errors ?? [];
  const latestErrorCount = liveTotals
    ? (progress.data?.summary?.error_count ?? 0)
    : (stats.data?.latest_import_error_count ?? 0);
  const cacheEmpty = (stats.data?.project_count ?? 0) === 0;
  const showDemoCard = projects.isSuccess && discovered.length === 0 && cacheEmpty;

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
          className={`scan-field${projects.isLoading ? " is-scanning" : ""}${isDocker ? " is-locked" : ""}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (!isDocker) setRoot(draft);
          }}
        >
          <span className="scan-glyph" aria-hidden>
            {projects.isLoading ? <LoadingBar size="inline" label="Scanning" /> : <FolderInput size={15} />}
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
              Sync projects from the read-only export into a rebuildable local analytics cache.
            </p>
          )}
          <div className="console-actions">
            {onViewCosts && (stats.data?.session_count ?? 0) > 0 && (
              <button type="button" className="ghost-action" onClick={onViewCosts} disabled={mutationPending}>
                View costs
              </button>
            )}
            <button
              className="primary-action"
              onClick={() => importAll.mutate()}
              disabled={mutationPending || root.length === 0}
            >
              {importAll.isPending ? <LoadingBar size="inline" label="Importing" /> : <FolderInput size={15} />}
              <span>{importAll.isPending ? "Syncing…" : "Sync new and updated"}</span>
            </button>
            <button
              className="ghost-action danger"
              onClick={() => {
                if (window.confirm("Reset local session data? This removes local imports, projects, sessions, and derived analytics. Imported team bundles are preserved.")) reset.mutate();
              }}
              disabled={mutationPending}
            >
              {reset.isPending ? <LoadingBar size="inline" label="Resetting" /> : <Trash2 size={15} />}
              <span>Reset local data</span>
            </button>
          </div>
        </div>
      </section>

      <section className={`metric-band${liveTotals ? " is-live" : ""}`} aria-label="Local data summary">
        <Metric label="Projects" value={metricTotals?.project_count ?? 0} />
        <Metric label="Sessions" value={metricTotals?.session_count ?? 0} />
        <Metric
          label="Observed coverage"
          value={formatDateCoverage(metricTotals?.observed_date_from, metricTotals?.observed_date_to)}
        />
        <Metric
          label="Last successful sync"
          value={formatSyncDate(metricTotals?.last_successful_sync_at)}
        />
        <Metric label="Skipped / errors" value={latestErrorCount} alert={latestErrorCount > 0} />
      </section>

      <section
        className={`import-diagnostics${latestIssues.length > 0 ? " has-issues" : ""}`}
        aria-label="Import diagnostics"
      >
        <div className="diagnostics-summary">
          <span className="diagnostics-label">Diagnostics</span>
          <span>{(metricTotals?.event_count ?? 0).toLocaleString()} events</span>
          <span>{(metricTotals?.subagent_count ?? 0).toLocaleString()} subagents</span>
          <span>{(metricTotals?.persisted_output_count ?? 0).toLocaleString()} large outputs</span>
        </div>
        {latestIssues.length > 0 && (
          <div className="import-issues">
            <div className="import-issues-title">
              <AlertTriangle size={13} aria-hidden="true" />
              <span>{latestIssues.length.toLocaleString()} skipped record{latestIssues.length === 1 ? "" : "s"} in the latest sync</span>
            </div>
            <ul>
              {latestIssues.map((issue, index) => (
                <li key={`${issue.path}:${issue.line_no ?? "file"}:${index}`}>
                  <code>{issue.path}{issue.line_no == null ? "" : `:${issue.line_no}`}</code>
                  <span>{issue.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {showDemoCard && (
        <section className="card demo-card">
          <div className="card-head">
            <h2>No data yet</h2>
          </div>
          <div className="card-pad demo-cta">
            <p className="muted">
              No projects were found in the source and the cache is empty. Load a synthetic
              sample to explore every screen with realistic (but entirely fake) data.
            </p>
            <button
              className="primary-action"
              onClick={() => loadDemo.mutate()}
              disabled={mutationPending}
            >
              {loadDemo.isPending ? <LoadingBar size="inline" label="Loading demo" /> : <FolderInput size={15} />}
              <span>{loadDemo.isPending ? "Loading demo…" : "Load demo data"}</span>
            </button>
          </div>
        </section>
      )}

      <section className="card history-card">
        <div className="card-head">
          <h2>Projects in source</h2>
          {discovered.length > 0 && (
            <span className="card-count">
              <b>{importedCount}</b> of {discovered.length} imported
            </span>
          )}
        </div>
        <div className="import-project-list" role="region" aria-label="Source projects" tabIndex={0}>
          {projects.isLoading && <p className="muted card-pad">Scanning source…</p>}
          {projects.error && <p className="error-text card-pad">{(projects.error as Error).message}</p>}
          {root.length > 0 && discovered.length === 0 && !projects.isLoading && !projects.error && (
            <p className="muted card-pad">No project folders found in the source root.</p>
          )}
          {discovered.map((project: DiscoveredProject) => {
            const busy = pendingName === project.name;
            const displayName = project.display_name || project.name;
            return (
              <div className={`import-row${project.imported ? " is-imported" : ""}`} key={project.name}>
                <span className={`status-dot${project.imported ? " on" : ""}`} aria-hidden="true" />
                <span className="import-project-identity">
                  <strong>{displayName}</strong>
                  <code>{project.name}</code>
                </span>
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
                  aria-label={`${project.imported ? "Re-import" : "Import"} ${displayName}`}
                >
                  {busy ? <LoadingBar size="inline" label="Importing" /> : project.imported ? <RotateCcw size={14} /> : <FolderInput size={14} />}
                  <span>{busy ? "Importing…" : project.imported ? "Re-import" : "Import"}</span>
                </button>
              </div>
            );
          })}
          {(importOne.error || importAll.error || reset.error || loadDemo.error) && (
            <p className="error-text card-pad">{((importOne.error || importAll.error || reset.error || loadDemo.error) as Error).message}</p>
          )}
        </div>
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

function formatDateCoverage(from?: string | null, to?: string | null): string {
  if (!from && !to) return "No sessions";
  const first = from ?? to;
  if (!first) return "No sessions";
  if (!from || from === to) return formatCalendarDate(first);
  return `${formatCalendarDate(from)} – ${to ? formatCalendarDate(to) : formatCalendarDate(from)}`;
}

function formatSyncDate(iso?: string | null): string {
  if (!iso) return "Never";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown";
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatCalendarDate(iso: string): string {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Metric({ label, value, alert = false }: { label: string; value: number | string; alert?: boolean }) {
  const textValue = typeof value === "string";
  return (
    <div className={`metric${textValue ? " is-text" : ""}${alert ? " has-alert" : ""}`}>
      <span>{label}</span>
      <strong>{typeof value === "number" ? value.toLocaleString() : value}</strong>
    </div>
  );
}

export default ImportPage;
