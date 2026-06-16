import { describe, expect, it } from "vitest";
import type { UsageHabit, UsagePhase, UsageTool } from "../../api/types";
import {
  buildForceModel, deriveOriginPhases, groupSmallLeaves, habitRadius, labelTier,
  phaseNode, phaseRadius,
} from "./forceModel";

function habit(key: string, costUsd: number, polarity: "good" | "anti" = "anti"): UsageHabit {
  return { key, phase: "explore", label: key, polarity, status: "confirmed",
           cost_usd: costUsd, count: 3, session_count: 2 };
}

function phase(key: string, share: number, habits: UsageHabit[] = [],
               tools: UsageTool[] = [], split?: Partial<UsagePhase>): UsagePhase {
  const cost = share * 100;
  return { key, label: key[0].toUpperCase() + key.slice(1), cost_usd: cost,
           tokens: 1000, share, tool_count: 10, session_count: 3, habits, tools,
           main_cost_usd: cost, subagent_cost_usd: 0,
           main_tokens: 1000, subagent_tokens: 0, ...split };
}

function tool(key: string, costUsd: number, count = 3): UsageTool {
  return { key, label: key, cost_usd: costUsd, tokens: 1000, count, session_count: 2 };
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

describe("groupSmallLeaves", () => {
  it("keeps the top 4 by cost and groups the rest", () => {
    const habits = [1, 2, 3, 4, 5, 6].map((n) => habit(`h${n}`, n * 10));
    const { visible, grouped } = groupSmallLeaves(habits, 100);
    expect(visible.map((h) => h.key)).toEqual(["h6", "h5", "h4", "h3"]);
    expect(grouped.map((h) => h.key)).toEqual(["h2", "h1"]);
  });
  it("groups habits below 1% of total cost regardless of count", () => {
    const { visible, grouped } = groupSmallLeaves([habit("tiny", 0.5)], 100);
    expect(visible).toHaveLength(0);
    expect(grouped.map((h) => h.key)).toEqual(["tiny"]);
  });
  it("keeps everything within the cap when there is no cost basis", () => {
    const { visible, grouped } = groupSmallLeaves([habit("a", 0), habit("b", 0)], 0);
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

describe("buildForceModel tool lens", () => {
  const phases = [
    phase("explore", 0.5, [habit("re-reads", 5)], [tool("Read", 30), tool("Grep", 10)]),
    phase("verify", 0.3, [], [tool("Bash", 30)]),
  ];

  it("hangs tool leaves off phases and omits habit leaves", () => {
    const model = buildForceModel(phases,
      { totalUsd: 100, costAvailable: true, leafMode: "tools" });
    const ids = model.nodes.map((n) => n.id);
    expect(ids).toContain("tool:Read@explore");
    expect(ids).toContain("tool:Grep@explore");
    expect(ids).toContain("tool:Bash@verify");
    expect(ids.some((id) => id.startsWith("habit:"))).toBe(false);
  });

  it("defaults to the habits lens", () => {
    const model = buildForceModel(phases, { totalUsd: 100, costAvailable: true });
    expect(model.nodes.some((n) => n.id === "habit:re-reads@explore")).toBe(true);
    expect(model.nodes.some((n) => n.kind === "tool")).toBe(false);
  });

  it("tool nodes carry exact share and neutral structure links", () => {
    const model = buildForceModel(phases,
      { totalUsd: 100, costAvailable: true, leafMode: "tools" });
    const leaf = model.nodes.find((n) => n.id === "tool:Read@explore")!;
    expect(leaf.kind).toBe("tool");
    expect(leaf.share).toBeCloseTo(0.3);
    expect(leaf.sublabel).toBe("30%");
    expect(leaf.toolKey).toBe("Read");
    expect(leaf.phaseKey).toBe("explore");
    expect(leaf.polarity).toBeUndefined();
    const link = model.links.find((l) => l.targetId === leaf.id)!;
    expect(link.kind).toBe("structure");
    expect(link.sourceId).toBe("phase:explore");
  });

  it("collapses overflow tools into a grouped leaf", () => {
    const many = phase("explore", 0.5, [],
      [1, 2, 3, 4, 5].map((n) => tool(`T${n}`, n * 5)));
    const model = buildForceModel([many],
      { totalUsd: 100, costAvailable: true, leafMode: "tools" });
    const other = model.nodes.find((n) => n.id === "tool:other@explore")!;
    expect(other.label).toBe("+1 more");
    expect(other.grouped?.map((t) => t.key)).toEqual(["T1"]);
  });

  it("falls back to counts when cost is unavailable", () => {
    const model = buildForceModel(phases,
      { totalUsd: 0, costAvailable: false, leafMode: "tools" });
    const leaf = model.nodes.find((n) => n.id === "tool:Read@explore")!;
    expect(leaf.sublabel).toBe("3x");
  });

  it("keeps a zero-share phase visible in the lens that has leaves for it", () => {
    const zeroShare = phase("operate", 0, [], [tool("Bash", 0, 7)]);
    const tools = buildForceModel([zeroShare],
      { totalUsd: 100, costAvailable: true, leafMode: "tools" });
    expect(tools.nodes.some((n) => n.id === "phase:operate")).toBe(true);
    expect(tools.nodes.some((n) => n.id === "tool:Bash@operate")).toBe(false); // 0% < 1% floor -> grouped
    expect(tools.nodes.some((n) => n.id === "tool:other@operate")).toBe(true);
    const habits = buildForceModel([zeroShare],
      { totalUsd: 100, costAvailable: true, leafMode: "habits" });
    expect(habits.nodes.some((n) => n.id === "phase:operate")).toBe(false);
  });
});

describe("deriveOriginPhases", () => {
  const phases: UsagePhase[] = [
    phase("explore", 0.8, [], [], { main_cost_usd: 20, subagent_cost_usd: 60 }),
    phase("implement", 0.2, [], [], { main_cost_usd: 20, subagent_cost_usd: 0 }),
  ];

  it("returns phases unchanged for 'all'", () => {
    const { phases: out, total } = deriveOriginPhases(phases, "all", "cost");
    expect(total).toBe(100);            // cost_usd 80 + 20
    expect(out[0].share).toBe(0.8);
  });

  it("rescales to the subagent subset", () => {
    const { phases: out, total } = deriveOriginPhases(phases, "subagent", "cost");
    expect(total).toBe(60);             // 60 + 0
    expect(out[0].cost_usd).toBe(60);
    expect(out[0].share).toBe(1);       // all subagent cost is in explore
    expect(out[1].share).toBe(0);
    expect(out[0].habits).toEqual([]);  // leaves hidden in split mode
  });

  it("rescales to the main subset", () => {
    const { phases: out, total } = deriveOriginPhases(phases, "main", "cost");
    expect(total).toBe(40);             // 20 + 20
    expect(out[0].share).toBe(0.5);
    expect(out[1].share).toBe(0.5);
  });
});
