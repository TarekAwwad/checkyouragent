# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Resumed and forked sessions no longer inflate cost and token totals. Claude
  Code writes a new JSONL containing the whole prior history each time a session
  is resumed, so the same event was imported once per resume and counted every
  time. Events now carry `is_replay`, and every cost and token view -- Cost,
  per-session and project totals, context economics, the usage map, limit
  analytics, discovery, and team exports -- counts each event once. Existing
  caches are backfilled on open; no re-import is needed. Per-session timelines
  still show every row, so a resumed session renders its full history.

## [0.2.0] - 2026-08-16

### Added
- Limit-hit analysis can now switch between recorded token volume and estimated
  API-equivalent cost; the window timeline and hit details use the selected
  measurement basis.
- Supported session findings now identify repeated identical failures, observed
  timeouts, missing dependencies or commands, permission rejections, and large
  persisted tool results, with links to the recorded evidence.

### Changed
- Reframed analytics around explicit evidence: observed records, estimated
  API-equivalent values, inferred limit windows, and non-causal experimental
  associations now state their basis and expose receipts where available.
- Renamed the local Overview to Sessions and reorganized Explore into primary
  techniques plus a clearly labelled Experimental section.
- Reworked the Session workspace around supported findings, tool activity, a
  selectable subagent heatmap, browser-native navigation, and an always-visible
  trace.
- Clarified Import synchronization, local versus Team reset scope, partial or
  unavailable pricing, and read-only source handling. Source memory files are
  no longer indexed.
- Team exports now use schema v3 without deprecated risk, loop, or event-sequence
  inventory; sanitized v1 and v2 imports remain supported.
- Re-audited the public, package, privacy, security, and architecture docs and
  refreshed synthetic screenshots and demo media against the current UI.

### Fixed
- Team Export keeps the current preview visible while project selections are
  refreshed, preventing transient full-list and empty-selection flashes.
- Team bundle imports now require canonical ISO dates, bound sequence and
  counter values, and reject excessive session counts.
- Cost trend endpoints now reject invalid dates and ranges that would generate
  excessive response buckets.
- Team model sanitization now includes every model in the shipped pricing table,
  so locally priced models remain priceable after Team export.

### Security
- State-changing API requests now reject untrusted browser origins and
  cross-site Fetch Metadata while preserving same-origin and non-browser use.
- API request bodies are capped at 50 MiB before JSON parsing.
- Raised the Starlette runtime floor to a version containing the 2026 request
  URL and form-limit security fixes.
- The API docs page now serves Swagger UI from files bundled into the package
  instead of loading them from a third-party CDN, disables the unused ReDoc
  page, and switches off the swagger.io spec validator badge. Opening /docs no
  longer runs remotely hosted JavaScript inside the unauthenticated local API
  origin or contacts external hosts, including on non-loopback deployments.
- Docker builds now install the exact hash-pinned Python dependency set from
  uv.lock instead of re-resolving version ranges, the frontend image pins its
  Node and nginx base images by digest, and Dependabot now watches the
  frontend Dockerfile. The backend image runs the app from source and no
  longer installs the package itself, so no unpinned build toolchain is
  downloaded during the image build.

### Removed
- Removed uninterpretable risk scores and tiers, loop/max-repeat metrics, the
  passive event-density chart, stale pattern and sequence mining, unused memory
  indexing, and the unmounted contribution workflow.

## [0.1.0] - 2026-07-11

First public release. Local forensic analytics for Claude Code
`~/.claude/projects` exports.

### Added
- Incremental import of Claude Code project folders into a rebuildable SQLite
  index (sessions, events, messages, tool calls/results, subagents, memory, risk
  findings, derived sequence features).
- Overview triage board ranking sessions by risk, findings, errors, loops,
  subagent fanout, event volume, and estimated cost.
- Session workspace: summary tiles, event timeline, trace lanes, loop context,
  subagent heat, in-session search, findings, and a raw event inspector.
- Cost analytics by project, model, and token category; spend over time; spike
  detection; turn distribution; session outliers; and date-aware historical
  pricing.
- Explore techniques: subgroup discovery, Context Economics (avoidable vs
  necessary spend), and a usage mindmap with JSON/PNG export.
- Team bundles at structural and team privacy levels, designed to omit raw
  conversation content while retaining allowlisted aggregate and structural
  fields for team Overview and Cost views.
- Privacy mode that blurs selected sensitive UI text; screenshots still require
  manual review before sharing.
- Synthetic demo dataset and a "Load demo data" action on the Import page, so the
  product's value is visible before importing real logs.
- The CLI now tips its hat on startup (CYA -- cover your assets).

### Fixed
- Privacy mode now blurs Context Economics "Heaviest contributors" labels, which
  previously exposed raw file paths.
- Installed wheels (`uvx` / `pipx` / `pip`) now bundle `pricing.csv` and the
  demo dataset, default their data directory to `~/.checkyouragent`, and read
  optional dated pricing snapshots from `~/.checkyouragent/pricing`, so cost
  analytics and Load demo data work outside a source checkout. The server also
  logs the resolved database path at startup.

### Security
- The API now rejects requests whose `Host` header is not on a localhost
  allow-list (`CCFR_ALLOWED_HOSTS`), protecting local instances from
  DNS-rebinding attacks.

### Changed
- Renamed the GitHub repository to `checkyouragent` (old
  `authrty-claude-code-analytics` URLs redirect automatically).
- Clarified licensing: the Business Source License 1.1 now carries an Additional
  Use Grant permitting free personal and internal use.
- Rewrote the README to lead with the avoidable-spend outcome and added a "How it
  compares" section covering ccusage, token-dashboard, Sniffly, and Anthropic's
  native analytics.

### Removed
- Hid the unfinished "soon" Explore technique tiles and the disabled team-export
  rungs; removed the unmounted contribution page from the build.
