// Pure helpers for rendering a contribution specimen row.
// Everything here is a faithful, lossless re-presentation of the bundle's own
// closed-vocabulary symbols. No value is invented, only relabeled for reading.

export type SymKind = "inspect" | "write" | "shell" | "agent" | "call" | "ok" | "err" | "muted";

export interface SeqStep {
  sym: string;
  fam?: string;
  dt_s?: number;
  out_tok?: number;
}

export interface SessionTokens {
  input: number;
  output: number;
  base: number;
  cache_5m: number;
  cache_1h: number;
  cache_read: number;
}

export interface SessionStats {
  turns: number;
  tool_calls: number;
  subagents: number;
  errors: number;
  system: number;
  loops: number;
  max_repeat: number;
  persisted_outputs: number;
}

export interface SessionSubagent {
  agent_type: string;
  event_count: number;
}

export interface ContributionSession {
  sid?: string;
  models?: string[];
  first_date?: string | null;
  duration_s?: number;
  tokens?: Partial<SessionTokens>;
  stats?: Partial<SessionStats>;
  stop_reasons?: Record<string, number>;
  risk_categories?: string[];
  subagents?: SessionSubagent[];
  sequence?: SeqStep[];
}

// Map a closed-vocabulary event symbol to a short label and visual kind.
// Mirrors the producer in backend analysis/contribution.py (sanitize_symbol).
export function prettySymbol(sym: string): { label: string; kind: SymKind } {
  const parts = sym.split(":");
  if (parts[0] === "RESULT") {
    if (parts[1] === "ok") return { label: "ok", kind: "ok" };
    if (parts[1] === "error") return { label: parts[2] ?? "error", kind: "err" };
    return { label: "result", kind: "muted" };
  }
  // CALL:*
  if (parts[1] === "inspect") return { label: parts[2] ?? "read", kind: "inspect" };
  if (parts[1] === "write") return { label: parts[2] ?? "write", kind: "write" };
  if (parts[1] === "Bash" || parts[1] === "PowerShell") {
    return { label: parts[2] ? `${parts[1]}:${parts[2]}` : parts[1], kind: "shell" };
  }
  if (parts[1] === "Agent") return { label: "Agent", kind: "agent" };
  return { label: parts[1] ?? "call", kind: "call" };
}

// Friendly model name for a bucketed model id, falling back to the raw id so an
// unrecognized shape is shown verbatim rather than mislabeled.
export function prettyModel(id: string): string {
  const family = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/);
  if (family) {
    const name = family[1][0].toUpperCase() + family[1].slice(1);
    return `${name} ${family[2]}.${family[3]}`;
  }
  const fable = id.match(/^claude-fable-(\d+)$/);
  if (fable) return `Fable ${fable[1]}`;
  const legacy = id.match(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)$/);
  if (legacy) {
    const name = legacy[3][0].toUpperCase() + legacy[3].slice(1);
    return `${name} ${legacy[1]}.${legacy[2]}`;
  }
  const legacyMajor = id.match(/^claude-(\d+)-(opus|sonnet|haiku)$/);
  if (legacyMajor) {
    const name = legacyMajor[2][0].toUpperCase() + legacyMajor[2].slice(1);
    return `${name} ${legacyMajor[1]}`;
  }
  if (id === "other") return "Other";
  if (id === "unknown") return "Unknown";
  return id;
}

// Compact integer (1234 -> "1,234"; 1_200_000 -> "1.2M").
export function compactInt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString("en-US");
}

// Human-readable duration from seconds ("4m", "1h 12m", "<1m").
export function formatDuration(seconds: number): string {
  if (!seconds || seconds < 60) return "<1m";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return remainingMins ? `${hours}h ${remainingMins}m` : `${hours}h`;
}
