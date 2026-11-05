# Architecture

Audit date: 2026-08-16.

Navigation, Cost trend behavior, and release-version documentation updated for
0.4.0 on 2026-11-05.

Check Your Agent is a local FastAPI and React application over a rebuildable
SQLite cache. The current importer supports Claude Code project exports. The
application reads source exports but never modifies them.

## Runtime Topology

```text
Claude Code project export root
        |
        v
backend/src/ccfr/ingest/importer.py
        |
        v
rebuildable local SQLite cache <------ imported team-bundle JSON
        |                                      |
        +--> backend/src/ccfr/analysis/* <------+
        |
        v
backend/src/ccfr/api/routes.py  (/api)
        |
        v
frontend/src/App.tsx
```

The supported runtime shapes are:

- Installed package: `checkyouragent` (or `cya`) defaults to `serve`, starts
  Uvicorn on `127.0.0.1:8000`, and serves the bundled React application and API
  from the same process.
- Source development: FastAPI runs on port `8000`; Vite runs on port `5174`
  and proxies `/api` to FastAPI.
- Docker Compose: the backend is exposed on loopback port `8000`; a separately
  built nginx frontend is exposed on loopback port `5173`.

Backend entry points are `ccfr.main:app` for ASGI and `ccfr.cli:main` for the
command line. The backend uses FastAPI, Pydantic, Uvicorn, and SQLite in WAL
mode. The frontend uses React 18, Vite, and TanStack Query.

## Storage Model

The SQLite database is a disposable index, not an archive.

Local import tables:

- Import and source identity: `imports`, `projects`, `sessions`,
  `import_errors`.
- Parsed source records: `events`, `messages`, `content_blocks`, `tool_calls`,
  `tool_results`, `persisted_outputs`, `subagents`.
- Derived records: `event_edges`, `session_stats`, `session_findings`,
  `analysis_metadata`, and the FTS5 `search_index` virtual table.

Team tables:

- `team_bundles` stores one imported bundle revision per member.
- `team_bundle_sessions` stores the bundle's sanitized session aggregates.

Database migration removes the retired `memory_nodes`, `event_features`,
`sequence_slices`, `risk_findings`, `pattern_hits`, and `sequence_patterns`
tables. They are not part of the current model.

`settings.json` lives under `CCFR_DATA_DIR`, outside SQLite, so a local-data
reset does not remove it. It stores the historical-pricing and privacy-mode
preferences, subscription plan history, the random local bundle identity and
export sequence, and team-export form preferences.

## Import and Rebuild Flow

The importer:

1. Treats each immediate child directory of `CCFR_IMPORT_ROOT` as one project.
2. Reads project-root `*.jsonl` session files.
3. Reads `subagents/agent-*.jsonl` and `agent-*.meta.json` inside UUID-named
   session directories.
4. Indexes metadata and the first-line preview of `tool-results/*.txt` files.
5. Parses events, messages, tool calls/results, token usage, and subagent data.
6. Reconciles replayed events and API-message usage across each changed project.
7. Rebuilds event edges, subagent/session statistics, full-text search rows,
   and evidence-backed session findings.

Replay accounting preserves every source row. Shared API message IDs and event
UUIDs join copies into one usage group, including multiple streamed blocks and
copies with a missing message ID. Groups never cross project boundaries; rows
without either identity remain independent. The most complete recorded usage
(largest input-plus-output total, matching the previous within-session rule)
is counted once, without combining counters from different records.

Equal-usage copies prefer a record claiming its containing session as origin,
then the earliest session start, stable session ID, main transcript and source
position. A restamped fork can share the original timestamps, so this provides
stable attribution rather than reconstructing unavailable session lineage.
Session costs/tokens show attributed usage and sum to corpus totals; a partial
copy can lose ownership to a more complete record in another session.

`messages` token columns contain counted usage; other copies contain zero.
`events.raw_json` retains their original usage for inspection and rebuilding.
Separately, `events.is_replay` marks repeated event UUIDs, preferring the usage
owner when choosing the canonical event. Corpus/project event counts, usage
activity and limit-hit detection exclude those replays. Full session timelines,
turn boundaries, session activity/finding/error counts and import record counts
still describe the retained transcript. A new response after a replayed prompt
therefore remains attached to its turn. Cost turn breakdowns omit pure replay
turns so they do not dilute medians with artificial zero-cost observations.
A retained turn must contain a non-replayed user or assistant message; copied
metadata such as file-history snapshots does not qualify on its own. New
messages still qualify when their recorded usage is zero or pricing is unknown.

The versioned replay migration reconstructs counted usage from the cache's
retained records and refreshes session token summaries without source files or
a re-import. Later project replacements recompute ownership from the remaining
source files. Previously exported/imported team bundles are aggregate-only and
cannot be repaired by this migration: regenerate and re-import those bundles.

Reconciliation runs inside each project's import transaction, so a project and
its source signature are never committed with unreconciled usage.

Context economics reads a copy's recorded usage from `events.raw_json` because a
resumed thread really did re-send that history. Copies keep the context curve
accurate but cost $0, so only calls that own their usage pay carry. Contributors
carried only through copies are left to the session that counts them: they create
no findings and do not widen per-tool size baselines. Threads are deduplicated per
agent, so a subagent keeps the context it inherited from its parent. Discovery's
cost associations likewise leave out sessions whose messages are all replays, from
both the expensive-session threshold and the sample.

The project signature covers relative file paths, sizes, and modification
times. When it changes, that project's cache rows are deleted and rebuilt from
the source files currently present. A project that disappears from the source
tree is not automatically archived. The importer deliberately ignores project
`memory/` directories and removes the retired memory search index during
migration.

`POST /api/imports/reset` clears local imports and derived analytics while
preserving imported team bundles and `settings.json`. Team records have their
own reset and per-member removal routes.

## Team-Bundle Boundary

Team export uses an explicit allowlist in `analysis/team_bundles.py` and shared
canonicalizers in `analysis/bundle_sanitization.py`. New exports use schema v3;
the importer also accepts legacy schema v1 and v2 bundles. Implemented privacy
levels are:

- `structural`: no member/project display names and no tool/file labels.
- `team`: adds a member display name, project labels, real tool/MCP and
  subagent-type names with counts, and extension-only file-type mix.

The reserved `sessions` and `raw` levels are rejected. Imported bundles contain
aggregates rather than raw events, so Team scope has no session drilldown.
Content omission reduces disclosure but exact dates, token counts, and other
structural aggregates can still fingerprint activity.

The same bundle builder is used by the web API and the headless
`checkyouragent export-bundle` command.

## API Surface

All application routes use the `/api` prefix.

- Runtime and settings: `GET /config`, `GET /settings`, `PUT /settings`.
- Local import/cache: `POST /imports`, `POST /imports/demo`,
  `POST /imports/reset`, `GET /source/projects`, `GET /imports`,
  `GET /imports/progress`, `GET /stats`.
- Local records: `GET /projects`, `GET /sessions`, `GET /sessions/{id}`,
  `GET /events/{id}`, and `GET /search`.
- Session detail: `GET /sessions/{id}/timeline`, `/trace`, `/turn-costs`,
  `/subagents`, `/tool-activity`, `/findings`, and `/context-economics`.
- Local analytics: `GET /analytics/cost`, `/discovery`,
  `/context-economics`, `/usage-map`, `/usage-map/evidence`,
  `/usage-characteristics`, and `/limits`.
- Team export/import: `GET /team/projects`, `POST /team/export-preview`,
  `POST /team/export`, `POST /team/import`, `POST /team/import-bundle`,
  `GET /team/imports`, `DELETE /team/members/{member_id}`, and
  `POST /team/reset`.
- Team analytics: `GET /team/dashboard` and `/team/analytics/cost`.

There are no current contribution-bundle API routes.

## Frontend Navigation

The sidebar switches between two data scopes. Analytical pages are grouped at
the top, and data-management pages sit in a separate Data group near the bottom.

This machine, primary navigation:

- **Cost**: local cost and token analytics.
- **Sessions**: filter and sort sessions by observed evidence, activity, and
  estimated API-equivalent cost.
- **Explore**: **Limit hits**, **Context economics**, **Usage drivers**,
  experimental **Usage Mindmap**, and experimental **Subgroups**.

This machine, Data group:

- **Sources & sync**: discover, import, refresh, or reset local project data;
  load the bundled synthetic demo.
- **Share team bundle**: preview and write a privacy-controlled team bundle.

Team, primary navigation:

- **Cost**: aggregate bundle cost; no raw-session panels.
- **Overview**: aggregate team/member activity.

Team, Data group:

- **Manage bundles**: import, list, and remove team bundles.

The session workspace is a drilldown reached from Sessions, Cost, or Explore.
It combines summary metrics, subagent/tool activity, trace, timeline, search,
supported findings, and event inspection. Returning to Cost or Sessions preserves
the filters or search and sorting used for the investigation during the current
workspace visit.

An empty data scope opens its import/onboarding page. Import results stay visible
until the user selects View costs or another destination. Returning visits
restore the last analytical page separately for local and team scope, defaulting
to Cost. The initial Cost range is All time. Remembered page selection uses
browser local storage; investigation filters and search state remain in memory.

The shell also provides privacy-mode display blur, theme controls, a collapsible
sidebar, and a glossary. Privacy mode changes presentation only; it does not
sanitize the underlying cache or API responses.

## Analysis Modules

- `pricing.py`: baseline and dated-snapshot price timelines and token-category
  cost estimation.
- `cost_trends.py`: shared daily/weekly trend bucketing, complete-period
  baselines, and qualified spend increases for local and team cost.
- `session_findings.py`: import-time, evidence-backed finding receipts.
- `trace.py` and `metrics.py`: trace lanes/spans and neutral same-tool streak
  display metadata.
- `discovery.py`: corpus subgroup associations with support and uncertainty
  gates.
- `context_economics.py`: estimated context-carry attribution and opportunity
  detectors.
- `usage_map.py`: deterministic classification of observed assistant activity
  into workflow phases and neutral observations.
- `usage_characteristics.py`: independent, overlapping usage-driver shares.
- `limits.py`: corpus-wide recorded subscription-limit hits and reconstructed
  five-hour usage windows.
- `team_bundles.py`, `bundle_sanitization.py`, and `team_cost.py`: privacy-level
  bundle export/import, canonicalization, team aggregation, and cost analytics.

The former `risk_patterns.py` and contribution analysis modules are no longer
part of the current implementation.

## Cost Trends and Comparisons

Cost uses daily buckets for spans up to 92 days and Monday-based weekly buckets
for longer spans. Weekly periods retain every intersecting week and use the
Monday's year across New Year. Responses expose UTC calendar dates in
`bucket_start` and `bucket_end`, the `baseline_period_count`, and `is_complete`
for the visible bucket. The UI formats those dates rather than displaying the
opaque weekly identifier.

A baseline is the median of usable complete periods among the preceding seven
days or weeks; at least three are required. The backend fetches lookback history
separately from the selected range, including the complete first period when
the selection clips it, so changing a boundary within the same bucket
granularity does not alter later baselines. That history does not add to visible
spend, tokens, categories, or session rows.
Unpriced periods, unfinished periods, and displayed zeros before imported
history begins do not contribute a baseline.

A spend increase qualifies only for a complete, priced period with at least two
fully priced sessions, a dollar increase of at least $5, and a relative increase
of at least 50% when the baseline is positive. A zero baseline can qualify
without a percentage. Partial or unavailable pricing for the selected range
suppresses spike comparisons. The UI keeps the dollar increase primary and
omits percentages for baselines below $1.

The spend chart retains its plot height and wraps long model legends into extra
rows. The Cost by model list has its own bounded scroll area. Date-filter
refreshes retain the preceding chart data while loading; scope and pricing-mode
changes do not reuse those placeholder results. The selected project/model
remains explicit when the range contains no activity for it.

## Configuration Reference

Important environment variables:

```text
CCFR_DATA_DIR=<source checkout>/.ccfr-data
CCFR_DB_PATH=<CCFR_DATA_DIR>/ccfr.sqlite3
CCFR_IMPORT_ROOT=<source checkout>/Data
CCFR_DEMO_DIR=<source checkout>/demo/claude-export
CCFR_TEAM_BUNDLE_ROOT=<CCFR_DATA_DIR>/team-bundles
CCFR_PRICING_PATH=<source checkout>/pricing.csv
CCFR_PRICING_DIR=<source checkout>/pricing
CCFR_WEBUI_DIR=<installed package>/ccfr/webui
CCFR_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CCFR_ALLOWED_HOSTS=localhost,127.0.0.1
```

These are source-checkout defaults. An installed package defaults
`CCFR_DATA_DIR` to `~/.checkyouragent`; `serve` prefers
`~/.claude/projects` as its import root when that directory exists, then falls
back to `./Data`. Explicit environment variables and CLI flags take precedence.

## Security Boundary

The supported deployment assumes a trusted local user:

- The API has no authentication. Normal startup and Docker bind it to loopback.
- `TrustedHostMiddleware` rejects unexpected `Host` headers by default to
  reduce DNS-rebinding exposure. A deliberate non-loopback `serve --host`
  disables that allowlist unless `CCFR_ALLOWED_HOSTS` is set explicitly.
- CORS restricts browser response access. A separate request guard rejects
  state-changing requests from untrusted browser origins or cross-site Fetch
  Metadata while allowing same-origin, configured development origins, and
  non-browser clients. API request bodies are capped at 50 MiB.
- Raw exports and the derived cache contain prompts, responses, commands,
  paths, tool data, and other potentially sensitive content.
- The Team bundle allowlist is designed to omit raw content but still exposes
  structural aggregates and, at the `team` level, selected labels. Imports
  require canonical dates, bound numeric values, at most 50,000 sessions, and
  the global API body limit; see `PRIVACY.md`.
- Cost trend responses are capped at 3,660 daily or weekly buckets.
- Analytics reject unrepresentable calendar arithmetic with a validated 400
  response. Date-only and naive bounds use UTC when compared with timestamps;
  explicit timezone offsets remain respected.

Do not expose the application to a LAN or the public internet without adding
authentication, request-forgery protection, transport security, and a review of
the intended disclosure boundary.
