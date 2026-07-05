# Security Policy

Check Your Agent is a local-only tool. It indexes Claude Code exports into a
rebuildable SQLite database and serves an unauthenticated FastAPI backend for
the local React frontend.

## Supported Versions

This project is early-stage source-available software. Security fixes are
expected to land on the default branch unless release branches are created
later.

## Reporting Security Issues

If the project repository provides a private security reporting channel, use it.
If no private channel is available, open a public issue with only a brief
description and ask for a maintainer contact. Do not post exploit details, raw
exports, credentials, private file paths, screenshots of private data, or logs
that contain sensitive data.

Useful reports include:

- Path traversal or arbitrary file reads outside configured roots.
- Raw JSON exposure beyond the intended local user.
- Backend, Docker, or frontend changes that expose the local API to a network.
- CSRF or browser-origin attacks against mutating local API endpoints.
- Unsafe logging or persistence of prompts, code snippets, tool input/output,
  shell commands, or credentials.
- Dependency vulnerabilities with plausible impact on local export
  confidentiality.

## Local Service Assumptions

- The backend is unauthenticated and intended for loopback-only use.
- Docker binds the backend and frontend to `127.0.0.1` by default.
- Do not expose the backend or frontend to the public internet.
- Do not bind the backend to `0.0.0.0` outside a trusted development setup
  unless you add authentication and request protections.
- CORS is not authentication. Treat the local API as trusted-user-only.

## Sensitive Data

Claude Code exports and raw JSON may contain prompts, file paths, tool inputs
and outputs, shell commands, code snippets, credentials accidentally pasted by
users, and other private data. The derived SQLite cache should be handled with
the same care as the raw export.

Team bundles omit raw conversation content, but they can still reveal structural
usage fingerprints. Team-level bundles also reveal member names, project labels,
tool names, subagent names, and file extensions.

Never commit:

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
