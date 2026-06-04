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
