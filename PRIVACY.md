# Privacy and Data Handling

Claude Analytics is intended to run locally against Claude Code `.claude/projects` exports. It does not need external services to index or inspect exports.

## What Data May Be Present

Claude Code exports and raw JSON can contain:

- Prompts and conversation text.
- Local file paths and project names.
- Tool inputs and outputs.
- Code snippets and diffs.
- Error messages, logs, and command output.
- Credentials or tokens accidentally pasted by users.

Treat both raw exports and derived SQLite databases as private data.

## Local Storage

By default, local runs use:

```text
CCFR_IMPORT_ROOT=../Data
CCFR_DB_PATH=../.ccfr-data/ccfr.sqlite3
```

The app reads raw exports from the import root and stores rebuildable index data in SQLite. Deleting the SQLite file removes the cache, but it does not delete the original export.

## Network Behavior

The backend is an unauthenticated local FastAPI service for the frontend. Keep it bound to `127.0.0.1` for normal use. Do not expose it to a LAN or the public internet unless you add separate authentication and access controls.

The project is intended to avoid telemetry and external API calls. If a future change adds any outbound network behavior, document it clearly and make the privacy impact explicit.

## Do Not Commit

Never commit sensitive or generated local data:

```text
Data/
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

- Remove prompts, credentials, private file paths, project names, and code that is not yours to share.
- Prefer minimal synthetic examples.
- Redact raw JSON carefully; tool outputs and nested fields can contain sensitive values.
- Avoid screenshots of the raw JSON inspector unless every visible value is safe to publish.
