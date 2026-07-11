# Dev scripts

## capture-demo.mjs

Records a short screencast of the app driving the built-in demo dataset and
(optionally) converts it to a compact GIF. Artifacts land in `../docs/media/`.

### One-time setup

```bash
cd scripts
npm install
npx playwright install chromium
```

### Prerequisites at capture time

1. Backend running against a fresh (empty) cache so the "Load demo data" card
   shows. From the repo root:
   ```bash
   CCFR_DB_PATH=./.demo-cache/ccfr.sqlite3 CCFR_IMPORT_ROOT=./.demo-empty \
     uv run --project backend uvicorn ccfr.main:app --port 8000
   ```
   (Create the empty import root first: `mkdir -p .demo-empty`.)
2. Frontend dev server running: `cd frontend && npm run dev` (serves
   http://localhost:5173).
3. Optional: `ffmpeg` on PATH to produce `demo.gif` (otherwise only `demo.webm`
   is written). Windows: `winget install Gyan.FFmpeg`.

### Run

```bash
cd scripts
npm run capture-demo            # uses http://localhost:5173
DEMO_URL=http://localhost:4173 npm run capture-demo   # custom URL
```
