# Documentation Audit

## 0.4.0 documentation update — 2026-11-05

Release documentation and metadata were updated for the 0.4.0 candidate. The
earlier 0.2.0 audit below is retained as a historical snapshot rather than being
presented as a new audit of every listed file.

- Local navigation now leads with Cost, Sessions, and Explore. Sources & sync
  and Share team bundle live under Data. Team navigation leads with Cost and
  Overview, with Manage bundles under Data.
- Cost initially includes all imported history. Returning visits restore the
  last analytical page for the active scope; import results retain an explicit
  View costs action. Returning from a session preserves Cost filters or Sessions
  search, filters, and sorting for the current workspace visit.
- Cost documentation and the glossary describe complete-period spike baselines,
  lookback history separate from visible totals, suppressed partial-pricing
  comparisons, readable weekly dates, and visible zero-activity filter selections.
- The 0.4.0 changelog records replay-accounting corrections, Cost/navigation
  changes, and date-input hardening. Upgrade notes retain the requirement to
  regenerate older team bundles and the automatic local-cache correction.
- Release metadata and lockfile root versions agree on 0.4.0 without changing
  dependency versions. Publication still requires the checks in
  [the release checklist](release-checklist.md), including green CI for the
  merged release commit and an installed candidate-wheel smoke test.
- README and landing-carousel screenshots were refreshed from the installed
  0.4.0 candidate using only the bundled synthetic demo. The capture script
  bounds scrollable panels to the visible region and masks the source path.

## Historical 0.2.0 audit

Audit date: 2026-08-16.

This is a dated repository snapshot, not a promise that documentation will stay
current automatically. It records the public documentation and release-hardening
pass for the 0.2.0 candidate. Product claims were checked against the backend
schema and routes, importer, analysis modules, frontend navigation, package
metadata, and runtime configuration at that date.

## Status Summary

The public text now describes the current product model:

- local Claude Code import into a rebuildable cache, not a durable archive;
- a Sessions investigation board rather than a risk-ranked Overview;
- supported findings tied to recorded evidence rather than opaque scores;
- observed, estimated, inferred, and associated values labelled by basis;
- Team bundle schema v3 without retired risk, loop, sequence, or memory fields;
- separate local-data and Team reset behavior;
- current Explore navigation and current package/Docker/development commands;
- an unauthenticated, loopback-oriented service with explicit browser-origin,
  request-size, and local-data sensitivity boundaries.

No public documentation should describe the repository as open source. It is
source-available under the Business Source License 1.1 and converts to
Apache-2.0 on the Change Date stated in `LICENSE`.

## Documentation Inventory

| File or path | Status at audit date | Notes |
| --- | --- | --- |
| `README.md` | current | Main product claims, evidence vocabulary, input/output model, navigation, reset scope, package/Docker/development instructions, pricing caveats, and source-available license summary match the implementation. |
| `backend/README.md` | current | Package-index description matches the installed `uvx`/`pipx` application and its current screens and limitations. |
| `CHANGELOG.md` | current | The dated `0.2.0` section records the credibility cleanup, v3 Team bundles, hardening changes, current Sessions/workspace changes, and removed features. |
| `docs/architecture.md` | current | Re-audited on 2026-08-16 against current tables, migrations, routes, modules, runtime shapes, request guards, and frontend navigation. Its documented `/api` surface was compared against the running application's OpenAPI schema. |
| `docs/documentation-audit.md` | current dated snapshot | Updated for the 0.2.0 release-hardening pass. |
| `docs/release-checklist.md` | current | Covers version/changelog agreement, security and privacy review, audits, multi-version tests, package smoke checks, and publication verification. |
| `PRIVACY.md` | current | Describes sensitive local cache content, current reset semantics, Team schema v3, legacy import handling, structural fingerprinting, and enforced import/request limits. |
| `SECURITY.md` | current | States the unauthenticated loopback trust model, sensitive-data handling, Host-header and browser-origin guards, request-size cap, and relevant report categories. |
| `CONTRIBUTING.md` | current | Uses current test/dev commands and requires factual docs, synthetic fixtures, privacy/security review, and the release checklist. |
| `LICENSE`, `backend/LICENSE` | current | Both carry the BUSL-1.1 terms and Additional Use Grant; the license itself says it is not an Open Source license. |
| `CODE_OF_CONDUCT.md` | current | Contains no changing product capability claims. |
| `backend/pyproject.toml` | current | Package name, entry points, Python support, license, project links, build inputs, and development dependencies match the code. |
| `frontend/package.json`, `frontend/vite.config.ts` | current | Scripts and the Vite `5174` development/proxy behavior match documented commands. |
| `Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml` | current | Compose exposes frontend `5173` and backend `8000` on host loopback and mounts source, Team, pricing, and cache paths as documented. |
| `scripts/README.md`, `scripts/capture-*.mjs` | current | Document and automate the synthetic demo/media capture flow using current UI selectors. |
| `docs/screenshots/*`, `docs/media/shots/*`, `docs/media/demo.webm` | current | Regenerated from the synthetic dataset on 2026-08-16 with the current capture scripts, which refuse to capture unless the loaded corpus is exactly the bundled `demo-*` projects. README references current PNGs and links to the refreshed WebM. |

## Current Product Reality

### Runtime and data source

- Public product and Python package name: **Check Your Agent** /
  `checkyouragent`; internal Python namespace and environment-variable prefix:
  `ccfr` / `CCFR_`.
- Supported source: Claude Code `.claude/projects`-style exports only.
- The importer reads project-root session JSONL, UUID-session subagent JSONL and
  metadata, and persisted `tool-results/*.txt` metadata/previews.
- Project `memory/` directories may exist in the source but are intentionally
  ignored. The retired memory index is dropped during database migration.
- Raw source files are read-only. A changed project is rebuilt in SQLite from
  the files currently on disk; disappeared source data is not durably archived.
- The installed command is `checkyouragent` with the `cya` alias. With no
  subcommand both default to `serve` on loopback port `8000`.

### Current storage

- Core local tables are `imports`, `projects`, `sessions`, `events`, `messages`,
  `content_blocks`, `tool_calls`, `tool_results`, `persisted_outputs`,
  `subagents`, and `import_errors`.
- Derived local tables are `event_edges`, `session_stats`, `session_findings`,
  `analysis_metadata`, and the FTS5 `search_index`.
- Team imports use `team_bundles` and `team_bundle_sessions`.
- Risk-pattern, sequence-feature, loop-stat, and memory-index tables are retired
  and removed by migration.
- `settings.json` is outside SQLite and preserves display/pricing preferences,
  plan history, and Team export identity/preferences across a local-data reset.
- A local reset preserves imported Team rows. Team reset/removal is separate.
  Neither operation deletes original exports or already-written bundle files.

### Current navigation

This machine:

- Import
- Export
- Sessions
- Cost
- Explore: Limit hits, Context economics, Usage drivers, experimental Usage
  Mindmap, and experimental Subgroups
- Session workspace, reached as a drilldown rather than a permanent nav item

Team:

- Import
- Overview
- Cost

Team data has no raw event/session drilldown because bundles contain aggregates.

### Current analysis claims

- **Observed** values come directly from imported records or deterministic
  counts/classifications over those records.
- **Estimated** values include API-equivalent cost and context opportunity.
  They depend on local pricing and explicit detector assumptions; they are not
  invoices or guaranteed savings.
- **Inferred** limit windows reconstruct account-level five-hour periods from
  recorded usage and rate-limit notices. Missing notices or usage outside the
  exported Claude Code corpus remain invisible.
- **Associated** subgroup findings are non-causal statistical comparisons with
  declared samples, uncertainty, multiple-comparison correction, and example
  receipts.
- Supported session findings detect specific recorded conditions and link back
  to evidence. They do not recreate the removed risk score/tier system.
- Usage Mindmap classifies observed assistant activity; it does not allocate
  message cost to workflow phases.
- Usage Drivers entries overlap and therefore need not sum to 100%.

### Team bundles

- New exports use schema v3 and `structural` or `team` privacy levels.
- Schema v1 and v2 imports remain accepted, but deprecated risk, sequence, and
  loop fields are stripped before current persistence.
- `sessions` and `raw` privacy levels are reserved and rejected.
- The schema-v3 allowlist is designed to omit prompts, assistant text,
  reasoning, raw JSON, previews, commands, paths, branches, filenames, and tool
  input/output; incomplete date validation remains a documented exception risk.
- Structural aggregates can still fingerprint activity. Team-level bundles
  additionally disclose the selected member/project labels, tool mix,
  subagent-type mix, and file-extension mix.

## Removed or Obsolete Claims

These features or claims must not be presented as current:

- numeric risk scores, risk tiers, and a risk-ranked Overview board;
- loop/max-repeat metrics and the passive event-density chart;
- `risk_patterns.py`, sequence-pattern caches, or a shipped sequence-mining
  view;
- memory Markdown indexing or memory search;
- a contribution page, contribution API, or public contribution workflow;
- Team bundle risk categories, inferred patterns, or event sequences;
- cap-zone, percentile, near-miss, or plan-fit verdicts in Limit hits;
- causal subgroup conclusions, cost attribution by Usage Mindmap phase, or
  guaranteed Context Economics savings;
- Team raw-session sharing or Team session drilldowns;
- Codex/OpenAI/other-agent import, live hooks, OpenTelemetry ingestion, or a
  durable source-pruning archive.

## Supported Inputs and Outputs

Inputs:

- Claude Code project directories directly below `CCFR_IMPORT_ROOT`.
- Main-session and subagent JSONL, subagent metadata JSON, and persisted-output
  text files in the supported layout.
- Team bundle JSON schema v1, v2, or v3.
- A baseline pricing CSV and optional dated pricing snapshots.

Outputs:

- A rebuildable local SQLite cache containing sensitive parsed and derived
  records.
- Local `settings.json`.
- Team bundle JSON under `CCFR_TEAM_BUNDLE_ROOT/exports`, or a path chosen by
  the headless `export-bundle` command.
- Local browser dashboards and API JSON responses.
- Usage Mindmap JSON/PNG exports.

The retired contribution output directory is not a current output.

## Known Limitations That Documentation Must Preserve

- The database is not a durable archive. Re-import follows the current source
  tree.
- The backend is unauthenticated and intended for loopback use. Browser-origin
  and Fetch Metadata checks protect state-changing routes, but they are not
  authentication and non-browser clients with local access remain trusted.
- Local raw/derived data and evidence receipts may contain prompts, paths,
  commands, errors, tool arguments, or accidentally pasted credentials.
- Privacy mode is display-only and does not sanitize the database, API, or a
  screenshot automatically.
- Pricing may be missing or outdated. Dollar values are API-equivalent
  estimates, can be partial, and do not model subscription billing.
- Team bundle imports enforce canonical ISO dates, signed 64-bit numeric bounds,
  a 50,000-session limit, and a 50 MiB API body cap. These resource limits do
  not make bundle content trustworthy.
- Team bundle structural data can be identifying even without raw content.
- The app must not be exposed to a LAN or public network without authentication
  and additional request protections.
- The project is source-available, not OSI open source under its current
  license.

## Verification Evidence

Implementation inspected during this documentation pass:

- `backend/src/ccfr/storage/database.py` for schema, migrations, and reset sets;
- `backend/src/ccfr/ingest/importer.py` for accepted files and rebuild behavior;
- `backend/src/ccfr/api/routes.py` for the complete `/api` surface;
- `backend/src/ccfr/analysis/*` for current analysis and Team boundaries;
- `backend/src/ccfr/config.py`, `settings.py`, `main.py`, and `cli.py` for paths,
  runtime shapes, middleware, and command behavior;
- `frontend/src/App.tsx`, `shell/navConfig.ts`, and
  `discover/techniques.tsx` for mounted screens and navigation.

The most recent repository-wide verification was the 2026-08-16 0.2.0
release-readiness pass:

- backend: 529 tests passed on the local Python 3.12.0 environment;
- Ruff correctness checks passed;
- frontend: 326 tests across 43 files passed against a clean
  `npm ci --ignore-scripts` tree;
- frontend production build passed and staged the packaged UI and data assets;
- `npm audit --audit-level=moderate`: no reported vulnerabilities;
- `pip-audit`: no known vulnerabilities. It additionally reports that the local
  `checkyouragent` project version cannot be audited because that version is not
  published yet, which is expected before a release and is not a finding;
- `git diff --check` and `docker compose config -q` reported no problems;
- the 0.2.0 sdist and wheel built successfully. The wheel bundles
  `ccfr/webui/index.html`, `ccfr/_assets/pricing.csv`, and the 110-file
  synthetic demo export; it installs into a clean virtual environment and
  reports the expected package version and asset paths;
- both console entry points (`checkyouragent` and `cya`) run from the installed
  wheel, and `serve` returns the bundled interface and API documentation on
  loopback;
- the installed wheel imported its own packaged demo export (3 projects, 46
  sessions, 708 events, 0 import errors) and answered every local session and
  analytics route, with every observed model priced from the packaged table;
- the request guards behave as documented: an unexpected `Host` header is
  rejected, state-changing requests carrying an untrusted `Origin` or cross-site
  Fetch Metadata are rejected, and a non-browser client that sends no browser
  headers is still served;
- the headless `export-bundle` command produced a schema v3 structural bundle
  containing no project names, file names, or local identifiers;
- `/docs` on the installed wheel loads Swagger UI from the packaged
  `ccfr/docs_assets/` files with no reference to any external host and with the
  spec validator disabled; ReDoc is off, and the SPA fallback answers `/redoc`.
  CI and the release workflow now require those assets in the built wheel.

CI now repeats backend tests on Python 3.11, 3.12, and 3.13 and performs the
package smoke path before release.

## Remaining Documentation Work

| Gap | Priority | Reason |
| --- | --- | --- |
| Dedicated Team bundle schema reference | medium | Privacy docs summarize disclosure, but integrators need a field-by-field v3 reference, versioning rules, validation limits, and legacy-import behavior. |
| Durable archive status/design | medium | The limitation is documented, but any future archive implementation needs a separate retention and deletion contract. |

## Audit Maintenance Rules

When implementation changes any route, table, import source, output, screen,
command, default path, privacy field, reset behavior, or security boundary:

1. Update the user-facing document that owns the behavior.
2. Update `docs/architecture.md` when the technical surface changes.
3. Add an `[Unreleased]` changelog entry for user-visible changes.
4. Refresh synthetic screenshots/demo media for visible UI changes.
5. Replace the date and re-verify this audit rather than labelling an old audit
   as current without inspection.
