from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlite3 import Connection

from ccfr.api import analytics, repository
from ccfr.api.deps import get_db
from ccfr.api.import_progress import import_progress_store
from ccfr.analysis.discovery import discovery_analytics
from ccfr.api.schemas import (
    CacheStatsResponse,
    CostAnalyticsResponse,
    DiscoveryResponse,
    DiscoveredProjectResponse,
    EventDetail,
    ImportProgressResponse,
    ImportRequest,
    ImportSummaryResponse,
    ProjectResponse,
    RiskFindingResponse,
    RuntimeConfigResponse,
    SearchResult,
    SessionCard,
    SubagentResponse,
    TimelineItem,
    TurnCostBreakdown,
    TraceResponse,
)
from ccfr.config import (
    database_path,
    import_root,
    is_docker,
    resolve_within_import_root,
    validate_project_name,
)
from ccfr.ingest import ImportSummary, discover_projects, import_all_new, import_project
from ccfr.storage import reset_db

router = APIRouter(prefix="/api")


def _progress_callback(conn: Connection, source: Path, project: str | None):
    def update(summary: ImportSummary, status: str) -> None:
        import_counts = repository.import_summary_stats(conn, summary.import_id)
        import_progress_store.update(
            {
                "active": True,
                "import_id": summary.import_id,
                "status": status,
                "source_path": summary.source_path or str(source),
                "project": project,
                "totals": repository.cache_stats(conn),
                "summary": {
                    **import_counts,
                    "file_count": summary.file_count,
                    "error_count": len(summary.errors),
                },
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        )

    return update


@router.get("/config", response_model=RuntimeConfigResponse)
def get_config() -> RuntimeConfigResponse:
    return RuntimeConfigResponse(
        import_root=str(import_root()),
        database_path=str(database_path()),
        is_docker=is_docker(),
    )


@router.post("/imports", response_model=ImportSummaryResponse)
def create_import(payload: ImportRequest, conn: Connection = Depends(get_db)) -> ImportSummaryResponse:
    try:
        source = resolve_within_import_root(payload.source_path, import_root())
        if payload.project:
            validate_project_name(payload.project)
    except ValueError as exc:
        import_progress_store.clear()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    progress_callback = _progress_callback(conn, source, payload.project)
    try:
        if payload.project:
            summary = import_project(conn, source, payload.project, progress_callback=progress_callback)
        else:
            summary = import_all_new(conn, source, progress_callback=progress_callback)
    except (FileNotFoundError, NotADirectoryError) as exc:
        import_progress_store.clear()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        import_progress_store.clear()
        raise
    import_progress_store.clear()
    return ImportSummaryResponse(**summary.__dict__)


@router.post("/imports/reset", response_model=dict[str, bool])
def reset_import(conn: Connection = Depends(get_db)) -> dict:
    reset_db(conn)
    import_progress_store.clear()
    return {"ok": True}


@router.get("/source/projects", response_model=list[DiscoveredProjectResponse])
def list_source_projects(
    source_path: str | None = None,
    conn: Connection = Depends(get_db),
) -> list[DiscoveredProjectResponse]:
    try:
        source = resolve_within_import_root(source_path, import_root())
        discovered = discover_projects(conn, source)
    except (FileNotFoundError, NotADirectoryError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return [DiscoveredProjectResponse(**d.__dict__) for d in discovered]


@router.get("/imports")
def list_imports(conn: Connection = Depends(get_db)) -> list[dict]:
    return repository.list_imports(conn)


@router.get("/imports/progress", response_model=ImportProgressResponse)
def get_import_progress() -> ImportProgressResponse:
    return ImportProgressResponse(**import_progress_store.get())


@router.get("/stats", response_model=CacheStatsResponse)
def get_stats(conn: Connection = Depends(get_db)) -> CacheStatsResponse:
    return CacheStatsResponse(**repository.cache_stats(conn))


@router.get("/projects", response_model=list[ProjectResponse])
def list_projects(conn: Connection = Depends(get_db)) -> list[ProjectResponse]:
    return [ProjectResponse(**row) for row in repository.list_projects(conn)]


@router.get("/sessions", response_model=list[SessionCard])
def list_sessions(
    project_id: int | None = None,
    q: str | None = None,
    has_subagents: bool | None = None,
    has_errors: bool | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    conn: Connection = Depends(get_db),
) -> list[SessionCard]:
    rows = repository.list_sessions(
        conn,
        project_id=project_id,
        q=q,
        has_subagents=has_subagents,
        has_errors=has_errors,
        date_from=date_from,
        date_to=date_to,
    )
    return [SessionCard(**row) for row in rows]


@router.get("/sessions/{session_id}", response_model=SessionCard)
def get_session(session_id: int, conn: Connection = Depends(get_db)) -> SessionCard:
    row = repository.get_session(conn, session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return SessionCard(**row)


@router.get("/sessions/{session_id}/timeline", response_model=list[TimelineItem])
def get_timeline(session_id: int, conn: Connection = Depends(get_db)) -> list[TimelineItem]:
    if repository.get_session(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return [TimelineItem(**row) for row in repository.get_timeline(conn, session_id)]



@router.get("/sessions/{session_id}/trace", response_model=TraceResponse)
def get_trace(session_id: int, conn: Connection = Depends(get_db)) -> TraceResponse:
    if repository.get_session(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return TraceResponse(**repository.get_trace(conn, session_id))


@router.get("/sessions/{session_id}/turn-costs", response_model=TurnCostBreakdown)
def get_turn_costs(session_id: int, conn: Connection = Depends(get_db)) -> TurnCostBreakdown:
    if repository.get_session(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return TurnCostBreakdown(**analytics.session_turn_cost_breakdown(conn, session_id))


@router.get("/sessions/{session_id}/subagents", response_model=list[SubagentResponse])
def get_subagents(session_id: int, conn: Connection = Depends(get_db)) -> list[SubagentResponse]:
    if repository.get_session(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return [SubagentResponse(**row) for row in repository.list_subagents(conn, session_id)]


@router.get("/sessions/{session_id}/findings", response_model=list[RiskFindingResponse])
def get_findings(session_id: int, conn: Connection = Depends(get_db)) -> list[RiskFindingResponse]:
    if repository.get_session(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return [RiskFindingResponse(**row) for row in repository.list_risk_findings(conn, session_id)]


@router.get("/events/{event_id}", response_model=EventDetail)
def get_event(
    event_id: int,
    include_raw: bool = Query(default=True),
    conn: Connection = Depends(get_db),
) -> EventDetail:
    row = repository.get_event(conn, event_id, include_raw=include_raw)
    if row is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return EventDetail(**row)


@router.get("/search", response_model=list[SearchResult])
def search(
    q: str,
    project_id: int | None = None,
    session_id: int | None = None,
    conn: Connection = Depends(get_db),
) -> list[SearchResult]:
    return [SearchResult(**row) for row in repository.search(conn, q=q, project_id=project_id, session_id=session_id)]


@router.get("/analytics/cost", response_model=CostAnalyticsResponse)
def get_cost_analytics(
    date_from: str | None = None,
    date_to: str | None = None,
    project_id: int | None = None,
    model: str | None = None,
    conn: Connection = Depends(get_db),
) -> CostAnalyticsResponse:
    return CostAnalyticsResponse(
        **analytics.cost_analytics(
            conn, date_from=date_from, date_to=date_to, project_id=project_id, model=model
        )
    )


@router.get("/analytics/discovery", response_model=DiscoveryResponse)
def get_discovery_analytics(
    project_id: int | None = None,
    min_support: int = Query(default=5, ge=1),
    conn: Connection = Depends(get_db),
) -> DiscoveryResponse:
    return DiscoveryResponse(
        **discovery_analytics(conn, project_id=project_id, min_support=min_support)
    )
