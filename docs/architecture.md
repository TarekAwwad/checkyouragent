# Architecture

Audit date: 2026-07-05.

Check Your Agent is a local FastAPI + React application over a rebuildable
SQLite cache. The current implementation is single-provider: Claude Code
`.claude/projects` exports.

## Runtime Components

```text
Claude Code project export root
        |
        v
backend/src/ccfr/ingest/importer.py
        |
        v
SQLite cache at CCFR_DB_PATH
        |
        +--> backend/src/ccfr/analysis/*
        |
        v
backend/src/ccfr/api/routes.py
        |
        v
frontend/src/App.tsx
```

Backend:

- Entry point: `ccfr.main:app`.
- Framework: FastAPI.
- Storage: SQLite with WAL mode.
- Config: environment variables in `backend/src/ccfr/config.py`.
- Importer: Claude Code JSONL project folders under `CCFR_IMPORT_ROOT`.
- API router prefix: `/api`.

Frontend:

- Entry point: `frontend/src/main.tsx`.
- App shell: `frontend/src/App.tsx`.
- Framework: React 18, Vite, TanStack Query.
- Local dev URL: `http://localhost:5174`.
- Docker frontend URL: `http://localhost:5173`.

Docker:

- Root `Dockerfile` builds the backend image.
- `frontend/Dockerfile` builds a static frontend served by nginx.
- `docker-compose.yml` runs both services on host loopback.

## Data Model

The SQLite cache is rebuilt from imported source files. Core tables include:

- `imports`, `projects`, `sessions`, `events`.
- `messages`, `content_blocks`, `tool_calls`, `tool_results`.
- `persisted_outputs`, `subagents`, `memory_nodes`.
- `event_edges`, `session_stats`, `search_index`.
- Sequence/risk tables: `sequence_slices`, `event_features`,
  `sequence_patterns`, `pattern_hits`, `risk_findings`.
- Team tables: `team_bundles`, `team_bundle_sessions`.

`settings.json` lives outside SQLite under `CCFR_DATA_DIR` and stores app
preferences, privacy mode, historical-pricing mode, contributor identity, and
team export preferences.

## Import Flow

The importer:

- Scans immediate child directories of `CCFR_IMPORT_ROOT` as projects.
- Reads `*.jsonl` session files.
- Reads per-session `subagents/agent-*.jsonl` and
  `subagents/agent-*.meta.json`.
- Indexes `tool-results/*.txt`.
- Reads `memory/*.md`.
- Records malformed JSONL and bad metadata as import errors where possible.
- Rebuilds derived edges, session stats, search rows, sequence features, and
  risk findings after import.

Current limitation: when a project's source signature changes, the importer
deletes and rebuilds that project in the SQLite cache from the files currently
present in the source tree. There is no implemented durable archive for source
files that disappeared before re-import.

## API Surface

Implemented route groups:

- Runtime/settings: `GET /api/config`, `GET/PUT /api/settings`.
- Import/cache: `POST /api/imports`, `POST /api/imports/reset`,
  `GET /api/imports`, `GET /api/imports/progress`,
  `GET /api/source/projects`, `GET /api/stats`.
- Local data: `GET /api/projects`, `GET /api/sessions`,
  `GET /api/sessions/{id}`, timeline, trace, turn costs, subagents, findings,
  event detail, and search.
- Analytics: cost, discovery, context economics, usage map, usage map
  evidence, and usage characteristics.
- Team bundles: projects, preview, export, import by path, import by uploaded
  JSON payload, import list, member delete, team reset, dashboard, and team
  cost.
- Contribution bundle: preview and export. The page using these endpoints is
  not mounted in the main app navigation.

## Frontend Screens

Local scope:

- Import.
- Export a team bundle.
- Overview triage board.
- Cost analytics.
- Explore: Subgroups, Context economics, Usage Mindmap.
- Session workspace reached from Overview, Cost, or Explore.

Team scope:

- Import team bundles.
- Team Overview.
- Team Cost.

Team scope intentionally does not expose session drilldowns because imported
team bundles do not contain raw per-session events.

## Analysis Modules

- `pricing.py`: baseline and dated snapshot pricing.
- `metrics.py`: loop statistics.
- `risk_patterns.py`: deterministic sequence features and heuristic risk
  findings.
- `discovery.py`: subgroup discovery for cost, fanout, errors, and rejections.
- `trace.py`: session event trace payloads.
- `context_economics.py`: context-carry attribution and waste detectors.
- `usage_map.py`: workflow-phase and habit aggregation.
- `usage_characteristics.py`: overlapping usage characteristics.
- `team_bundles.py` and `team_cost.py`: content-free team sharing and team
  aggregate cost.
- `contribution.py`: content-free contribution bundle export.

## Configuration Reference

```text
CCFR_DATA_DIR=<repo>/.ccfr-data
CCFR_DB_PATH=<CCFR_DATA_DIR>/ccfr.sqlite3
CCFR_IMPORT_ROOT=<repo>/Data
CCFR_TEAM_BUNDLE_ROOT=<CCFR_DATA_DIR>/team-bundles
CCFR_PRICING_PATH=<repo>/pricing.csv
CCFR_PRICING_DIR=<repo>/pricing
CCFR_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CCFR_ALLOWED_HOSTS=localhost,127.0.0.1
```

`CCFR_ALLOWED_ORIGINS` matters only when the browser calls the backend
cross-origin. In local Vite development the frontend normally uses the `/api`
proxy instead.

`CCFR_ALLOWED_HOSTS` is the accepted `Host` header allow-list. It is what keeps
the unauthenticated 127.0.0.1 bind private against DNS rebinding: a page that
rebinds its domain to 127.0.0.1 reaches the app same-origin, but its forged
`Host` is rejected. `serve --host <non-loopback>` sets it to `*` (guard off) so
a deliberate network bind still works; set it explicitly to re-restrict.

## Current Security Boundary

The app assumes local trust:

- Backend is unauthenticated but validates the `Host` header (`CCFR_ALLOWED_HOSTS`)
  so a foreign site cannot reach the loopback API via DNS rebinding.
- Docker binds backend and frontend to `127.0.0.1`.
- Raw exports and the derived SQLite cache may contain sensitive content.
- Team bundles are content-free by design, but structural token/timing/tool
  patterns can still fingerprint usage.

Do not expose the backend or frontend to a LAN or the public internet without
adding authentication and additional request protections.
