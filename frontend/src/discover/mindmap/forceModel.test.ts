import { describe, expect, it } from "vitest";
import type { UsageHabit, UsagePhase } from "../../api/types";
import {
  buildForceModel, groupSmallHabits, habitRadius, labelTier, phaseNode, phaseRadius,
} from "./forceModel";

function habit(key: string, costUsd: number, polarity: "good" | "anti" = "anti"): UsageHabit {
  return { key, phase: "explore", label: key, polarity, status: "confirmed",
           cost_usd: costUsd, count: 3, session_count: 2 };
}

function phase(key: string, share: number, habits: UsageHabit[] = []): UsagePhase {
  return { key, label: key[0].toUpperCase() + key.slice(1), cost_usd: share * 100,
           tokens: 1000, share, tool_count: 10, session_count: 3, habits };
}

describe("labelTier", () => {
  it("maps radius to tier per spec thresholds", () => {
    expect(labelTier(30)).toBe("inside");
    expect(labelTier(29.9)).toBe("split");
    expect(labelTier(22)).toBe("split");
    expect(labelTier(21.9)).toBe("below");
  });
});

describe("radii", () => {
  it("scales phases as 18 + 34*sqrt(share)", () => {
    expect(phaseRadius(0)).toBeCloseTo(18);
    expect(phaseRadius(0.25)).toBeCloseTo(35);
  });
  it("scales habits as 10 + 20*sqrt(share)", () => {
    expect(habitRadius(0)).toBeCloseTo(10);
    expect(habitRadius(0.04)).toBeCloseTo(14);
  });
});

describe("groupSmallHabits", () => {
  it("keeps the top 4 by cost and groups the rest", () => {
    const habits = [1, 2, 3, 4, 5, 6].map((n) => habit(`h${n}`, n * 10));
    const { visible, grouped } = groupSmallHabits(habits, 100);
    expect(visible.map((h) => h.key)).toEqual(["h6", "h5", "h4", "h3"]);
    expect(grouped.map((h) => h.key)).toEqual(["h2", "h1"]);
  });
  it("groups habits below 1% of total cost regardless of count", () => {
    const { visible, grouped } = groupSmallHabits([habit("tiny", 0.5)], 100);
    expect(visible).toHaveLength(0);
    expect(grouped.map((h) => h.key)).toEqual(["tiny"]);
  });
  it("keeps everything within the cap when there is no cost basis", () => {
    const { visible, grouped } = groupSmallHabits([habit("a", 0), habit("b", 0)], 0);
    expect(visible).toHaveLength(2);
    expect(grouped).toHaveLength(0);
  });
});

describe("phaseNode", () => {
  it("builds a selectable phase node with stable id and exact share label", () => {
    const node = phaseNode(phase("explore", 0.5));
    expect(node.id).toBe("phase:explore");
    expect(node.kind).toBe("phase");
    expect(node.sublabel).toBe("50%");
    expect(node.r).toBeCloseTo(phaseRadius(0.5));
    expect(node.labelTier).toBe(labelTier(node.r));
  });
});

describe("buildForceModel", () => {
  const phases = [
    phase("explore", 0.5, [habit("re-reads", 5)]),
    phase("implement", 0.3),
    phase("plan", 0, []), // inactive: zero share, no habits
  ];

  it("builds a pinned center plus nodes/links for active phases only", () => {
    const model = buildForceModel(phases, { totalUsd: 100, costAvailable: true });
    const ids = model.nodes.map((n) => n.id);
    expect(ids).toEqual(["center", "phase:explore", "habit:re-reads@explore", "phase:implement"]);
    const center = model.nodes[0];
    expect(center.fx).toBe(0);
    expect(center.fy).toBe(0);
    expect(center.sublabel).toBe("$100");
  });

  it("links scale distance and width with share", () => {
    const model = buildForceModel(phases, { totalUsd: 100, costAvailable: true });
    const explore = model.links.find((l) => l.targetId === "phase:explore")!;
    const implement = model.links.find((l) => l.targetId === "phase:implement")!;
    expect(explore.distance).toBeCloseTo(120 + 90 * 0.5);
    expect(explore.width).toBeCloseTo(14 * 0.5);
    expect(implement.distance).toBeCloseTo(120 + 90 * 0.3);
    expect(explore.kind).toBe("structure");
  });

  it("habit links carry polarity and habit nodes carry exact share", () => {
    const model = buildForceModel(phases, { totalUsd: 100, costAvailable: true });
    const leaf = model.nodes.find((n) => n.id === "habit:re-reads@explore")!;
    expect(leaf.polarity).toBe("anti");
    expect(leaf.share).toBeCloseTo(0.05);
    expect(leaf.sublabel).toBe("5%");
    const link = model.links.find((l) => l.targetId === leaf.id)!;
    expect(link.kind).toBe("anti");
    expect(link.sourceId).toBe("phase:explore");
  });

  it("collapses overflow habits into a grouped leaf", () => {
    const many = phase("explore", 0.5, [1, 2, 3, 4, 5].map((n) => habit(`h${n}`, n * 5)));
    const model = buildForceModel([many], { totalUsd: 100, costAvailable: true });
    const other = model.nodes.find((n) => n.id === "habit:other@explore")!;
    expect(other.label).toBe("+1 more");
    expect(other.grouped?.map((h) => h.key)).toEqual(["h1"]);
  });

  it("falls back to counts when cost is unavailable", () => {
    const model = buildForceModel(phases, { totalUsd: 0, costAvailable: false });
    expect(model.nodes[0].sublabel).toBe("");
    const leaf = model.nodes.find((n) => n.id === "habit:re-reads@explore")!;
    expect(leaf.sublabel).toBe("3x");
  });

  it("seeds deterministic non-zero starting positions", () => {
    const a = buildForceModel(phases, { totalUsd: 100, costAvailable: true });
    const b = buildForceModel(phases, { totalUsd: 100, costAvailable: true });
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
    expect(a.nodes[1].x !== 0 || a.nodes[1].y !== 0).toBe(true);
  });
});
