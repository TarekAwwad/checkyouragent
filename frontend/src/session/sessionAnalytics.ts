// Pure helpers that derive the session analytics tiles from already-fetched
// query data (timeline items, trace spans, subagents). No network access.
import type { Subagent, TimelineItem, TraceSpan } from "../api/types";
import type { LoopContext } from "../trace/loopContext";
import { groupTurns } from "../trace/useTurns";

// An error event in the timeline is surfaced by the backend as kind "system"
// (covers both tool errors and system messages). See repository._timeline_kind.
export function isErrorItem(item: TimelineItem): boolean {
  return item.kind === "system";
}

function toMs(ts: string | null): number | null {
  if (!ts) return null;
  const value = Date.parse(ts);
  return Number.isNaN(value) ? null : value;
}

export interface DensityBucket {
  index: number;
  count: number;
  hasError: boolean;
  hasLoop: boolean;
}

export interface DensityModel {
  buckets: DensityBucket[];
  total: number;
  maxCount: number;
  durationMinutes: number;
}

// Bucket timeline events evenly across the session timespan. Falls back to
// even index spacing when timestamps are missing.
export function buildDensity(
  items: TimelineItem[],
  loopContexts: Map<number, LoopContext> | undefined,
  bucketCount = 32,
): DensityModel {
  const buckets: DensityBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    index,
    count: 0,
    hasError: false,
    hasLoop: false,
  }));
  if (items.length === 0) {
    return { buckets, total: 0, maxCount: 0, durationMinutes: 0 };
  }

  const stamps = items.map((item) => toMs(item.timestamp));
  const valid = stamps.filter((value): value is number => value !== null);
  const minMs = valid.length ? Math.min(...valid) : null;
  const maxMs = valid.length ? Math.max(...valid) : null;
  const span = minMs !== null && maxMs !== null ? maxMs - minMs : 0;

  const bucketFor = (index: number): number => {
    const stamp = stamps[index];
    if (minMs !== null && maxMs !== null && span > 0 && stamp !== null) {
      return Math.min(bucketCount - 1, Math.floor(((stamp - minMs) / span) * bucketCount));
    }
    // No usable timestamps: spread events evenly by position.
    return Math.min(bucketCount - 1, Math.floor((index / items.length) * bucketCount));
  };

  items.forEach((item, index) => {
    const bucket = buckets[bucketFor(index)];
    bucket.count += 1;
    if (isErrorItem(item)) bucket.hasError = true;
    if (loopContexts?.has(item.event_id)) bucket.hasLoop = true;
  });

  const maxCount = Math.max(...buckets.map((bucket) => bucket.count), 0);
  return {
    buckets,
    total: items.length,
    maxCount,
    durationMinutes: span > 0 ? span / 60000 : 0,
  };
}

export interface ToolUsageRow {
  name: string;
  count: number;
}

// Top-N tool calls grouped by tool_name across the timeline.
export function buildToolUsage(items: TimelineItem[], limit = 5): ToolUsageRow[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool_call") continue;
    const name = item.tool_name;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface TurnCostRow {
  label: string;
  // Cost in USD when pricing is available; otherwise raw token volume.
  value: number;
  spike: boolean;
}

export interface TurnCostModel {
  rows: TurnCostRow[];
  // True when rows are priced USD; false when they fall back to token volume.
  priced: boolean;
  maxValue: number;
}

// Per-turn cost. Trace spans carry input/output tokens + model, but the
// frontend has no pricing table, so we approximate per-turn weight by summing
// each turn's token volume from the trace spans whose event falls in the turn.
// When the session cost is available we scale the token weight by the global
// $/token so the bars read as dollars; otherwise we show token volume.
export function buildTurnCosts(
  items: TimelineItem[],
  spans: TraceSpan[],
  costUsd: number,
  costAvailable: boolean,
  limit = 6,
): TurnCostModel {
  const tokensByEvent = new Map<number, number>();
  let totalTokens = 0;
  for (const span of spans) {
    const tokens = (span.input_tokens ?? 0) + (span.output_tokens ?? 0);
    tokensByEvent.set(span.event_id, (tokensByEvent.get(span.event_id) ?? 0) + tokens);
    totalTokens += tokens;
  }

  const turns = groupTurns(items);
  const turnTokens = turns.map((turn) =>
    turn.items.reduce((sum, item) => sum + (tokensByEvent.get(item.event_id) ?? 0), 0),
  );

  const priced = costAvailable && costUsd > 0 && totalTokens > 0;
  const perToken = priced ? costUsd / totalTokens : 0;
  const rawValues = turnTokens.map((tokens) => (priced ? tokens * perToken : tokens));

  // Spike = value exceeds mean + 1σ (or simply the max when σ is ~0).
  const nonZero = rawValues.filter((value) => value > 0);
  const mean = nonZero.length ? nonZero.reduce((s, v) => s + v, 0) / nonZero.length : 0;
  const variance = nonZero.length
    ? nonZero.reduce((s, v) => s + (v - mean) ** 2, 0) / nonZero.length
    : 0;
  const std = Math.sqrt(variance);
  const maxValue = Math.max(...rawValues, 0);
  const spikeThreshold = std > 0 ? mean + std : maxValue;

  const rows: TurnCostRow[] = rawValues.map((value, index) => ({
    label: `T${index + 1}`,
    value,
    spike: value > 0 && value >= spikeThreshold && value === maxValue,
  }));

  return { rows: rows.slice(0, limit), priced, maxValue };
}

export interface SubagentHeatCell {
  id: string;
  label: string;
  agentId: string;
  agentType: string | null;
  name: string | null;
  description: string | null;
  toolUseId: string | null;
  firstTs: string | null;
  lastTs: string | null;
  events: number;
  level: 0 | 1 | 2 | 3;
}

export interface SubagentHeatModel {
  count: number;
  totalEvents: number;
  cells: SubagentHeatCell[];
}

// Heat level by share of the busiest subagent's event count.
function heatLevel(events: number, max: number): 0 | 1 | 2 | 3 {
  if (max <= 0 || events <= 0) return 0;
  const ratio = events / max;
  if (ratio >= 0.66) return 3;
  if (ratio >= 0.33) return 2;
  return 1;
}

export function buildSubagentHeat(subagents: Subagent[]): SubagentHeatModel {
  const sorted = [...subagents].sort((a, b) => {
    const aStart = toMs(a.first_ts);
    const bStart = toMs(b.first_ts);
    if (aStart !== null && bStart !== null && aStart !== bStart) return aStart - bStart;
    if (aStart !== null && bStart === null) return -1;
    if (aStart === null && bStart !== null) return 1;
    return a.agent_id.localeCompare(b.agent_id);
  });
  const totalEvents = sorted.reduce((sum, agent) => sum + agent.event_count, 0);
  const max = Math.max(...sorted.map((agent) => agent.event_count), 0);
  const cells: SubagentHeatCell[] = sorted.map((agent, index) => ({
    id: agent.agent_id,
    label: `A${index + 1}`,
    agentId: agent.agent_id,
    agentType: agent.agent_type,
    name: agent.name,
    description: agent.description,
    toolUseId: agent.tool_use_id,
    firstTs: agent.first_ts,
    lastTs: agent.last_ts,
    events: agent.event_count,
    level: heatLevel(agent.event_count, max),
  }));
  return { count: subagents.length, totalEvents, cells };
}

// Cache hit %: cache-read tokens over all input tokens. Trace spans do not
// carry cache-read counts, so this is sourced from the session cost aggregate
// (trace.cost.tokens). Returns null when no input tokens are known.
export function cacheHitPct(tokens: {
  base_input: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
} | null | undefined): number | null {
  if (!tokens) return null;
  const input =
    tokens.base_input + tokens.cache_write_5m + tokens.cache_write_1h + tokens.cache_read;
  if (input <= 0) return null;
  return Math.round((tokens.cache_read / input) * 100);
}
