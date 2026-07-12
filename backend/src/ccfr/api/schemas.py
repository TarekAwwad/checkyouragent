from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ImportRequest(BaseModel):
    source_path: str | None = Field(default=None, description="Export root path; defaults to CCFR_IMPORT_ROOT.")
    project: str | None = Field(default=None, description="Import only this project folder; null imports all new projects.")


class RuntimeConfigResponse(BaseModel):
    import_root: str
    team_bundle_root: str
    database_path: str
    is_docker: bool = False


class SettingsResponse(BaseModel):
    historical_pricing: bool = True
    privacy_mode: bool = False
    team_export_prefs: dict[str, Any] = Field(default_factory=dict)
    plan_history: list[dict[str, str]] = Field(default_factory=list)


class CacheStatsResponse(BaseModel):
    project_count: int
    session_count: int
    event_count: int
    subagent_count: int
    memory_count: int
    persisted_output_count: int


class ImportProgressSummary(BaseModel):
    project_count: int
    session_count: int
    event_count: int
    subagent_count: int
    memory_count: int
    persisted_output_count: int
    file_count: int
    error_count: int


class ImportProgressResponse(BaseModel):
    active: bool
    import_id: int | None = None
    status: str = "idle"
    source_path: str | None = None
    project: str | None = None
    totals: CacheStatsResponse | None = None
    summary: ImportProgressSummary | None = None
    updated_at: str | None = None


class ImportSummaryResponse(BaseModel):
    import_id: int
    source_path: str
    project_count: int
    session_count: int
    event_count: int
    subagent_count: int
    memory_count: int
    persisted_output_count: int
    file_count: int
    error_count: int
    errors: list[dict[str, Any]]


class DiscoveredProjectResponse(BaseModel):
    name: str
    imported: bool
    session_count: int
    last_imported_at: str | None
    stale: bool = False


class ProjectResponse(BaseModel):
    id: int
    export_name: str
    display_name: str
    inferred_cwd: str | None
    session_count: int
    event_count: int
    subagent_count: int
    cost_usd: float = 0
    cost_available: bool = False


class SessionCard(BaseModel):
    id: int
    project_id: int
    project_name: str
    session_id: str
    title: str | None
    first_ts: str | None
    last_ts: str | None
    cwd: str | None
    version: str | None
    entrypoint: str | None
    git_branch: str | None
    event_count: int = 0
    turn_count: int = 0
    tool_call_count: int = 0
    subagent_count: int = 0
    error_count: int = 0
    system_count: int = 0
    persisted_output_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    loop_count: int = 0
    max_repeat: int = 0
    duration_seconds: int = 0
    max_agent_events: int = 0
    finding_count: int = 0
    pattern_risk_score: float = 0
    top_finding_category: str | None = None
    top_finding_severity: str | None = None
    top_finding_title: str | None = None
    cost_usd: float = 0
    cost_available: bool = False


class TimelineItem(BaseModel):
    id: str
    event_id: int
    kind: str
    title: str
    timestamp: str | None
    preview: str | None
    event_type: str
    role: str | None = None
    tool_name: str | None = None
    agent_id: str | None = None
    is_sidechain: bool = False
    related_event_ids: list[int] = Field(default_factory=list)



class SubagentResponse(BaseModel):
    id: int
    agent_id: str
    agent_type: str | None
    description: str | None
    name: str | None
    tool_use_id: str | None
    event_count: int
    first_ts: str | None
    last_ts: str | None


class RiskFindingResponse(BaseModel):
    id: int
    session_id: int
    severity: str
    category: str
    title: str
    explanation: str
    pattern: list[str] = Field(default_factory=list)
    support: int
    positive_support: int
    negative_support: int
    lift: float
    score: float
    start_event_id: int | None
    end_event_id: int | None
    evidence: dict[str, Any] = Field(default_factory=dict)


class EventDetail(BaseModel):
    id: int
    session_id: int
    uuid: str | None
    parent_uuid: str | None
    type: str
    timestamp: str | None
    is_sidechain: bool
    agent_id: str | None
    source_path: str
    line_no: int
    role: str | None
    model: str | None
    text_preview: str | None
    tool_calls: list[dict[str, Any]]
    tool_results: list[dict[str, Any]]
    related_event_ids: list[int]
    raw_json: dict[str, Any] | None


class SearchResult(BaseModel):
    kind: str
    ref_id: int
    project_id: int | None
    session_id: int | None
    title: str | None
    preview: str | None


class TraceLane(BaseModel):
    lane_id: str
    label: str
    kind: str


class TraceSpan(BaseModel):
    id: str
    event_id: int
    lane: str
    kind: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str | None = None
    start_ts: str | None
    end_ts: str | None
    tool_use_id: str | None
    tool_name: str | None = None
    is_loop: bool
    loop_run_id: str | None = None
    loop_position: int | None = None
    loop_count: int | None = None
    loop_start_event_id: int | None = None
    loop_end_event_id: int | None = None


class CostTokens(BaseModel):
    base_input: int = 0
    cache_write_5m: int = 0
    cache_write_1h: int = 0
    cache_read: int = 0
    output: int = 0


class SessionCost(BaseModel):
    usd: float = 0
    available: bool = False
    unpriced_models: list[str] = Field(default_factory=list)
    tokens: CostTokens = Field(default_factory=CostTokens)


class TraceResponse(BaseModel):
    session_id: int
    first_ts: str | None
    last_ts: str | None
    lanes: list[TraceLane]
    spans: list[TraceSpan]
    cost: SessionCost = Field(default_factory=SessionCost)


class TreemapModel(BaseModel):
    model: str
    usd: float = 0


class TreemapProject(BaseModel):
    project_id: int
    project_name: str
    usd: float = 0
    children: list[TreemapModel] = Field(default_factory=list)


class OverTimeBucket(BaseModel):
    bucket: str
    per_model: dict[str, float] = Field(default_factory=dict)


class CategoryCost(BaseModel):
    tokens: int = 0
    usd: float = 0


class CategoriesBreakdown(BaseModel):
    base_input: CategoryCost = Field(default_factory=CategoryCost)
    cache_write_5m: CategoryCost = Field(default_factory=CategoryCost)
    cache_write_1h: CategoryCost = Field(default_factory=CategoryCost)
    cache_read: CategoryCost = Field(default_factory=CategoryCost)
    output: CategoryCost = Field(default_factory=CategoryCost)


class ModelCost(BaseModel):
    model: str
    usd: float = 0
    tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    effective_usd_per_million: float = 0


class TurnCostStats(BaseModel):
    turn_count: int = 0
    median_usd: float = 0
    p95_usd: float = 0
    max_usd: float = 0
    outlier_count: int = 0


class TurnCostDetail(BaseModel):
    index: int
    start_event_id: int
    title: str
    preview: str | None = None
    start_timestamp: str | None = None
    usd: float = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    event_count: int = 0
    assistant_message_count: int = 0
    tool_call_count: int = 0
    error_count: int = 0
    subagent_count: int = 0
    loop_count: int = 0
    max_repeat: int = 0
    models: list[str] = Field(default_factory=list)
    is_outlier: bool = False


class TurnCostBreakdown(BaseModel):
    session_id: int
    turn_count: int = 0
    median_usd: float = 0
    p95_usd: float = 0
    max_usd: float = 0
    outlier_threshold_usd: float = 0
    outlier_count: int = 0
    turns: list[TurnCostDetail] = Field(default_factory=list)


class SessionCostEntry(BaseModel):
    id: int
    session_id: str
    title: str | None = None
    project_name: str
    usd: float = 0
    tokens: int = 0
    turn_count: int = 0
    tool_call_count: int = 0
    subagent_count: int = 0
    error_count: int = 0
    loop_count: int = 0
    max_repeat: int = 0
    finding_count: int = 0
    duration_seconds: int = 0
    turn_cost_stats: TurnCostStats = Field(default_factory=TurnCostStats)


class CacheEconomicsModel(BaseModel):
    model: str
    observed_input_usd: float = 0
    no_cache_input_usd: float = 0
    net_savings_usd: float = 0
    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


class CacheEconomics(BaseModel):
    observed_input_usd: float = 0
    no_cache_input_usd: float = 0
    net_savings_usd: float = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    by_model: list[CacheEconomicsModel] = Field(default_factory=list)


class SpendSpikeSession(BaseModel):
    id: int
    session_id: str
    title: str | None = None
    project_name: str
    usd: float = 0
    tokens: int = 0


class SpendSpike(BaseModel):
    bucket: str
    total_usd: float = 0
    delta_usd: float = 0
    sessions: list[SpendSpikeSession] = Field(default_factory=list)


class DiscoveryExample(BaseModel):
    id: int | None = None
    kind: str
    session_id: str | None = None
    title: str | None = None
    project_name: str | None = None
    metric: float = 0
    metric_label: str | None = None
    detail: str | None = None


class DiscoveryDriver(BaseModel):
    id: str
    title: str
    summary: str
    selectors: list[str] = Field(default_factory=list)
    support: int = 0
    positive_support: int = 0
    baseline_rate: float = 0
    subgroup_rate: float = 0
    subgroup_rate_low: float = 0
    lift: float = 0
    score: float = 0
    examples: list[DiscoveryExample] = Field(default_factory=list)


class DiscoverySection(BaseModel):
    key: str
    title: str
    target_label: str
    description: str
    available: bool = True
    unavailable_reason: str | None = None
    baseline_count: int = 0
    positive_count: int = 0
    results: list[DiscoveryDriver] = Field(default_factory=list)


class DiscoveryMeta(BaseModel):
    project_id: int | None = None
    min_support: int = 5
    total_sessions: int = 0
    cost_available: bool = False


class DiscoveryResponse(BaseModel):
    meta: DiscoveryMeta = Field(default_factory=DiscoveryMeta)
    sections: dict[str, DiscoverySection] = Field(default_factory=dict)


class ContextThreshold(BaseModel):
    name: str
    value: float = 0
    provenance: str = ""


class ContextCounterfactual(BaseModel):
    model: str = ""
    params: dict[str, float] = Field(default_factory=dict)


class ContextFinding(BaseModel):
    archetype: str = ""
    session_id: int
    session_title: str | None = None
    project_name: str | None = None
    epoch: int = 0
    entry_turn: int = 0
    label: str
    carried_turns: int = 0
    carried_tokens: int = 0
    savings_tokens: int = 0
    savings_usd: float = 0
    counterfactual: ContextCounterfactual = Field(default_factory=ContextCounterfactual)
    event_id: int | None = None


class ContextThumbnailPoint(BaseModel):
    turn: int
    context_tokens: int = 0
    highlight_tokens: int = 0


class ContextExemplar(BaseModel):
    session_id: int
    series: list[ContextThumbnailPoint] = Field(default_factory=list)


class ContextArchetype(BaseModel):
    key: str
    title: str
    description: str = ""
    recommendation: str = ""
    meets_support: bool = False
    findings_count: int = 0
    savings_usd: float = 0
    savings_tokens: int = 0
    thresholds: list[ContextThreshold] = Field(default_factory=list)
    exemplar: ContextExemplar | None = None
    findings: list[ContextFinding] = Field(default_factory=list)


class ContextTrendBucket(BaseModel):
    week_start: str
    total_usd: float = 0
    avoidable_usd: float = 0


class ContextEconomicsMeta(BaseModel):
    project_id: int | None = None
    min_support: int = 3
    total_usd: float = 0
    necessary_usd: float = 0
    avoidable_usd: float = 0
    unattributed_tokens: int = 0
    total_tokens: int = 0
    avoidable_tokens: int = 0
    avoidable_token_share: float = 0
    cost_available: bool = False
    sessions_analyzed: int = 0
    sessions_skipped: int = 0
    trend: list[ContextTrendBucket] = Field(default_factory=list)


class ContextEconomicsResponse(BaseModel):
    meta: ContextEconomicsMeta = Field(default_factory=ContextEconomicsMeta)
    archetypes: list[ContextArchetype] = Field(default_factory=list)


class ContextCall(BaseModel):
    turn: int
    ts: str | None = None
    context_tokens: int = 0
    model: str | None = None


class ContextEpoch(BaseModel):
    start_turn: int
    end_turn: int
    ended_by: str = "end"


class ContextContributor(BaseModel):
    id: str
    kind: str
    label: str
    entry_turn: int = 0
    end_turn: int = 0
    est_tokens: int = 0
    accrued_usd: float = 0
    event_id: int | None = None


class ContextThreadResponse(BaseModel):
    agent_id: str | None = None
    calls: list[ContextCall] = Field(default_factory=list)
    epochs: list[ContextEpoch] = Field(default_factory=list)
    contributors: list[ContextContributor] = Field(default_factory=list)
    findings: list[ContextFinding] = Field(default_factory=list)


class SessionContextEconomicsResponse(BaseModel):
    threads: list[ContextThreadResponse] = Field(default_factory=list)
    cost_available: bool = False


class AvailableProject(BaseModel):
    id: int
    name: str


class CostAnalyticsMeta(BaseModel):
    available: bool = False
    unpriced_models: list[str] = Field(default_factory=list)
    total_usd: float = 0
    total_tokens: int = 0
    available_projects: list[AvailableProject] = Field(default_factory=list)
    available_models: list[str] = Field(default_factory=list)
    bucket: str = "day"


class CostAnalyticsResponse(BaseModel):
    meta: CostAnalyticsMeta = Field(default_factory=CostAnalyticsMeta)
    treemap: list[TreemapProject] = Field(default_factory=list)
    over_time: list[OverTimeBucket] = Field(default_factory=list)
    categories: CategoriesBreakdown = Field(default_factory=CategoriesBreakdown)
    by_model: list[ModelCost] = Field(default_factory=list)
    sessions: list[SessionCostEntry] = Field(default_factory=list)
    cache_economics: CacheEconomics = Field(default_factory=CacheEconomics)
    spikes: list[SpendSpike] = Field(default_factory=list)


class UsageTool(BaseModel):
    key: str
    label: str
    cost_usd: float = 0
    tokens: int = 0
    count: int = 0
    session_count: int = 0


class UsageHabit(BaseModel):
    key: str
    phase: str
    label: str
    polarity: str = "anti"
    status: str = "confirmed"
    cost_usd: float = 0
    count: int = 0
    session_count: int = 0


class UsagePhase(BaseModel):
    key: str
    label: str
    cost_usd: float = 0
    tokens: int = 0
    main_cost_usd: float = 0
    subagent_cost_usd: float = 0
    main_tokens: int = 0
    subagent_tokens: int = 0
    share: float = 0
    tool_count: int = 0
    session_count: int = 0
    habits: list[UsageHabit] = Field(default_factory=list)
    tools: list[UsageTool] = Field(default_factory=list)


class UsageMapWindow(BaseModel):
    date_from: str | None = None
    date_to: str | None = None


class UsageMapMeta(BaseModel):
    project_id: int | None = None
    window: UsageMapWindow = Field(default_factory=UsageMapWindow)
    total_usd: float = 0
    total_tokens: int = 0
    cost_available: bool = False
    costs_partial: bool = False
    sessions_analyzed: int = 0
    events_classified: int = 0
    share_basis: str = "cost"


class UsageMapResponse(BaseModel):
    meta: UsageMapMeta = Field(default_factory=UsageMapMeta)
    phases: list[UsagePhase] = Field(default_factory=list)


class UsageEvidenceSession(BaseModel):
    session_id: int
    title: str = ""
    project_name: str = ""
    cost_usd: float = 0
    count: int = 0
    exemplar_event_ids: list[int] = Field(default_factory=list)
    detail: str | None = None


class UsageMapEvidenceResponse(BaseModel):
    node: str
    label: str = ""
    rule: str = ""
    cost_usd: float = 0
    sessions: list[UsageEvidenceSession] = Field(default_factory=list)


class UsageCharacteristic(BaseModel):
    key: str
    headline: str = ""
    share: float = 0
    cost_usd: float = 0
    kind: str = ""
    guidance: str = ""


class UsageCharacteristicsMeta(BaseModel):
    project_id: int | None = None
    window: UsageMapWindow = Field(default_factory=UsageMapWindow)
    total_usd: float = 0
    total_tokens: int = 0
    cost_available: bool = False
    costs_partial: bool = False
    sessions_analyzed: int = 0
    share_basis: str = "cost"
    basis_note: str = ""


class UsageCharacteristicsResponse(BaseModel):
    meta: UsageCharacteristicsMeta = Field(default_factory=UsageCharacteristicsMeta)
    characteristics: list[UsageCharacteristic] = Field(default_factory=list)


class ContributionPreviewResponse(BaseModel):
    manifest: dict[str, Any]
    bundle: dict[str, Any]


class ContributionExportResponse(BaseModel):
    path: str
    session_count: int


class TeamExportPreviewResponse(BaseModel):
    manifest: dict[str, Any]
    bundle: dict[str, Any]


class TeamExportResponse(BaseModel):
    path: str
    bundle_id: str
    session_count: int


class TeamProjectEntry(BaseModel):
    export_name: str
    default_label: str
    session_count: int
    tokens: int


class TeamProjectsResponse(BaseModel):
    projects: list[TeamProjectEntry] = Field(default_factory=list)
    prefs: dict[str, Any] = Field(default_factory=dict)


class TeamExportProjectSelection(BaseModel):
    export_name: str
    label: str | None = None


class TeamExportRequest(BaseModel):
    privacy_level: str = "structural"
    member_name: str | None = None
    projects: list[TeamExportProjectSelection] = Field(default_factory=list)


class TeamImportRequest(BaseModel):
    path: str = Field(description="Path to a team bundle JSON file under CCFR_TEAM_BUNDLE_ROOT.")


class TeamBundleUploadRequest(BaseModel):
    filename: str | None = Field(default=None, description="Original local filename selected in the browser.")
    bundle: dict[str, Any] = Field(description="Parsed team bundle JSON payload.")


class TeamImportResponse(BaseModel):
    bundle_id: str
    member_id: str
    session_count: int
    imported: bool
    status: str


class TeamImportEntry(BaseModel):
    id: int
    bundle_id: str
    profile: str
    schema_version: int
    member_id: str
    generated_at: str
    app_version: str | None = None
    imported_at: str
    source_path: str
    session_count: int
    member_name: str | None = None
    privacy_level: str = "structural"


class TeamMemberDeleteResponse(BaseModel):
    member_id: str
    bundles_removed: int


class TeamDashboardResponse(BaseModel):
    meta: dict[str, Any] = Field(default_factory=dict)
    tokens: dict[str, Any] = Field(default_factory=dict)
    stats: dict[str, Any] = Field(default_factory=dict)
    providers: list[dict[str, Any]] = Field(default_factory=list)
    models: list[dict[str, Any]] = Field(default_factory=list)
    stop_reasons: list[dict[str, Any]] = Field(default_factory=list)
    risk_categories: list[dict[str, Any]] = Field(default_factory=list)
    subagents: list[dict[str, Any]] = Field(default_factory=list)
    sequence: list[dict[str, Any]] = Field(default_factory=list)
    members: list[dict[str, Any]] = Field(default_factory=list)
    over_time: list[dict[str, Any]] = Field(default_factory=list)
    projects: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[dict[str, Any]] = Field(default_factory=list)
    file_types: list[dict[str, Any]] = Field(default_factory=list)
