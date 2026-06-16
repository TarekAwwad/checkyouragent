import type {
  CacheStats,
  ContextEconomicsResponse,
  CostAnalyticsFilters,
  CostAnalyticsResponse,
  DiscoveryFilters,
  DiscoveryResponse,
  DiscoveredProject,
  EventDetail,
  ImportProgress,
  ImportSummary,
  Project,
  RiskFinding,
  RuntimeConfig,
  SearchResult,
  SessionCard,
  SessionContextEconomicsResponse,
  Subagent,
  TimelineItem,
  TurnCostBreakdown,
  TraceResponse,
  UsageMapResponse,
  UsageMapEvidenceResponse,
  UsageCharacteristicsResponse,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "http://localhost:8000/api").replace(/\/$/, "");

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function createImport(sourcePath?: string | null, project?: string | null) {
  return request<ImportSummary>("/imports", {
    method: "POST",
    body: JSON.stringify({ source_path: sourcePath || null, project: project || null }),
  });
}

export function discoverSourceProjects(sourcePath?: string | null) {
  const query = sourcePath ? `?source_path=${encodeURIComponent(sourcePath)}` : "";
  return request<DiscoveredProject[]>(`/source/projects${query}`);
}

export function resetImports() {
  return request<{ ok: boolean }>("/imports/reset", { method: "POST" });
}

export function listImports() {
  return request<Array<Record<string, unknown>>>("/imports");
}

export function getImportProgress() {
  return request<ImportProgress>("/imports/progress");
}

export function getRuntimeConfig() {
  return request<RuntimeConfig>("/config");
}

export function getCacheStats() {
  return request<CacheStats>("/stats");
}

export function listProjects() {
  return request<Project[]>("/projects");
}

export interface SessionFilters {
  projectId?: number | null;
  q?: string;
  hasSubagents?: boolean | null;
  hasErrors?: boolean | null;
}

export function listSessions(filters: SessionFilters = {}) {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("project_id", String(filters.projectId));
  if (filters.q) params.set("q", filters.q);
  if (filters.hasSubagents !== undefined && filters.hasSubagents !== null) {
    params.set("has_subagents", String(filters.hasSubagents));
  }
  if (filters.hasErrors !== undefined && filters.hasErrors !== null) {
    params.set("has_errors", String(filters.hasErrors));
  }
  const query = params.toString();
  return request<SessionCard[]>(`/sessions${query ? `?${query}` : ""}`);
}

export function getSession(sessionId: number) {
  return request<SessionCard>(`/sessions/${sessionId}`);
}

export function getTimeline(sessionId: number) {
  return request<TimelineItem[]>(`/sessions/${sessionId}/timeline`);
}

export async function getTrace(sessionId: number) {
  const trace = await request<TraceResponse>(`/sessions/${sessionId}/trace`);
  if (import.meta.env.DEV) {
    // Dev-only: surface the cost payload so it's clear whether pricing is loading.
    console.debug(`[ccfr] trace ${sessionId} cost:`, trace.cost);
  }
  return trace;
}

export function getSessionTurnCosts(sessionId: number) {
  return request<TurnCostBreakdown>(`/sessions/${sessionId}/turn-costs`);
}

export function getSubagents(sessionId: number) {
  return request<Subagent[]>(`/sessions/${sessionId}/subagents`);
}

export function getSessionFindings(sessionId: number) {
  return request<RiskFinding[]>(`/sessions/${sessionId}/findings`);
}

export function getEvent(eventId: number, includeRaw = true) {
  return request<EventDetail>(`/events/${eventId}?include_raw=${includeRaw}`);
}

export function search(q: string, sessionId?: number) {
  const params = new URLSearchParams({ q });
  if (sessionId) params.set("session_id", String(sessionId));
  return request<SearchResult[]>(`/search?${params.toString()}`);
}

export function getCostAnalytics(filters: CostAnalyticsFilters = {}) {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.projectId) params.set("project_id", String(filters.projectId));
  if (filters.model) params.set("model", filters.model);
  const query = params.toString();
  return request<CostAnalyticsResponse>(`/analytics/cost${query ? `?${query}` : ""}`);
}

export function getDiscoveryAnalytics(filters: DiscoveryFilters = {}) {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("project_id", String(filters.projectId));
  if (filters.minSupport) params.set("min_support", String(filters.minSupport));
  const query = params.toString();
  return request<DiscoveryResponse>(`/analytics/discovery${query ? `?${query}` : ""}`);
}

export function getContextEconomics(filters: { projectId?: number | null; minSupport?: number } = {}) {
  const params = new URLSearchParams();
  if (filters.projectId != null) params.set("project_id", String(filters.projectId));
  if (filters.minSupport != null) params.set("min_support", String(filters.minSupport));
  const query = params.toString();
  return request<ContextEconomicsResponse>(`/analytics/context-economics${query ? `?${query}` : ""}`);
}

export function getSessionContextEconomics(sessionId: number) {
  return request<SessionContextEconomicsResponse>(`/sessions/${sessionId}/context-economics`);
}

export interface UsageMapFilters {
  projectId?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

function usageMapParams(filters: UsageMapFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.projectId != null) params.set("project_id", String(filters.projectId));
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  return params;
}

export function getUsageMap(filters: UsageMapFilters = {}) {
  const query = usageMapParams(filters).toString();
  return request<UsageMapResponse>(`/analytics/usage-map${query ? `?${query}` : ""}`);
}

export function getUsageMapEvidence(node: string, filters: UsageMapFilters = {}) {
  const params = usageMapParams(filters);
  params.set("node", node);
  return request<UsageMapEvidenceResponse>(`/analytics/usage-map/evidence?${params}`);
}

export function getUsageCharacteristics(filters: UsageMapFilters = {}) {
  const query = usageMapParams(filters).toString();
  return request<UsageCharacteristicsResponse>(
    `/analytics/usage-characteristics${query ? `?${query}` : ""}`,
  );
}
