# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Limit hits can now switch between raw token volume and API-equivalent cost;
  the timeline, hit details, cap zones, near-misses, percentile, and plan-fit
  verdict all use the selected measurement basis.

## [0.1.0] - 2026-07-11

First public release. Local, privacy-strict forensic analytics for Claude Code
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
- Content-free team bundles at structural and team privacy levels, with team
  aggregate Overview and Cost views.
- Privacy mode that blurs sensitive UI text for safe screenshots.
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
