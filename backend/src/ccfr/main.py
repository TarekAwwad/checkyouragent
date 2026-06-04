from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ccfr.api import router
from ccfr.config import allowed_origins, database_path
from ccfr.storage import connect, init_db


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    conn = connect(database_path())
    try:
        init_db(conn)
    finally:
        conn.close()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="Claude Analytics", version="0.1.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)

    return app


app = create_app()
