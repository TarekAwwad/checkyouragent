import { describe, expect, it } from "vitest";
import { buildStreamBands, counterfactualSeries, packLanes, stackedPaths } from "./streamGeometry";
import type { ContextFinding, ContextThread } from "../../api/types";

const thread: ContextThread = {
  agent_id: null,
  calls: [
    { turn: 0, ts: null, context_tokens: 10_000, model: "m" },
    { turn: 1, ts: null, context_tokens: 22_000, model: "m" },
    { turn: 2, ts: null, context_tokens: 22_500, model: "m" },
  ],
  epochs: [{ start_turn: 0, end_turn: 2, ended_by: "end" }],
  contributors: [
    { id: "baseline-0", kind: "baseline", label: "System prompt + initial context",
      entry_turn: 0, end_turn: 2, est_tokens: 10_000, accrued_usd: 0.03, event_id: null },
    { id: "tool_result-1-1", kind: "tool_result", label: "Read result: a.py",
      entry_turn: 1, end_turn: 2, est_tokens: 11_500, accrued_usd: 0.02, event_id: 5 },
    { id: "user-1-2", kind: "user", label: "User message",
      entry_turn: 1, end_turn: 2, est_tokens: 500, accrued_usd: 0.001, event_id: 6 },
  ],
  findings: [],
};

describe("buildStreamBands", () => {
  it("stacks bands so each call column sums to its context size", () => {
    const bands = buildStreamBands(thread, 8);
    for (let i = 0; i < thread.calls.length; i += 1) {
      const sum = bands.reduce((acc, band) => acc + band.values[i], 0);
      expect(sum).toBe(thread.calls[i].context_tokens);
    }
  });

  it("buckets beyond maxBands into 'other'", () => {
    const bands = buildStreamBands(thread, 2); // baseline + 1 slot -> rest bucketed
    expect(bands.length).toBeLessThanOrEqual(3); // baseline, top contributor, other
    expect(bands.some((band) => band.id === "other")).toBe(true);
  });

  it("keeps a contributor's band zero before entry and after epoch end", () => {
    const bands = buildStreamBands(thread, 8);
    const read = bands.find((band) => band.id === "tool_result-1-1");
    expect(read?.values).toEqual([0, 11_500, 11_500]);
  });

  it("never drives the baseline band negative when contributors overshoot context", () => {
    // Contributor est_tokens (12k) exceed the call's context (10k) — a pathological
    // backend residue. The baseline must clamp to 0, not invert.
    const overshoot: ContextThread = {
      ...thread,
      calls: [{ turn: 0, ts: null, context_tokens: 10_000, model: "m" }],
      epochs: [{ start_turn: 0, end_turn: 0, ended_by: "end" }],
      contributors: [
        { id: "baseline-0", kind: "baseline", label: "b", entry_turn: 0, end_turn: 0,
          est_tokens: 10_000, accrued_usd: 0, event_id: null },
        { id: "tool_result-0-1", kind: "tool_result", label: "huge", entry_turn: 0, end_turn: 0,
          est_tokens: 12_000, accrued_usd: 0, event_id: 9 },
      ],
    };
    const bands = buildStreamBands(overshoot, 8);
    expect(bands.every((band) => band.values.every((v) => v >= 0))).toBe(true);
  });
});

describe("stackedPaths", () => {
  it("produces one closed SVG path per band scaled to the viewbox", () => {
    const bands = buildStreamBands(thread, 8);
    const paths = stackedPaths(bands, 560, 150);
    expect(paths).toHaveLength(bands.length);
    for (const path of paths) {
      expect(path.d.startsWith("M")).toBe(true);
      expect(path.d.endsWith("Z")).toBe(true);
    }
  });
});

describe("counterfactualSeries", () => {
  const baseFinding: ContextFinding = {
    archetype: "oversized",
    session_id: 1, session_title: "t", project_name: "p",
    epoch: 0, entry_turn: 1, label: "Read result: a.py (11,500 tok)",
    carried_turns: 1, carried_tokens: 11_500, savings_tokens: 10_000,
    savings_usd: 0.02,
    counterfactual: { model: "capped", params: { cap_tokens: 1_500 } },
    event_id: 5,
  };

  it("subtracts contributor savings over the carry window", () => {
    expect(counterfactualSeries(thread, baseFinding)).toEqual([10_000, 12_000, 12_500]);
  });

  it("matches the observed series outside the affected turns", () => {
    const cf = counterfactualSeries(thread, baseFinding)!;
    expect(cf[0]).toBe(thread.calls[0].context_tokens);
  });

  it("drops a fixed ballast after the compaction-eligible turn", () => {
    const finding: ContextFinding = {
      ...baseFinding,
      archetype: "late_compaction",
      entry_turn: 1,
      counterfactual: { model: "compact", params: { eligible_turn: 1, retained_tokens: 2_000 } },
    };
    // dropped = 22000 - 2000 = 20000 from turn 1 onward
    expect(counterfactualSeries(thread, finding)).toEqual([10_000, 2_000, 2_500]);
  });

  it("removes the pre-gap ballast for stale continuations", () => {
    const finding: ContextFinding = {
      ...baseFinding,
      archetype: "stale_continuation",
      entry_turn: 2,
      counterfactual: { model: "fresh session", params: { baseline_tokens: 10_000, gap_minutes: 90 } },
    };
    // avoidable = context[1] - baseline = 12000, removed from turn 2 onward
    expect(counterfactualSeries(thread, finding)).toEqual([10_000, 22_000, 10_500]);
  });

  it("returns null when the finding cannot be reconstructed", () => {
    expect(counterfactualSeries(thread, { ...baseFinding, entry_turn: 99 })).toBeNull();
    expect(counterfactualSeries(thread, { ...baseFinding, savings_tokens: 0 })).toBeNull();
    expect(counterfactualSeries(thread, {
      ...baseFinding,
      archetype: "late_compaction",
      counterfactual: { model: "compact", params: {} },
    })).toBeNull();
  });
});

describe("packLanes", () => {
  it("orders lanes by entry turn and scales thickness by tokens", () => {
    const lanes = packLanes(thread.contributors, 3);
    expect(lanes.map((lane) => lane.id)).toEqual(["baseline-0", "tool_result-1-1", "user-1-2"]);
    const baseline = lanes[0];
    const user = lanes[2];
    expect(baseline.thickness).toBeGreaterThan(user.thickness);
    expect(baseline.x0).toBe(0);
    expect(baseline.x1).toBe(2);
  });
});
