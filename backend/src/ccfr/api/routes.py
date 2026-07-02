from __future__ import annotations

import json
import secrets
import time
from dataclasses import asdict, replace
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlite3 import Connection

from ccfr import config
from ccfr.api import analytics, repository
from ccfr.api.deps import get_db, get_historical_pricing
from ccfr.api.import_progress import import_progress_store
from ccfr.settings import Settings, contributor_identity, read_settings, write_settings
from ccfr.analysis.contribution import build_contribution, bundle_manifest
from ccfr.analysis.context_economics import (
    context_economics_analytics,
    session_context_economics,
)
from ccfr.analysis.discovery import discovery_analytics
from ccfr.analysis.team_bundles import (
    build_team_bundle,
    delete_team_member,
    import_team_bundle,
    list_team_imports,
    reset_team_bundles,
    team_bundle_manifest,
    team_dashboard,
)
from ccfr.analysis.team_cost import team_cost_analytics
from ccfr.analysis.usage_map import usage_map_analytics, usage_map_evidence
from ccfr.analysis.usage_characteristics import usage_characteristics_analytics
from ccfr.api.schemas import (
    CacheStatsResponse,
    ContributionExportResponse,
    ContributionPreviewResponse,
    ContextEconomicsResponse,
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
    SessionContextEconomicsResponse,
    SettingsResponse,
    SubagentResponse,
    TeamDashboardResponse,
    TeamBundleUploadRequest,
    TeamExportPreviewResponse,
    TeamExportResponse,
    TeamImportEntry,
    TeamImportRequest,
    TeamImportResponse,
    TeamMemberDeleteResponse,
    TimelineItem,
    TurnCostBreakdown,
    TraceResponse,
    UsageCharacteristicsResponse,
    UsageMapEvidenceResponse,
    UsageMapResponse,
)
from ccfr.config import (
    database_path,
    import_root,
    is_docker,
    resolve_within_import_root,
    resolve_within_team_bundle_root,
    team_bundle_root,
    validate_project_name,
)
from ccfr.ingest import ImportSummary, discover_projects, import_all_new, import_project
from ccfr.storage import reset_db

router = APIRouter(prefix="/api")


_TERMINAL_IMPORT_STATUSES = {"completed", "completed_with_errors", "failed"}


def _progress_callback(
    conn: Connection,
    source: Path,
    project: str | None,
    *,
    min_interval_s: float = 0.5,
    clock: Callable[[], float] = time.monotonic,
):
    last = {"at": float("-inf"), "status": None}

    def update(summary: ImportSummary, status: str) -> None:
        # The importer notifies per file; recomputing whole-DB COUNTs each time
        # makes big imports O(files x rows). Publish on status changes and
        # terminal statuses, otherwise at most every min_interval_s.
        now = clock()
        if (
            status == last["status"]
            and status not in _TERMINAL_IMPORT_STATUSES
            and now - last["at"] < min_interval_s
        ):
            return
        last["at"], last["status"] = now, status
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
        team_bundle_root=str(team_bundle_root()),
        database_path=str(database_path()),
        is_docker=is_docker(),
    )


@router.get("/settings", response_model=SettingsResponse)
def get_settings() -> SettingsResponse:
    return SettingsResponse(**asdict(read_settings()))


@router.put("/settings", response_model=SettingsResponse)
def update_settings(payload: SettingsResponse) -> SettingsResponse:
    current = read_settings()
    current.historical_pricing = payload.historical_pricing
    current.privacy_mode = payload.privacy_mode
    saved = write_settings(current)
    return SettingsResponse(**asdict(saved))


def _current_bundle(conn: Connection):
    salt, contributor_id = contributor_identity()
    return build_contribution(
        conn,
        salt=salt,
        contributor_id=contributor_id,
        app_version=config.app_version(),
        generated_on=date.today(),
    )


def _current_team_bundle(conn: Connection, *, persist_seq: bool):
    salt, member_id = contributor_identity()
    settings = read_settings()
    # export-preview must show the NEXT seq without burning it; export persists it.
    seq = settings.team_bundle_seq + 1
    if persist_seq:
        write_settings(replace(settings, team_bundle_seq=seq))
    return build_team_bundle(
        conn,
        salt=salt,
        member_id=member_id,
        app_version=config.app_version(),
        generated_on=date.today(),
        generated_seq=seq,
    )


@router.get("/contribution/preview", response_model=ContributionPreviewResponse)
def contribution_preview(conn: Connection = Depends(get_db)) -> ContributionPreviewResponse:
    bundle = _current_bundle(conn)
    return ContributionPreviewResponse(manifest=bundle_manifest(bundle), bundle=bundle.to_dict())


@router.post("/contribution/export", response_model=ContributionExportResponse)
def contribution_export(conn: Connection = Depends(get_db)) -> ContributionExportResponse:
    bundle = _current_bundle(conn)
    out_dir = config.data_dir() / "contributions"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    path = out_dir / f"contribution-{stamp}-{secrets.token_hex(4)}.json"
    # Exclusive create: never silently overwrite a prior export.
    with path.open("x", encoding="utf-8") as fh:
        fh.write(json.dumps(bundle.to_dict(), indent=2))
    return ContributionExportResponse(path=str(path), session_count=len(bundle.sessions))


@router.get("/team/export-preview", response_model=TeamExportPreviewResponse)
def team_export_preview(conn: Connection = Depends(get_db)) -> TeamExportPreviewResponse:
    bundle = _current_team_bundle(conn, persist_seq=False)
    return TeamExportPreviewResponse(manifest=team_bundle_manifest(bundle), bundle=bundle.to_dict())


@router.post("/team/export", response_model=TeamExportResponse)
def team_export(conn: Connection = Depends(get_db)) -> TeamExportResponse:
    bundle = _current_team_bundle(conn, persist_seq=True)
    out_dir = team_bundle_root() / "exports"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
    path = out_dir / f"team-bundle-{stamp}-{secrets.token_hex(4)}.json"
    data = bundle.to_dict()
    with path.open("x", encoding="utf-8") as fh:
        fh.write(json.dumps(data, indent=2))
    return TeamExportResponse(path=str(path), bundle_id=data["bundle_id"], session_count=len(bundle.sessions))


@router.post("/team/import", response_model=TeamImportResponse)
def team_import(payload: TeamImportRequest, conn: Connection = Depends(get_db)) -> TeamImportResponse:
    try:
        path = resolve_within_team_bundle_root(payload.path, team_bundle_root())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not path.is_file():
        raise HTTPException(status_code=400, detail=f"Team bundle not found: {path}")
    try:
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        result = import_team_bundle(conn, data, source_path=path)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {exc}") from exc
    except OSError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return TeamImportResponse(**asdict(result))


@router.post("/team/import-bundle", response_model=TeamImportResponse)
def team_import_bundle(payload: TeamBundleUploadRequest, conn: Connection = Depends(get_db)) -> TeamImportResponse:
    raw_filename = (payload.filename or "uploaded-team-bundle.json").replace("\\", "/")
    filename = Path(raw_filename).name or "uploaded-team-bundle.json"
    if filename in {".", ".."}:
        filename = "uploaded-team-bundle.json"
    source_path = team_bundle_root() / "browser-imports" / filename
    try:
        result = import_team_bundle(conn, payload.bundle, source_path=source_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return TeamImportResponse(**asdict(result))


@router.get("/team/imports", response_model=list[TeamImportEntry])
def team_imports(conn: Connection = Depends(get_db)) -> list[TeamImportEntry]:
    return [TeamImportEntry(**row) for row in list_team_imports(conn)]


@router.post("/team/reset", response_model=dict[str, bool])
def team_reset(conn: Connection = Depends(get_db)) -> dict[str, bool]:
    reset_team_bundles(conn)
    return {"ok": True}


@router.delete("/team/members/{member_id}", response_model=TeamMemberDeleteResponse)
def team_delete_member(member_id: str, conn: Connection = Depends(get_db)) -> TeamMemberDeleteResponse:
    removed = delete_team_member(conn, member_id)
    if removed == 0:
        raise HTTPException(status_code=404, detail=f"No imported bundles for member: {member_id}")
    return TeamMemberDeleteResponse(member_id=member_id, bundles_removed=removed)


@router.get("/team/dashboard", response_model=TeamDashboardResponse)
def get_team_dashboard(conn: Connection = Depends(get_db)) -> TeamDashboardResponse:
    return TeamDashboardResponse(**team_dashboard(conn))


@router.get("/team/analytics/cost", response_model=CostAnalyticsResponse)
def get_team_cost_analytics(
    date_from: str | None = None,
    date_to: str | None = None,
    model: str | None = None,
    project_id: int | None = None,
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> CostAnalyticsResponse:
    return CostAnalyticsResponse(
        **team_cost_analytics(
            conn, date_from=date_from, date_to=date_to, model=model, project_id=project_id, historical=historical
        )
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
def list_projects(
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> list[ProjectResponse]:
    return [ProjectResponse(**row) for row in repository.list_projects(conn, historical=historical)]


@router.get("/sessions", response_model=list[SessionCard])
def list_sessions(
    project_id: int | None = None,
    q: str | None = None,
    has_subagents: bool | None = None,
    has_errors: bool | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> list[SessionCard]:
    rows = repository.list_sessions(
        conn,
        project_id=project_id,
        q=q,
        has_subagents=has_subagents,
        has_errors=has_errors,
        date_from=date_from,
        date_to=date_to,
        historical=historical,
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
def get_trace(
    session_id: int,
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> TraceResponse:
    if repository.get_session(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return TraceResponse(**repository.get_trace(conn, session_id, historical=historical))


@router.get("/sessions/{session_id}/turn-costs", response_model=TurnCostBreakdown)
def get_turn_costs(
    session_id: int,
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> TurnCostBreakdown:
    if repository.get_session(conn, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return TurnCostBreakdown(**analytics.session_turn_cost_breakdown(conn, session_id, historical=historical))


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
    historical: bool = Depends(get_historical_pricing),
) -> CostAnalyticsResponse:
    return CostAnalyticsResponse(
        **analytics.cost_analytics(
            conn, date_from=date_from, date_to=date_to, project_id=project_id, model=model,
            historical=historical,
        )
    )


@router.get("/analytics/discovery", response_model=DiscoveryResponse)
def get_discovery_analytics(
    project_id: int | None = None,
    min_support: int = Query(default=5, ge=1),
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> DiscoveryResponse:
    return DiscoveryResponse(
        **discovery_analytics(conn, project_id=project_id, min_support=min_support, historical=historical)
    )


@router.get("/analytics/context-economics", response_model=ContextEconomicsResponse)
def get_context_economics(
    project_id: int | None = None,
    min_support: int = Query(default=3, ge=1),
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> ContextEconomicsResponse:
    return ContextEconomicsResponse(
        **context_economics_analytics(conn, project_id=project_id, min_support=min_support, historical=historical)
    )


@router.get("/sessions/{session_id}/context-economics",
            response_model=SessionContextEconomicsResponse)
def get_session_context_economics(
    session_id: int,
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> SessionContextEconomicsResponse:
    return SessionContextEconomicsResponse(**session_context_economics(conn, session_id, historical=historical))


@router.get("/analytics/usage-map", response_model=UsageMapResponse)
def get_usage_map(
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> UsageMapResponse:
    return UsageMapResponse(
        **usage_map_analytics(conn, project_id=project_id,
                              date_from=date_from, date_to=date_to, historical=historical)
    )


@router.get("/analytics/usage-map/evidence", response_model=UsageMapEvidenceResponse)
def get_usage_map_evidence(
    node: str,
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> UsageMapEvidenceResponse:
    try:
        payload = usage_map_evidence(conn, node=node, project_id=project_id,
                                     date_from=date_from, date_to=date_to, historical=historical)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown node: {node}") from exc
    return UsageMapEvidenceResponse(**payload)


@router.get("/analytics/usage-characteristics", response_model=UsageCharacteristicsResponse)
def get_usage_characteristics(
    project_id: int | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    conn: Connection = Depends(get_db),
    historical: bool = Depends(get_historical_pricing),
) -> UsageCharacteristicsResponse:
    return UsageCharacteristicsResponse(
        **usage_characteristics_analytics(conn, project_id=project_id,
                                          date_from=date_from, date_to=date_to, historical=historical)
    )
