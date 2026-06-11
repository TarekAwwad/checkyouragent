import { describe, expect, it } from "vitest";
import { buildStreamBands, packLanes, stackedPaths } from "./streamGeometry";
import type { ContextThread } from "../../api/types";

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
