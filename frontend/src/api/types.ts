export interface ImportSummary {
  import_id: number;
  source_path: string;
  project_count: number;
  session_count: number;
  event_count: number;
  subagent_count: number;
  memory_count: number;
  persisted_output_count: number;
  file_count: number;
  error_count: number;
  errors: Array<{ path: string; line_no?: number; message: string }>;
}

export interface RuntimeConfig {
  import_root: string;
  team_bundle_root?: string;
  database_path: string;
  is_docker: boolean;
}

export interface CacheStats {
  project_count: number;
  session_count: number;
  event_count: number;
  subagent_count: number;
  memory_count: number;
  persisted_output_count: number;
}

export interface ImportProgressSummary extends CacheStats {
  file_count: number;
  error_count: number;
}

export interface ImportProgress {
  active: boolean;
  import_id: number | null;
  status: string;
  source_path: string | null;
  project: string | null;
  totals: CacheStats | null;
  summary: ImportProgressSummary | null;
  updated_at: string | null;
}

export interface Project {
  id: number;
  export_name: string;
  display_name: string;
  inferred_cwd: string | null;
  session_count: number;
  event_count: number;
  subagent_count: number;
  cost_usd: number;
  cost_available: boolean;
}

export interface DiscoveredProject {
  name: string;
  imported: boolean;
  session_count: number;
  last_imported_at: string | null;
  stale?: boolean;
}

export interface SessionCard {
  id: number;
  project_id: number;
  project_name: string;
  session_id: string;
  title: string | null;
  first_ts: string | null;
  last_ts: string | null;
  cwd: string | null;
  version: string | null;
  entrypoint: string | null;
  git_branch: string | null;
  event_count: number;
  turn_count: number;
  tool_call_count: number;
  subagent_count: number;
  error_count: number;
  system_count: number;
  persisted_output_count: number;
  input_tokens: number;
  output_tokens: number;
  loop_count: number;
  max_repeat: number;
  duration_seconds: number;
  max_agent_events: number;
  finding_count: number;
  pattern_risk_score: number;
  top_finding_category: string | null;
  top_finding_severity: string | null;
  top_finding_title: string | null;
  cost_usd: number;
  cost_available: boolean;
}

export interface TimelineItem {
  id: string;
  event_id: number;
  kind: string;
  title: string;
  timestamp: string | null;
  preview: string | null;
  event_type: string;
  role: string | null;
  tool_name: string | null;
  agent_id: string | null;
  is_sidechain: boolean;
  related_event_ids: number[];
}

export interface TraceLane {
  lane_id: string;
  label: string;
  kind: "main" | "subagent";
}

export interface TraceSpan {
  id: string;
  event_id: number;
  lane: string;
  kind: string;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  start_ts: string | null;
  end_ts: string | null;
  tool_use_id: string | null;
  tool_name: string | null;
  is_loop: boolean;
  loop_run_id?: string | null;
  loop_position?: number | null;
  loop_count?: number | null;
  loop_start_event_id?: number | null;
  loop_end_event_id?: number | null;
}

export interface SessionCost {
  usd: number;
  available: boolean;
  unpriced_models: string[];
  tokens: {
    base_input: number;
    cache_write_5m: number;
    cache_write_1h: number;
    cache_read: number;
    output: number;
  };
}

export interface TraceResponse {
  session_id: number;
  first_ts: string | null;
  last_ts: string | null;
  lanes: TraceLane[];
  spans: TraceSpan[];
  cost: SessionCost;
}

export interface Subagent {
  id: number;
  agent_id: string;
  agent_type: string | null;
  description: string | null;
  name: string | null;
  tool_use_id: string | null;
  event_count: number;
  first_ts: string | null;
  last_ts: string | null;
}

export interface RiskFinding {
  id: number;
  session_id: number;
  severity: "low" | "medium" | "high" | string;
  category: string;
  title: string;
  explanation: string;
  pattern: string[];
  support: number;
  positive_support: number;
  negative_support: number;
  lift: number;
  score: number;
  start_event_id: number | null;
  end_event_id: number | null;
  evidence: Record<string, unknown>;
}

export interface EventDetail {
  id: number;
  session_id: number;
  uuid: string | null;
  parent_uuid: string | null;
  type: string;
  timestamp: string | null;
  is_sidechain: boolean;
  agent_id: string | null;
  source_path: string;
  line_no: number;
  role: string | null;
  model: string | null;
  text_preview: string | null;
  tool_calls: Array<Record<string, unknown>>;
  tool_results: Array<Record<string, unknown>>;
  related_event_ids: number[];
  raw_json: Record<string, unknown> | null;
}

export interface SearchResult {
  kind: string;
  ref_id: number;
  project_id: number | null;
  session_id: number | null;
  title: string | null;
  preview: string | null;
}

export interface TreemapModel {
  model: string;
  usd: number;
}

export interface TreemapProject {
  project_id: number;
  project_name: string;
  usd: number;
  children: TreemapModel[];
}

export interface OverTimeBucket {
  bucket: string;
  per_model: Record<string, number>;
}

export interface CategoryCost {
  tokens: number;
  usd: number;
}

export interface CategoriesBreakdown {
  base_input: CategoryCost;
  cache_write_5m: CategoryCost;
  cache_write_1h: CategoryCost;
  cache_read: CategoryCost;
  output: CategoryCost;
}

export interface ModelCost {
  model: string;
  usd: number;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  effective_usd_per_million: number;
}

export interface SessionCostEntry {
  id: number;
  session_id: string;
  title: string | null;
  project_name: string;
  usd: number;
  tokens: number;
  turn_count: number;
  tool_call_count: number;
  subagent_count: number;
  error_count: number;
  loop_count: number;
  max_repeat: number;
  finding_count: number;
  duration_seconds: number;
  turn_cost_stats: {
    turn_count: number;
    median_usd: number;
    p95_usd: number;
    max_usd: number;
    outlier_count: number;
  };
}

export interface TurnCostDetail {
  index: number;
  start_event_id: number;
  title: string;
  preview: string | null;
  start_timestamp: string | null;
  usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  event_count: number;
  assistant_message_count: number;
  tool_call_count: number;
  error_count: number;
  subagent_count: number;
  loop_count: number;
  max_repeat: number;
  models: string[];
  is_outlier: boolean;
}

export interface TurnCostBreakdown {
  session_id: number;
  turn_count: number;
  median_usd: number;
  p95_usd: number;
  max_usd: number;
  outlier_threshold_usd: number;
  outlier_count: number;
  turns: TurnCostDetail[];
}

export interface CacheEconomicsModel {
  model: string;
  observed_input_usd: number;
  no_cache_input_usd: number;
  net_savings_usd: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface CacheEconomics {
  observed_input_usd: number;
  no_cache_input_usd: number;
  net_savings_usd: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  by_model: CacheEconomicsModel[];
}

export interface SpendSpikeSession {
  id: number;
  session_id: string;
  title: string | null;
  project_name: string;
  usd: number;
  tokens: number;
}

export interface SpendSpike {
  bucket: string;
  total_usd: number;
  delta_usd: number;
  sessions: SpendSpikeSession[];
}

export interface DiscoveryExample {
  id: number | null;
  kind: string;
  session_id: string | null;
  title: string | null;
  project_name: string | null;
  metric: number;
  metric_label: string | null;
  detail: string | null;
}

export interface DiscoveryDriver {
  id: string;
  title: string;
  summary: string;
  selectors: string[];
  support: number;
  positive_support: number;
  baseline_rate: number;
  subgroup_rate: number;
  subgroup_rate_low: number;
  lift: number;
  score: number;
  examples: DiscoveryExample[];
}

export interface DiscoverySection {
  key: string;
  title: string;
  target_label: string;
  description: string;
  available: boolean;
  unavailable_reason: string | null;
  baseline_count: number;
  positive_count: number;
  results: DiscoveryDriver[];
}

export interface DiscoveryResponse {
  meta: {
    project_id: number | null;
    min_support: number;
    total_sessions: number;
    cost_available: boolean;
  };
  sections: Record<string, DiscoverySection>;
}

export interface DiscoveryFilters {
  projectId?: number | null;
  minSupport?: number | null;
}

export interface CostAnalyticsMeta {
  available: boolean;
  unpriced_models: string[];
  total_usd: number;
  total_tokens: number;
  available_projects: { id: number; name: string }[];
  available_models: string[];
  bucket: "day" | "week";
}

export interface CostAnalyticsResponse {
  meta: CostAnalyticsMeta;
  treemap: TreemapProject[];
  over_time: OverTimeBucket[];
  categories: CategoriesBreakdown;
  by_model: ModelCost[];
  sessions: SessionCostEntry[];
  cache_economics: CacheEconomics;
  spikes: SpendSpike[];
}

export interface CostAnalyticsFilters {
  dateFrom?: string | null;
  dateTo?: string | null;
  projectId?: number | null;
  model?: string | null;
}

export interface ContextThreshold {
  name: string;
  value: number;
  provenance: string;
}

export interface ContextCounterfactual {
  model: string;
  params: Record<string, number>;
}

export interface ContextFinding {
  archetype: string;
  session_id: number;
  session_title: string | null;
  project_name: string | null;
  epoch: number;
  entry_turn: number;
  label: string;
  carried_turns: number;
  carried_tokens: number;
  savings_tokens: number;
  savings_usd: number;
  counterfactual: ContextCounterfactual;
  event_id: number | null;
}

export interface ContextThumbnailPoint {
  turn: number;
  context_tokens: number;
  highlight_tokens: number;
}

export interface ContextExemplar {
  session_id: number;
  series: ContextThumbnailPoint[];
}

export interface ContextArchetype {
  key: string;
  title: string;
  description: string;
  recommendation: string;
  meets_support: boolean;
  findings_count: number;
  savings_usd: number;
  savings_tokens: number;
  thresholds: ContextThreshold[];
  exemplar: ContextExemplar | null;
  findings: ContextFinding[];
}

export interface ContextTrendBucket {
  week_start: string;
  total_usd: number;
  avoidable_usd: number;
}

export interface ContextEconomicsMeta {
  project_id: number | null;
  min_support: number;
  total_usd: number;
  necessary_usd: number;
  avoidable_usd: number;
  unattributed_tokens: number;
  cost_available: boolean;
  sessions_analyzed: number;
  sessions_skipped: number;
  trend: ContextTrendBucket[];
}

export interface ContextEconomicsResponse {
  meta: ContextEconomicsMeta;
  archetypes: ContextArchetype[];
}

export interface ContextCall {
  turn: number;
  ts: string | null;
  context_tokens: number;
  model: string | null;
}

export interface ContextEpoch {
  start_turn: number;
  end_turn: number;
  ended_by: string;
}

export interface ContextContributor {
  id: string;
  kind: string;
  label: string;
  entry_turn: number;
  end_turn: number;
  est_tokens: number;
  accrued_usd: number;
  event_id: number | null;
}

export interface ContextThread {
  agent_id: string | null;
  calls: ContextCall[];
  epochs: ContextEpoch[];
  contributors: ContextContributor[];
  findings: ContextFinding[];
}

export interface SessionContextEconomicsResponse {
  threads: ContextThread[];
  cost_available: boolean;
}

// --- Usage Mindmap -----------------------------------------------------------

export interface UsageHabit {
  key: string;
  phase: string;
  label: string;
  polarity: "good" | "anti";
  status: string;
  cost_usd: number;
  count: number;
  session_count: number;
}

export interface UsageTool {
  key: string;
  label: string;
  cost_usd: number;
  tokens: number;
  count: number;
  session_count: number;
}

export interface UsagePhase {
  key: string;
  label: string;
  cost_usd: number;
  tokens: number;
  main_cost_usd: number;
  subagent_cost_usd: number;
  main_tokens: number;
  subagent_tokens: number;
  share: number;
  tool_count: number;
  session_count: number;
  habits: UsageHabit[];
  tools: UsageTool[];
}

export interface UsageMapMeta {
  project_id: number | null;
  window: { date_from: string | null; date_to: string | null };
  total_usd: number;
  total_tokens: number;
  cost_available: boolean;
  costs_partial: boolean;
  sessions_analyzed: number;
  events_classified: number;
  share_basis: "cost" | "tokens";
}

export interface UsageMapResponse {
  meta: UsageMapMeta;
  phases: UsagePhase[];
}

export interface UsageEvidenceSession {
  session_id: number;
  title: string;
  project_name: string;
  cost_usd: number;
  count: number;
  exemplar_event_ids: number[];
  detail: string | null;
}

export interface UsageMapEvidenceResponse {
  node: string;
  label: string;
  rule: string;
  cost_usd: number;
  sessions: UsageEvidenceSession[];
}

export interface UsageCharacteristic {
  key: string;
  headline: string;
  share: number;
  cost_usd: number;
  kind: string;
  guidance: string;
}

export interface UsageCharacteristicsMeta {
  project_id: number | null;
  window: { date_from: string | null; date_to: string | null };
  total_usd: number;
  total_tokens: number;
  cost_available: boolean;
  costs_partial: boolean;
  sessions_analyzed: number;
  share_basis: "cost" | "tokens";
  basis_note: string;
}

export interface UsageCharacteristicsResponse {
  meta: UsageCharacteristicsMeta;
  characteristics: UsageCharacteristic[];
}

export interface Settings {
  historical_pricing: boolean;
  privacy_mode: boolean;
  team_export_prefs?: Record<string, unknown>;
}

export interface ContributionManifest {
  session_count: number;
  sequence_step_count: number;
  included_fields: string[];
  excluded: string[];
  fingerprint_caveat: string;
  privacy_level?: string;
}

export interface ContributionPreview {
  manifest: ContributionManifest;
  bundle: { sessions?: unknown[] } & Record<string, unknown>;
}

export interface ContributionExportResult {
  path: string;
  session_count: number;
}

export type TeamPrivacyLevel = "structural" | "team";

// GET /api/team/projects -> TeamProjectsResponse.
export interface TeamProjectEntry {
  export_name: string;
  default_label: string;
  session_count: number;
  tokens: number;
}

export interface TeamExportPrefs {
  member_name?: string | null;
  privacy_level?: TeamPrivacyLevel;
  project_labels?: Record<string, string>;
  deselected?: string[];
}

export interface TeamProjectsResult {
  projects: TeamProjectEntry[];
  prefs: TeamExportPrefs;
}

// POST /api/team/export and /api/team/export-preview request body.
export interface TeamExportRequestBody {
  privacy_level: TeamPrivacyLevel;
  member_name?: string | null;
  projects: { export_name: string; label?: string | null }[];
}

// GET /api/team/export-preview -> TeamExportPreviewResponse { manifest, bundle }.
export interface TeamPreview {
  manifest: ContributionManifest;
  bundle: { sessions?: unknown[] } & Record<string, unknown>;
}

// POST /api/team/export -> TeamExportResponse.
export interface TeamExportResult {
  path: string;
  bundle_id: string;
  session_count: number;
}

// POST /api/team/import and /api/team/import-bundle -> TeamImportResponse.
export interface TeamImportResult {
  bundle_id: string;
  member_id: string;
  session_count: number;
  imported: boolean;
  status: "imported" | "replaced" | "duplicate" | "stale";
}

// DELETE /api/team/members/{member_id} -> TeamMemberDeleteResponse.
export interface TeamMemberDeleteResult {
  member_id: string;
  bundles_removed: number;
}

// GET /api/team/imports -> list[TeamImportEntry].
export interface TeamImportRecord {
  id: number;
  bundle_id: string;
  profile: string;
  schema_version: number;
  member_id: string;
  generated_at: string;
  app_version?: string | null;
  imported_at: string;
  source_path: string;
  session_count: number;
  member_name?: string | null;
  privacy_level?: string;
}

// GET /api/team/dashboard -> TeamDashboardResponse (team_dashboard()).
export interface TeamDashboard {
  meta?: {
    bundle_count?: number;
    member_count?: number;
    project_count?: number;
    session_count?: number;
    date_from?: string | null;
    date_to?: string | null;
  };
  tokens?: {
    input?: number;
    output?: number;
    base?: number;
    cache_5m?: number;
    cache_1h?: number;
    cache_read?: number;
    total?: number;
  };
  stats?: {
    turns?: number;
    tool_calls?: number;
    subagents?: number;
    errors?: number;
    loops?: number;
    [key: string]: number | undefined;
  };
  providers?: Array<{ provider: string; session_count: number }>;
  models?: Array<{ model: string; session_count: number }>;
  stop_reasons?: Array<{ reason: string; count: number }>;
  risk_categories?: Array<{ category: string; session_count: number }>;
  subagents?: Array<{ agent_type: string; event_count: number; session_count: number }>;
  sequence?: Array<{ sym: string; count: number }>;
  members?: {
    member_name: string;
    member_ids: string[];
    bundle_count: number;
    project_count: number;
    session_count: number;
    tokens: number;
  }[];
  projects?: {
    project_key: string;
    project_name: string;
    member_count: number;
    session_count: number;
    tokens: number;
  }[];
  tools?: { name: string; call_count: number; session_count: number }[];
  file_types?: { ext: string; count: number; session_count: number }[];
  over_time?: Array<{ date: string; session_count: number; tokens: number }>;
}
