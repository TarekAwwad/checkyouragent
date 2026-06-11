// Pure layout math for the context stream and ballast lanes. No React, no DOM:
// everything here is unit-testable and reused by the archetype-card thumbnails.
import type { ContextContributor, ContextFinding, ContextThread } from "../../api/types";

export interface StreamBand {
  id: string;
  label: string;
  kind: string;
  values: number[]; // tokens contributed at each call index (0 outside lifetime)
}

export interface BandPath {
  id: string;
  label: string;
  kind: string;
  d: string;
}

export interface Lane {
  id: string;
  label: string;
  kind: string;
  x0: number; // entry turn
  x1: number; // end turn
  thickness: number; // px, sqrt-scaled by tokens
  tokens: number;
  accruedUsd: number;
  eventId: number | null;
}

const MIN_LANE_THICKNESS = 4;
const MAX_LANE_THICKNESS = 22;

function contributorValues(contributor: ContextContributor, callCount: number): number[] {
  const values = new Array<number>(callCount).fill(0);
  for (let i = contributor.entry_turn; i <= Math.min(contributor.end_turn, callCount - 1); i += 1) {
    values[i] = contributor.est_tokens;
  }
  return values;
}

export function buildStreamBands(thread: ContextThread, maxBands: number): StreamBand[] {
  const callCount = thread.calls.length;
  const baselines = thread.contributors.filter((c) => c.kind === "baseline");
  const rest = thread.contributors
    .filter((c) => c.kind !== "baseline")
    .sort((a, b) => b.est_tokens - a.est_tokens);
  const visible = rest.slice(0, Math.max(0, maxBands - 1));
  const bucketed = rest.slice(Math.max(0, maxBands - 1));

  const bands: StreamBand[] = [];
  // All baselines share one band (an epoch has exactly one alive at a time).
  const baselineValues = new Array<number>(callCount).fill(0);
  for (const baseline of baselines) {
    const values = contributorValues(baseline, callCount);
    for (let i = 0; i < callCount; i += 1) baselineValues[i] += values[i];
  }
  bands.push({ id: "baseline", label: "Conversation baseline", kind: "baseline", values: baselineValues });

  for (const contributor of visible.sort((a, b) => a.entry_turn - b.entry_turn)) {
    bands.push({
      id: contributor.id,
      label: contributor.label,
      kind: contributor.kind,
      values: contributorValues(contributor, callCount),
    });
  }
  if (bucketed.length > 0) {
    const other = new Array<number>(callCount).fill(0);
    for (const contributor of bucketed) {
      const values = contributorValues(contributor, callCount);
      for (let i = 0; i < callCount; i += 1) other[i] += values[i];
    }
    bands.push({ id: "other", label: `Other (${bucketed.length})`, kind: "other", values: other });
  }

  // Calibration guarantee: per call, band sums must equal the observed context.
  // Rounding in the backend can leave a ±few-token residue; absorb it into the
  // baseline band so the stream never lies about the total. Clamp to 0 so a
  // contributor-sum overshoot (should never exceed context by more than rounding)
  // can't drive the baseline negative and invert its ribbon.
  for (let i = 0; i < callCount; i += 1) {
    const sum = bands.reduce((acc, band) => acc + band.values[i], 0);
    bands[0].values[i] = Math.max(0, bands[0].values[i] + thread.calls[i].context_tokens - sum);
  }
  return bands;
}

export function stackedPaths(bands: StreamBand[], width: number, height: number): BandPath[] {
  const callCount = bands[0]?.values.length ?? 0;
  if (callCount === 0) return [];
  const maxTotal = Math.max(
    1,
    ...Array.from({ length: callCount }, (_, i) =>
      bands.reduce((acc, band) => acc + band.values[i], 0)),
  );
  const x = (i: number) => (callCount === 1 ? width : (i / (callCount - 1)) * width);
  const y = (tokens: number) => height - (tokens / maxTotal) * height;

  const cumulative = new Array<number>(callCount).fill(0);
  const paths: BandPath[] = [];
  for (const band of bands) {
    const bottoms = cumulative.slice();
    const tops = cumulative.map((base, i) => base + band.values[i]);
    const top = tops.map((tokens, i) => `${x(i).toFixed(1)},${y(tokens).toFixed(1)}`);
    const bottom = bottoms
      .map((tokens, i) => `${x(i).toFixed(1)},${y(tokens).toFixed(1)}`)
      .reverse();
    paths.push({
      id: band.id,
      label: band.label,
      kind: band.kind,
      d: `M${top.join(" L")} L${bottom.join(" L")} Z`,
    });
    for (let i = 0; i < callCount; i += 1) cumulative[i] = tops[i];
  }
  return paths;
}

/**
 * Reconstruct the per-turn context sizes the session would have had if the
 * finding's counterfactual had been applied. Mirrors the backend's savings
 * models (context_economics.py): outside the affected turns the series equals
 * the observed context, so the gap between the two curves IS the claimed waste.
 *
 * Returns null when the counterfactual cannot be reconstructed (missing params
 * or a finding that doesn't map onto this thread).
 */
export function counterfactualSeries(
  thread: ContextThread,
  finding: ContextFinding,
): number[] | null {
  const n = thread.calls.length;
  const entry = finding.entry_turn;
  if (n === 0 || entry < 0 || entry >= n) return null;
  const actual = thread.calls.map((call) => call.context_tokens);
  const cf = actual.slice();
  const epoch = thread.epochs[finding.epoch];
  const epochEnd = Math.min(epoch ? epoch.end_turn : n - 1, n - 1);
  const params = finding.counterfactual?.params ?? {};

  if (finding.archetype === "late_compaction") {
    // Compaction at the eligible turn keeps `retained_tokens`; the dropped
    // ballast is a fixed count carried through the rest of the epoch.
    const retained = params.retained_tokens;
    if (retained === undefined) return null;
    const dropped = actual[entry] - retained;
    if (dropped <= 0) return null;
    for (let i = entry; i <= epochEnd; i += 1) cf[i] = Math.max(0, actual[i] - dropped);
    return cf;
  }

  if (finding.archetype === "stale_continuation") {
    // The follow-up runs in a fresh session at baseline context: the ballast
    // carried across the idle gap disappears for every tail call.
    const baseline = params.baseline_tokens;
    if (baseline === undefined || entry === 0) return null;
    const avoidable = actual[entry - 1] - baseline;
    if (avoidable <= 0) return null;
    for (let i = entry; i < n; i += 1) cf[i] = Math.max(0, actual[i] - avoidable);
    return cf;
  }

  // Contributor-level archetypes (rereads, oversized): the saved tokens stop
  // being carried from the entry turn through the end of the carry window.
  if (finding.savings_tokens <= 0) return null;
  const end = Math.min(entry + Math.max(0, finding.carried_turns), epochEnd);
  for (let i = entry; i <= end; i += 1) cf[i] = Math.max(0, actual[i] - finding.savings_tokens);
  return cf;
}

export function packLanes(contributors: ContextContributor[], callCount: number): Lane[] {
  const maxTokens = Math.max(1, ...contributors.map((c) => c.est_tokens));
  return contributors
    .slice()
    .sort((a, b) => a.entry_turn - b.entry_turn || b.est_tokens - a.est_tokens)
    .map((contributor) => ({
      id: contributor.id,
      label: contributor.label,
      kind: contributor.kind,
      x0: contributor.entry_turn,
      x1: Math.min(contributor.end_turn, Math.max(0, callCount - 1)),
      thickness:
        MIN_LANE_THICKNESS
        + Math.sqrt(contributor.est_tokens / maxTokens) * (MAX_LANE_THICKNESS - MIN_LANE_THICKNESS),
      tokens: contributor.est_tokens,
      accruedUsd: contributor.accrued_usd,
      eventId: contributor.event_id,
    }));
}
