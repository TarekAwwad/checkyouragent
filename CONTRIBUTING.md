# Contributing

Claude Analytics is an offline forensic explorer for Claude Code `.claude/projects` exports. Contributions should preserve that local-first model and treat imported data as sensitive.

## Before You Start

- Read `README.md` for the current Docker and local development commands.
- Check `git status` before editing so you do not overwrite unrelated work.
- Do not commit raw Claude Code exports, derived databases, logs, environment files, dependency folders, or build output.
- Use synthetic or heavily redacted fixtures when adding tests or examples.

## Local Development

Backend:

```powershell
cd backend
uv run --extra dev pytest
uv run uvicorn ccfr.main:app --reload --host 127.0.0.1 --port 8000
```

Frontend:

```powershell
cd frontend
npm install
npm run dev
npm run test
```

Docker:

```powershell
docker compose up --build
```

## Development Guidelines

- Keep raw export access read-only.
- Keep the backend local and unauthenticated only for loopback development. Any change that exposes it beyond `127.0.0.1` needs explicit security review.
- Treat prompts, file paths, tool inputs and outputs, code snippets, and pasted credentials as private data.
- Prefer rebuildable local state over committed generated artifacts.
- Keep dependency additions small and explain why they are needed.
- Preserve README run instructions when updating docs.

These paths and patterns should not be committed:

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

## Pull Requests

Include:

- What changed and why.
- Tests or manual checks run.
- Screenshots for visible UI changes.
- Any privacy or security impact, especially changes to import roots, raw JSON access, local storage, logging, or network binding.

Do not include raw exports, secrets, private file paths, or unredacted user data in issues, pull requests, screenshots, or logs.
