# Contributing

Check Your Agent is a local analytics tool for Claude Code `.claude/projects`
exports. Contributions should preserve the local-first model and treat imported
data as sensitive.

## Before You Start

- Read `README.md`, `PRIVACY.md`, `SECURITY.md`, and `docs/architecture.md`.
- Check `git status` before editing so you do not overwrite unrelated work.
- Do not commit raw Claude Code exports, derived databases, team bundles,
  contribution bundles, logs, environment files, dependency folders, or build
  output.
- Use synthetic or heavily redacted fixtures when adding tests or examples.
- Keep documentation factual. Do not describe planned features as implemented.

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
npm ci
npm run dev
npm test
```

The Vite dev server is configured for:

```text
http://localhost:5174
```

Docker:

```powershell
docker compose up --build
```

Docker serves the built frontend on `http://localhost:5173` and the backend API
docs on `http://localhost:8000/docs`.

## Development Guidelines

- Keep raw export access read-only.
- Keep the backend local and unauthenticated only for loopback development. Any
  change that exposes it beyond `127.0.0.1` needs explicit security review.
- Treat prompts, file paths, tool inputs and outputs, shell commands, code
  snippets, and pasted credentials as private data.
- Prefer rebuildable local state over committed generated artifacts.
- Keep dependency additions small and explain why they are needed.
- Update docs when changing routes, screens, commands, configuration,
  supported input formats, generated outputs, privacy behavior, or limitations.
- Preserve the distinction between implemented, in-progress, planned, and
  considered features.

These paths and patterns should not be committed:

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

## Pull Requests

Include:

- What changed and why.
- Tests or manual checks run.
- Screenshots for visible UI changes.
- Any privacy or security impact, especially changes to import roots, raw JSON
  access, local storage, team bundles, logging, or network binding.

Do not include raw exports, secrets, private file paths, private project names,
or unredacted user data in issues, pull requests, screenshots, or logs.
