# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Synthetic demo dataset and a "Load demo data" action on the Import page, so the
  product's value is visible before importing real logs.

### Changed
- Renamed the GitHub repository to `check-your-agent` (old
  `authrty-claude-code-analytics` URLs redirect automatically).
- Clarified licensing: the Business Source License 1.1 now carries an Additional
  Use Grant permitting free personal and internal use.
- Rewrote the README to lead with the avoidable-spend outcome and added a "How it
  compares" section covering ccusage, token-dashboard, Sniffly, and Anthropic's
  native analytics.

### Removed
- Hid the unfinished "soon" Explore technique tiles and the disabled team-export
  rungs; removed the unmounted contribution page from the build.

## [0.1.0] - 2026-07-05

First tagged release. Local, privacy-strict forensic analytics for Claude Code
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
