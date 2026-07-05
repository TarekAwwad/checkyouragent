# Privacy and Data Handling

Check Your Agent is intended to run locally against Claude Code
`.claude/projects` exports. It does not need external services to index,
inspect, or analyze exports.

## What Data May Be Present

Claude Code exports and the derived SQLite cache can contain:

- Prompts and conversation text.
- Assistant responses and reasoning text when present in the export.
- Local file paths, project names, branch names, and working directories.
- Tool inputs and outputs.
- Shell commands and command output.
- Code snippets, diffs, logs, and error messages.
- Credentials or tokens accidentally pasted by users.

Treat raw exports, `.ccfr-data/`, SQLite files, screenshots, logs, and raw event
inspector output as private data.

## Local Storage

Default local paths resolve from the repository root:

```text
CCFR_IMPORT_ROOT=<repo>/Data
CCFR_DB_PATH=<repo>/.ccfr-data/ccfr.sqlite3
CCFR_TEAM_BUNDLE_ROOT=<repo>/.ccfr-data/team-bundles
```

Additional local files may be created under:

```text
.ccfr-data/settings.json
.ccfr-data/contributions/
.ccfr-data/team-bundles/
TeamBundles/
```

The app reads raw exports from `CCFR_IMPORT_ROOT` and stores a rebuildable index
in SQLite. The index includes compacted raw JSON and previews for local
inspection, so it is not content-free.

`settings.json` stores UI settings, historical-pricing mode, privacy mode,
contributor identity, and team export preferences.

Deleting the SQLite file removes the derived cache, but it does not delete the
original Claude Code export, contribution JSON files, or exported team bundle
JSON files. The current `Reset cache` endpoint drops SQLite tables, including
imported team bundle records, but it does not delete team bundle JSON files on
disk.

## Team Bundles

Team bundles are designed for sharing aggregate usage without conversation
content.

Structural bundles include pseudonymous member/project/session identifiers,
date-only timing, token counts, bucketed models, counts, stop reasons, risk
categories, bucketed subagents, and structural tool/result sequences.

Team-level bundles additionally include the member name, editable project
labels, real tool names, real subagent type names, and extension-only file type
mix. They still omit prompts, assistant text, raw JSON, paths, file names,
commands, and tool input/output.

Even structural bundles can be distinctive because token counts, timing deltas,
and tool sequences are fingerprints. Share them only through channels where
that level of disclosure is acceptable.

## Network Behavior

The backend is an unauthenticated local FastAPI service for the frontend. Keep
it bound to `127.0.0.1` for normal use. Do not expose it to a LAN or the public
internet unless you add separate authentication and access controls.

The project is intended to avoid telemetry and external API calls. The
unmounted contribution page contains a GitHub upload link, but the app does not
upload contribution bundles itself.

## Do Not Commit

Never commit sensitive or generated local data:

```text
Data/
TeamBundles/
.ccfr-data/
*.sqlite3
*.sqlite3-*
.env
*.log
node_modules/
dist/
build/
```

## Sharing Issues and Screenshots

Before sharing issues, pull requests, logs, screenshots, or sample data:

- Remove prompts, credentials, private file paths, project names, branch names,
  shell commands, and code that is not yours to share.
- Prefer minimal synthetic examples.
- Redact raw JSON carefully; nested tool fields can contain sensitive values.
- Avoid screenshots of the raw JSON inspector unless every visible value is
  safe to publish.
- Remember that privacy mode blurs UI text for display. It does not sanitize
  exported screenshots automatically.
