# Security Policy

Claude Analytics is designed as a local-only tool. It indexes Claude Code exports into a rebuildable SQLite database and serves an unauthenticated FastAPI backend for the local React frontend.

## Supported Versions

This project is early-stage open source. Security fixes are expected to land on the default branch unless release branches are created later.

## Reporting Security Issues

If the project repository provides a private security reporting channel, use it. If no private channel is available, open a public issue with only a brief description and ask for a maintainer contact. Do not post exploit details, raw exports, credentials, private file paths, or logs that contain sensitive data.

Useful reports include:

- Path traversal or arbitrary file reads outside the configured import root.
- Raw JSON exposure beyond the intended local user.
- Backend or Docker changes that expose the API to a network unintentionally.
- Unsafe logging or persistence of prompts, code snippets, tool inputs, tool outputs, or credentials.
- Dependency vulnerabilities with a plausible impact on local export confidentiality.

## Local Service Assumptions

- The backend is unauthenticated and intended for loopback-only use.
- Do not expose the backend or frontend to the public internet.
- Do not bind the backend to `0.0.0.0` unless you have a separate access-control plan.
- Docker configuration should keep host bindings local unless explicitly reviewed.

## Sensitive Data

Claude Code exports and raw JSON may contain prompts, file paths, tool inputs and outputs, code snippets, credentials accidentally pasted by users, and other private data. The derived SQLite cache should be handled with the same care as the raw export.

Never commit:

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
