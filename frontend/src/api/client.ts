import type {
  CacheStats,
  ContributionExportResult,
  ContributionPreview,
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
  Settings,
  Subagent,
  TeamDashboard,
  TeamExportResult,
  TeamImportRecord,
  TeamImportResult,
  TeamMemberDeleteResult,
  TeamPreview,
  TimelineItem,
  TurnCostBreakdown,
  TraceResponse,
  UsageMapResponse,
  UsageMapEvidenceResponse,
  UsageCharacteristicsResponse,
} from "./types";

// Relative by default so dev goes through the vite proxy (/api -> backend),
// keeping API calls same-origin. Override with VITE_API_BASE only when the
// backend isn't reachable via the proxy (e.g. a built/Docker frontend).
const API_BASE = (import.meta.env.VITE_API_BASE ?? "/api").replace(/\/$/, "");

function errorMessageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (Array.isArray(parsed.detail)) {
      return parsed.detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "msg" in item) return String(item.msg);
          return JSON.stringify(item);
        })
        .join("; ");
    }
  } catch {
    // Plain-text error body.
  }
  return body;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    // Always hit the backend: analytics responses carry no cache headers and some
    // (e.g. the price-mode toggle) change server-side state without changing the
    // URL, so a cached body would otherwise be served stale.
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(errorMessageFromBody(detail) || `Request failed: ${response.status}`);
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

function costRequest(path: string, filters: CostAnalyticsFilters, historical?: boolean) {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  if (filters.projectId) params.set("project_id", String(filters.projectId));
  if (filters.model) params.set("model", filters.model);
  // Encode the pricing mode in the URL so the two modes never share one cacheable
  // request (the backend falls back to the persisted setting when it's absent).
  if (historical !== undefined) params.set("historical", String(historical));
  const query = params.toString();
  return request<CostAnalyticsResponse>(`${path}${query ? `?${query}` : ""}`);
}

export function getCostAnalytics(filters: CostAnalyticsFilters = {}, historical?: boolean) {
  return costRequest("/analytics/cost", filters, historical);
}

// Same response shape as getCostAnalytics, computed over imported team bundles.
export function getTeamCostAnalytics(filters: CostAnalyticsFilters = {}, historical?: boolean) {
  return costRequest("/team/analytics/cost", filters, historical);
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

export function getSettings() {
  return request<Settings>("/settings");
}

export function updateSettings(settings: Settings) {
  return request<Settings>("/settings", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function getContributionPreview() {
  return request<ContributionPreview>("/contribution/preview");
}

export function exportContribution() {
  return request<ContributionExportResult>("/contribution/export", { method: "POST" });
}

export function getTeamPreview() {
  return request<TeamPreview>("/team/export-preview");
}

export function exportTeamBundle() {
  return request<TeamExportResult>("/team/export", { method: "POST" });
}

export function importTeamBundle(path?: string | null) {
  return request<TeamImportResult>("/team/import", {
    method: "POST",
    body: JSON.stringify({ path: path || null }),
  });
}

export function importTeamBundleFile(filename: string, bundle: unknown) {
  return request<TeamImportResult>("/team/import-bundle", {
    method: "POST",
    body: JSON.stringify({ filename, bundle }),
  });
}

export function listTeamImports() {
  return request<TeamImportRecord[]>("/team/imports");
}

export function deleteTeamMember(memberId: string) {
  return request<TeamMemberDeleteResult>(`/team/members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
  });
}

export function getTeamDashboard() {
  return request<TeamDashboard>("/team/dashboard");
}
