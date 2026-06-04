# Claude Analytics

Offline forensic explorer for Claude Code `.claude/projects` exports.

The app mounts raw exports read-only, indexes them into a rebuildable SQLite database, and provides a graph-first UI for inspecting sessions, tool cycles, subagents, errors, and event trails. It does not call external services and does not mutate the raw export.

## Project Docs

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Privacy and Data Handling](PRIVACY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Run With Docker

```powershell
docker compose down --remove-orphans
docker compose up --build
```

Open:

```text
Frontend: http://localhost:5173
Backend API docs: http://localhost:8000/docs
```

By default `docker-compose.yml` mounts the local `Data/` folder as `/imports` for the backend service. Both containers bind to host loopback only; the backend serves API routes and the frontend is served by a separate container.

## Local Backend

```powershell
cd backend
uv run --extra dev pytest
uv run uvicorn ccfr.main:app --reload --host 127.0.0.1 --port 8000
```

When run outside Docker, the backend defaults to:

```text
CCFR_IMPORT_ROOT=../Data
CCFR_DB_PATH=../.ccfr-data/ccfr.sqlite3
```

Set those environment variables before starting `uvicorn` if you want to index a different export root or store the rebuildable SQLite cache elsewhere.

Restarting the backend does not clear the local SQLite cache. Use **Run Import** in the UI to rebuild it from `CCFR_IMPORT_ROOT`, or delete `../.ccfr-data/ccfr.sqlite3` while the backend is stopped.

To verify that the running backend is the current local code:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/config
```

If that returns `404`, an older backend process is still serving port `8000`. The backend no longer serves the React frontend at `/`; use `http://127.0.0.1:8000/docs` for browser-based API inspection.

## Local Frontend

```powershell
cd frontend
npm install
$env:VITE_API_BASE = "http://localhost:8000/api"
npm run dev
```

Open:

```text
http://localhost:5173
```

`VITE_API_BASE` defaults to `http://localhost:8000/api` if unset. Set it before `npm run dev` when the backend runs on a different host or port.

## V1 Behavior

- Import screen indexes the mounted export.
- Global map shows projects and sessions with behavior counts.
- Session workspace provides replay, event graph, expandable subagent evidence, and metadata-first inspection.
- Raw JSON is loaded on demand from the read-only export using recorded source path and line number.

V1 deliberately avoids automatic loop/deadlock/drift labels. It exposes enough structure for a human analyst to spot suspicious regions.
