# Documentation Audit

Audit date: 2026-07-05.

Scope: repository documentation, docs-like configuration, UI copy entry points,
package metadata, Docker/development configuration, and implementation surfaces
used to verify product behavior.

## Documentation Inventory

| File or path | Classification | Why |
| --- | --- | --- |
| `README.md` | current | Rewritten in this audit to describe the implemented local app, inputs, outputs, Docker/local commands, team bundles, maturity, and limitations. |
| `docs/architecture.md` | current | Added in this audit because the tracked repository did not have a current architecture overview. |
| `docs/documentation-audit.md` | current | Added in this audit to hold inventory, product reality, validation notes, and gaps. |
| `PRIVACY.md` | current | Updated to reflect actual local storage, team bundle disclosure levels, reset behavior, and the unmounted contribution page. |
| `SECURITY.md` | current | Updated to reflect loopback-only unauthenticated assumptions, CSRF/local API risk, team bundle sensitivity, and generated data paths. |
| `CONTRIBUTING.md` | current | Updated with current local/Docker commands, Vite port, dependency commands, and documentation expectations. |
| `CODE_OF_CONDUCT.md` | current | Still accurate; no product feature claims beyond privacy-safe conduct. |
| `LICENSE` | current | License metadata is consistent with the repository being BUSL-1.1. |
| `.github/workflows/ci.yml` | current | CI commands match existing backend/frontend scripts: `uv run --extra dev pytest`, `npm ci`, `npm run build`, `npm test`, and production `npm audit`. |
| `Dockerfile` | current | Backend Dockerfile matches the documented backend image and `/imports` defaults. It copies `pricing.csv` but relies on compose to mount the optional `pricing/` directory. |
| `frontend/Dockerfile` | current | Builds the Vite frontend with `VITE_API_BASE=http://localhost:8000/api` and serves it through nginx on port `5173`. |
| `docker-compose.yml` | current | Runs backend and frontend on host loopback, mounts `Data`, `TeamBundles`, `pricing.csv`, and `pricing/`. |
| `docker-compose-local.yml` | duplicate or redundant | Local, ignored compose variant for a backend-only topology with host-specific mount paths. It is useful locally but should not be treated as canonical documentation. |
| `.dockerignore` | missing important information before audit; current after audit | Updated to exclude `TeamBundles/`, `.ccfr-data/`, `.claude/`, and logs from Docker build context. |
| `.gitignore` | current | Excludes generated data, local env, dependency/build output, local agent notes, WIP plans, and pricing snapshots. |
| `backend/pyproject.toml` | current | Package metadata uses `checkyouragent`; the Python import namespace remains `ccfr`. |
| `frontend/package.json` | current | Scripts exist and work with the documented frontend workflow. Private package metadata uses `checkyouragent-frontend`. |
| `frontend/vite.config.ts` | current | Confirms the local dev server default port is `5174` and `/api` proxies to `localhost:8000`. |
| `frontend/index.html` | current | Browser title and static description metadata use `Check Your Agent`. |
| `frontend/src/shell/Sidebar.tsx` | current | UI wordmark is `Check Your Agent`. |
| `pricing.csv` | current as app data | Valid baseline CSV for the app's pricing loader. External price accuracy was not verified; docs now warn that pricing may lag. |
| `pricing/` | duplicate or redundant local data | Ignored local snapshot directory with dated price CSVs. The feature is documented, but these local files are not tracked product docs. |
| `docs/screenshots/*.png` | current references, not regenerated | README references only screenshot files that exist. Screenshots were not regenerated or visually revalidated in this audit. |
| `PR-team-bundle-sharing.md` | current local PR note | Updated from future-tense PR copy to implemented-state notes and current limitations. The file is untracked in this workspace. |
| `CLAUDE.md` | current local agent note | Updated because the previous ignored local note said Docker was backend-only and Context Economics was not started. |
| `AGENT.md` | current local agent note | Ignored local note with broad vision language. Product name now matches `Check Your Agent`. |
| `WIP-plans/codex-support-*.md` | planned or implied, not implemented | Useful planning docs for Codex support. They must not be read as current product capability. |
| `WIP-plans/local-archive-otel-retention-*.md` | planned or implied, not implemented | Useful planning/review docs for archive, retention, and OTEL. No archive/OTEL implementation exists today. |
| `frontend/src/contribute/ContributePage.tsx` | partially implemented UI copy | Page and API client exist, but `App.tsx` never renders the page in main navigation. Its dataset upload URL is marked with a TODO. |

## Product Reality Extraction

### Facts From Code

- Product type: local FastAPI + React app over a rebuildable SQLite cache.
- Public product name: Check Your Agent.
- Internal namespace and local paths still use `ccfr` for code imports,
  environment variables, local storage keys, and generated data paths.
- Supported data source: Claude Code `.claude/projects`-style JSONL exports.
- Default local import root: `<repo>/Data`.
- Default local database: `<repo>/.ccfr-data/ccfr.sqlite3`.
- Default team bundle root: `<repo>/.ccfr-data/team-bundles`.
- Docker import root: `/imports`, mounted from `./Data`.
- Docker team bundle root: `/team-bundles`, mounted from `./TeamBundles`.
- Backend route prefix: `/api`.
- Backend is unauthenticated and intended for loopback-only use.
- Frontend local dev port is `5174`; Docker frontend port is `5173`.
- Local frontend dev uses Vite proxy for `/api`.
- Docker frontend is built with `VITE_API_BASE=http://localhost:8000/api`.
- Importer scans immediate child directories of the import root as projects.
- Importer reads main session `*.jsonl`, per-session subagent JSONL/meta,
  `tool-results/*.txt`, and `memory/*.md`.
- Importer records malformed JSONL and bad subagent metadata as import errors
  where possible.
- Re-importing a changed project deletes and rebuilds that project's SQLite rows
  from the current source files.
- `POST /api/imports/reset` drops the cache tables listed in
  `DROP_TABLES`, including `team_bundles` and `team_bundle_sessions`.
- `settings.json` persists outside SQLite and survives `reset_db`.
- Cost analytics load prices from `pricing.csv` plus optional dated snapshot
  files named `pricing-YYYY-MM-DD.csv`.
- Missing model price rows make cost estimates partial or unavailable.
- Local scope exposes Import, Export, Overview, Cost, Explore, and session
  workspace.
- Team scope exposes Import, Overview, and Cost.
- Explore ready techniques are Subgroups, Context economics, and Usage Mindmap.
- Sequence mining and anomalies exist only as `status: "soon"` technique
  entries.
- Team bundles have implemented `structural` and `team` privacy levels.
- Team bundle `sessions` and `raw` privacy levels are reserved and rejected by
  backend validation.
- Team aggregate Cost hides session-level panels because bundles lack raw event
  detail.
- Contribution preview/export APIs exist.
- `ContributePage` exists and has tests, but is not mounted in `App.tsx`.

### Implemented Features

- Project discovery from a configured import root.
- Import all new projects or one project.
- Import progress polling.
- Cache stats and import history.
- Project/session listing with search and filters.
- Full-text search over sessions, messages, tool calls, subagents, and memory.
- Event detail API with optional raw JSON.
- Session timeline, trace, subagent list, findings, and turn-cost breakdown.
- Risk pattern extraction and session risk triage.
- Cost analytics with project/model/date filters.
- Historical/current pricing toggle persisted in settings.
- Subgroup discovery for cost, fanout cost, tool errors, and rejected slices.
- Context economics with redundant re-read, oversized result, late compaction,
  and stale continuation detectors.
- Usage mindmap with workflow phases, habits/tools lens, date/project filters,
  main/subagent origin filter, previous-period compare, JSON export, and PNG
  export.
- Usage characteristics dialog.
- Team bundle export preview/export.
- Team bundle import from browser JSON payload or backend-visible path.
- Team import list, member delete, team reset, team dashboard, and team cost.
- Privacy mode blur for sensitive UI text.
- Theme switch and collapsible sidebar.
- Glossary dialog.

### Partially Implemented Features

- Contribution bundles: backend and page component exist, but the page is not
  reachable from main navigation and the public dataset URL is still marked
  `TODO(confirm)`.
- Historical pricing snapshots: loader and Docker mounts exist, but the tracked
  repository only guarantees `pricing.csv`. Local `pricing/` snapshots are
  ignored.
- Team bundles: aggregate views work, but there is no raw/session-level team
  drilldown by design.

### Planned Or Implied But Not Implemented

- Codex/OpenAI/other-agent import.
- Durable archive for source-pruned sessions.
- OpenTelemetry receiver.
- Claude hook inbox or live capture.
- Agent SDK SessionStore import.
- Archive delete/prune APIs.
- Sequence mining Explore view.
- Anomaly detection Explore view.
- Raw-session team sharing.
- Public contribution dataset workflow in the main app.

### Removed Or Obsolete Claims Found

- `CLAUDE.md` claimed Docker was backend-only; current compose runs backend and
  frontend.
- `CLAUDE.md` claimed Context Economics was not started; it is implemented and
  exposed as a ready Explore technique.
- README and Contributing previously documented local frontend URL
  `http://localhost:5173`; current Vite config uses `5174`.
- Team bundle PR notes were written as new/future PR copy; the implementation is
  present.

### Supported Inputs

- Claude Code project directories directly under `CCFR_IMPORT_ROOT`.
- Session JSONL files.
- Subagent JSONL and subagent metadata files.
- Text persisted outputs under `tool-results/*.txt`.
- Memory markdown under `memory/*.md`.
- Team bundle JSON files matching schema v1 or v2.
- Pricing CSV files with model and token category columns.

### Supported Outputs

- Local SQLite cache.
- Local settings JSON.
- Local contribution bundle JSON files under `.ccfr-data/contributions`.
- Local team bundle JSON files under `CCFR_TEAM_BUNDLE_ROOT/exports`.
- Browser-rendered analytics dashboards.
- Usage mindmap JSON and PNG exports.
- API JSON responses under `/api`.

### Known Limitations

- Current import cache is not a durable archive. Source deletion or Claude Code
  retention pruning can affect future re-imports.
- Resetting imports drops imported team bundle records in SQLite.
- Backend has no authentication or CSRF protection.
- Local API should not be exposed beyond loopback.
- Cost estimates depend on local pricing CSVs and may be incomplete.
- Context economics assumes a fixed context window constant in code for Claude
  data and uses heuristics, not ground truth.
- Team bundles are content-free but still structurally fingerprint usage.
- Privacy mode is display-only; it is not data sanitization.
- Screenshots are static and were not regenerated in this audit.

## Usage Validation

Validated by inspection:

- `docker-compose.yml` defines backend and frontend services and exposes
  `127.0.0.1:8000` and `127.0.0.1:5173`.
- `frontend/vite.config.ts` sets dev port `5174` and proxies `/api` to
  `http://localhost:8000`.
- `frontend/package.json` defines `dev`, `build`, `preview`, and `test`.
- `backend/pyproject.toml` defines the Python package, dev dependency group,
  and pytest config.
- README-referenced screenshot files exist under `docs/screenshots/`.
- README-referenced docs exist after this audit.

Command validation performed during this audit:

- `docker compose config`: passed. Docker emitted warnings about denied access
  to the local Docker user config file, but still rendered the expected
  backend/frontend service configuration and loopback ports.
- `cd backend; uv run --extra dev pytest`: passed, 382 tests.
- `cd frontend; npm test`: passed, 39 test files and 282 tests.
- `cd frontend; npm run build`: passed, TypeScript check and Vite production
  build completed.

Commands intentionally not run:

- `docker compose up --build`, because it starts long-running services.
- `npm ci`, because it removes and reinstalls `node_modules`; script existence
  was validated instead.

## Missing Documentation

| Missing doc | Urgency | Why it matters |
| --- | --- | --- |
| Troubleshooting guide | medium | Common failures include wrong import root, Docker volume confusion, stale backend process on port 8000, missing price rows, and CORS when bypassing the Vite proxy. |
| Team bundle schema/reference | medium | Team sharing is implemented and privacy-sensitive; a schema/reference would help reviewers and managers understand exactly what travels. |
| Import format reference | medium | Users need examples of accepted Claude Code export layout, subagent files, persisted outputs, and memory files. |
| Data retention/archive status | high | Current cache can lose sessions if the source is pruned and re-imported. This should stay visible until archive work exists. |
| Screenshot refresh process | low | Static screenshots exist, but there is no note explaining when/how to regenerate them. |
| Public contribution workflow | low | Contribution code exists but is not reachable; docs should wait until the route and dataset target are confirmed. |
| Configuration reference page | low | README and architecture list env vars, but a dedicated config page would be easier as variables grow. |

## Terminology Cleanup

Chosen terms for docs in this audit:

- Use **Check Your Agent** for public product references.
- Use `ccfr` only for internal code namespace, environment variables,
  localStorage keys, and generated data paths.
- Use **local scope** or **This machine** for local imported Claude Code data.
- Use **team scope** for imported content-free team bundles.
- Use **team bundle** for shared JSON aggregate files.
- Use **structural** and **team** for implemented bundle privacy levels.
- Use **Explore** for the feature group that contains Subgroups, Context
  economics, and Usage Mindmap.
- Use **SQLite cache** for the resettable derived database, not archive.

## Roadmap Cleanup

Implemented:

- Claude Code import.
- Local Overview, Cost, Explore, Session workspace.
- Team bundle export/import and aggregate team Overview/Cost.
- Context economics and usage mindmap.
- Historical pricing toggle.

In progress or partially implemented:

- Contribution bundle export, because page code and APIs exist but main routing
  and dataset target are not complete.

Planned:

- Sequence mining.
- Anomaly detection.
- Durable local archive for source-pruned sessions.
- Codex/other-agent support.

Being considered:

- OpenTelemetry receiver.
- Hook-based capture.
- SDK SessionStore import.
- Archive prune/delete workflows.
- Raw/session-level team sharing.

Not currently planned in implemented code:

- Remote hosted backend.
- Built-in authentication.
- External telemetry upload.
- Mutating Claude Code source exports.

## Files Updated In This Audit

- `README.md`
- `docs/architecture.md`
- `docs/documentation-audit.md`
- `PRIVACY.md`
- `SECURITY.md`
- `CONTRIBUTING.md`
- `LICENSE`
- `backend/pyproject.toml`
- `backend/src/ccfr/__init__.py`
- `backend/src/ccfr/main.py`
- `frontend/package.json`
- `frontend/index.html`
- `.dockerignore`
- `PR-team-bundle-sharing.md`
- `CLAUDE.md` (ignored local agent note)
- `AGENT.md` (ignored local agent note)

## Files Left Unchanged

- `CODE_OF_CONDUCT.md`
- `.github/workflows/ci.yml`
- `.gitignore`
- `Dockerfile`
- `frontend/Dockerfile`
- `frontend/nginx.conf`
- `frontend/src/shell/Sidebar.tsx`
- `frontend/vite.config.ts`
- `docs/screenshots/*.png`
- `WIP-plans/*`

## Assumptions

- Public docs and metadata should use Check Your Agent; `ccfr` remains the
  internal namespace for imports, environment variables, local storage keys, and
  generated data paths.
- Ignored local planning docs are useful context but should not be presented as
  current product capability.
- Pricing CSVs are local app inputs; this audit did not verify vendor pricing
  against external sources.
- Documentation should be truthful about current reset/source-pruning behavior
  even though WIP plans propose safer archive semantics.
