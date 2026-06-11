import { describe, expect, it } from "vitest";
import type { UsageHabit, UsagePhase } from "../../api/types";
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  buildMapLayout,
  groupSmallHabits,
  sectorAngles,
} from "./mapGeometry";

function habit(key: string, cost: number, polarity: "good" | "anti" = "anti"): UsageHabit {
  return { key, phase: "explore", label: key, polarity, status: "confirmed",
           cost_usd: cost, count: 1, session_count: 1 };
}

function phase(key: string, share: number, habits: UsageHabit[] = []): UsagePhase {
  return { key, label: key, cost_usd: share * 100, tokens: 0, share,
           tool_count: 1, session_count: 1, habits };
}

describe("sectorAngles", () => {
  it("spans exactly 360 degrees", () => {
    const sectors = sectorAngles([0.5, 0.3, 0.2]);
    expect(sectors[0].start).toBe(0);
    expect(sectors[sectors.length - 1].end).toBeCloseTo(360, 6);
    for (let i = 1; i < sectors.length; i += 1) {
      expect(sectors[i].start).toBeCloseTo(sectors[i - 1].end, 6);
    }
  });

  it("keeps angles proportional to share", () => {
    const sectors = sectorAngles([0.6, 0.4]);
    const span0 = sectors[0].end - sectors[0].start;
    const span1 = sectors[1].end - sectors[1].start;
    expect(span0 / span1).toBeCloseTo(1.5, 6);
  });

  it("enforces a minimum sector for tiny shares and still sums to 360", () => {
    const sectors = sectorAngles([0.97, 0.01, 0.01, 0.01]);
    for (const sector of sectors.slice(1)) {
      expect(sector.end - sector.start).toBeGreaterThan(10);
    }
    expect(sectors[sectors.length - 1].end).toBeCloseTo(360, 6);
  });

  it("handles empty input", () => {
    expect(sectorAngles([])).toEqual([]);
  });
});

describe("groupSmallHabits", () => {
  it("keeps at most 4 visible and groups the rest", () => {
    const habits = [10, 9, 8, 7, 6, 5].map((c, i) => habit(`h${i}`, c));
    const { visible, grouped } = groupSmallHabits(habits, 100);
    expect(visible).toHaveLength(4);
    expect(grouped).toHaveLength(2);
    expect(visible[0].cost_usd).toBe(10); // sorted by cost desc
  });

  it("groups sub-1%-of-total habits", () => {
    const { visible, grouped } = groupSmallHabits(
      [habit("big", 50), habit("tiny", 0.2)], 100);
    expect(visible.map((h) => h.key)).toEqual(["big"]);
    expect(grouped.map((h) => h.key)).toEqual(["tiny"]);
  });

  it("keeps everything visible when total cost is zero (token fallback)", () => {
    const { visible, grouped } = groupSmallHabits([habit("a", 0), habit("b", 0)], 0);
    expect(visible).toHaveLength(2);
    expect(grouped).toHaveLength(0);
  });
});

describe("buildMapLayout", () => {
  const phases = [
    phase("explore", 0.5, [habit("re-reads", 5), habit("tdd-loop", 3, "good")]),
    phase("implement", 0.3),
    phase("verify", 0.2),
    phase("plan", 0), // empty phase: dropped from the canvas
  ];

  it("produces a center, one node per active phase, and habit leaves", () => {
    const layout = buildMapLayout(phases, { totalUsd: 100, costAvailable: true });
    const kinds = layout.nodes.map((n) => n.kind);
    expect(kinds.filter((k) => k === "center")).toHaveLength(1);
    expect(kinds.filter((k) => k === "phase")).toHaveLength(3);
    expect(kinds.filter((k) => k === "habit")).toHaveLength(2);
    expect(layout.nodes.find((n) => n.id === "phase:plan")).toBeUndefined();
  });

  it("emits finite coordinates inside the canvas for every node", () => {
    const layout = buildMapLayout(phases, { totalUsd: 100, costAvailable: true });
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(MAP_WIDTH);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(MAP_HEIGHT);
    }
  });

  it("connects every non-center node to its parent with an edge", () => {
    const layout = buildMapLayout(phases, { totalUsd: 100, costAvailable: true });
    const nodeIds = new Set(layout.nodes.map((n) => n.id));
    expect(layout.edges).toHaveLength(layout.nodes.length - 1);
    for (const edge of layout.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
      expect(edge.d).toMatch(/^M /);
      expect(edge.width).toBeGreaterThan(0);
    }
  });

  it("adds a grouped overflow leaf when a phase has more than 4 habits", () => {
    const many = phase("explore", 1, [5, 4, 3, 2, 1.5, 1.2].map((c, i) => habit(`h${i}`, c)));
    const layout = buildMapLayout([many], { totalUsd: 10, costAvailable: true });
    const overflow = layout.nodes.find((n) => n.id === "habit:other@explore");
    expect(overflow).toBeDefined();
    expect(overflow?.grouped?.length).toBe(2);
  });

  it("carries exact share labels for accuracy", () => {
    const layout = buildMapLayout(phases, { totalUsd: 100, costAvailable: true });
    const explore = layout.nodes.find((n) => n.id === "phase:explore");
    expect(explore?.sublabel).toBe("50%");
  });
});
