from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from ccfr.api import router
from ccfr.config import allowed_origins, database_path, webui_dir
from ccfr.storage import connect, init_db


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    conn = connect(database_path())
    try:
        init_db(conn)
    finally:
        conn.close()
    yield


def _mount_webui(app: FastAPI) -> None:
    """Serve the built SPA from ccfr/webui/ when present (packaged wheel / uvx).

    No-op in dev and tests where the assets are absent -- the API still serves.
    The /api routes and OpenAPI docs are registered before this catch-all, so
    they always win; only genuinely unknown paths fall back to the SPA shell.
    """
    root = webui_dir()
    index = root / "index.html"
    if not index.is_file():
        return
    assets = root / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str) -> FileResponse:
        if full_path.startswith(("api", "assets")):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = root / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(index)


def create_app() -> FastAPI:
    app = FastAPI(title="Check Your Agent", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    _mount_webui(app)
    return app


app = create_app()
