// Pure graph model for the force-directed usage map. No React, no DOM, no
// physics — everything here is unit-testable (replaces mapGeometry.ts).
//
// Encoding contract (accuracy first): node radius and link width/distance are
// monotonic in share, and every node carries its exact share in `sublabel`,
// with exact values repeated in the tooltip and evidence card.
import type { UsageHabit, UsagePhase, UsageTool } from "../../api/types";

export type LabelTier = "inside" | "split" | "below";
export type LeafMode = "habits" | "tools";

/** Minimal shape an overflow leaf needs to list its members. Both UsageHabit
    and UsageTool satisfy it structurally. */
export interface GroupedLeaf {
  key: string;
  label: string;
  cost_usd: number;
  count: number;
}

export interface MapNode {
  id: string; // "center" | "phase:<key>" | "habit:<key>@<phase>" | "habit:other@<phase>"
              // | "tool:<name>@<phase>" | "tool:other@<phase>"
  kind: "center" | "phase" | "habit" | "tool";
  label: string;
  sublabel: string;
  r: number;
  share: number;
  labelTier: LabelTier;
  polarity?: "good" | "anti";
  phaseKey?: string;
  habitKey?: string;          // unset on the grouped overflow leaf
  toolKey?: string;           // tool-lens leaves only
  grouped?: GroupedLeaf[];    // members of an overflow leaf
  // d3-force reads and mutates these in place at runtime. Seeded here so the
  // first paint is deterministic.
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface MapLink {
  id: string;
  // d3's forceLink().id() resolves these string endpoints into node objects in
  // place; keep the *Id fields for stable access from rendering code.
  source: string | MapNode;
  target: string | MapNode;
  sourceId: string;
  targetId: string;
  distance: number;
  width: number;
  kind: "structure" | "good" | "anti";
}

export interface ForceModel {
  nodes: MapNode[];
  links: MapLink[];
}

const MAX_LEAVES_PER_PHASE = 4;
const MIN_HABIT_SHARE = 0.01; // of total map cost; below this -> grouped
const PHASE_SEED_RADIUS = 170;
const HABIT_SEED_RADIUS = 250;

export function phaseRadius(share: number): number {
  return 18 + 34 * Math.sqrt(share);
}

export function habitRadius(share: number): number {
  return 10 + 20 * Math.sqrt(share);
}

export function labelTier(r: number): LabelTier {
  if (r >= 30) return "inside";
  if (r >= 22) return "split";
  return "below";
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * Visible leaves vs grouped overflow: top MAX_LEAVES_PER_PHASE by cost, and a
 * leaf below MIN_HABIT_SHARE of the map total is always grouped. With no cost
 * basis (token fallback) everything within the cap stays visible.
 */
export function groupSmallLeaves<T extends { cost_usd: number }>(
  leaves: T[],
  totalUsd: number,
): { visible: T[]; grouped: T[] } {
  const sorted = [...leaves].sort((a, b) => b.cost_usd - a.cost_usd);
  const visible: T[] = [];
  const grouped: T[] = [];
  for (const leaf of sorted) {
    const share = totalUsd > 0 ? leaf.cost_usd / totalUsd : 0;
    const tooSmall = totalUsd > 0 && share < MIN_HABIT_SHARE;
    if (visible.length < MAX_LEAVES_PER_PHASE && !tooSmall) visible.push(leaf);
    else grouped.push(leaf);
  }
  return { visible, grouped };
}

/** Phase node shape shared by the model builder and the page's fallback selection. */
export function phaseNode(phase: UsagePhase): MapNode {
  const r = phaseRadius(phase.share);
  return {
    id: `phase:${phase.key}`, kind: "phase", label: phase.label,
    sublabel: pct(phase.share), r, share: phase.share, labelTier: labelTier(r),
    phaseKey: phase.key, x: 0, y: 0,
  };
}

export function buildForceModel(
  phases: UsagePhase[],
  opts: { totalUsd: number; costAvailable: boolean; leafMode?: LeafMode },
): ForceModel {
  const leafMode = opts.leafMode ?? "habits";
  const active = phases.filter((p) => p.share > 0 || p.habits.length > 0);
  const nodes: MapNode[] = [{
    id: "center", kind: "center", label: "My usage",
    sublabel: opts.costAvailable
      ? `$${opts.totalUsd.toFixed(opts.totalUsd >= 100 ? 0 : 2)}` : "",
    r: 44, share: 1, labelTier: "inside", x: 0, y: 0, fx: 0, fy: 0,
  }];
  const links: MapLink[] = [];

  active.forEach((phase, i) => {
    // Deterministic seed on a circle so the first paint is stable.
    const angle = (i / active.length) * 2 * Math.PI - Math.PI / 2;
    const node = phaseNode(phase);
    node.x = Math.cos(angle) * PHASE_SEED_RADIUS;
    node.y = Math.sin(angle) * PHASE_SEED_RADIUS;
    nodes.push(node);
    links.push({
      id: `link:${node.id}`, source: "center", target: node.id,
      sourceId: "center", targetId: node.id,
      distance: 120 + 90 * phase.share,
      width: Math.max(1.5, 14 * phase.share), kind: "structure",
    });

    const pushLeaf = (leafNode: MapNode, linkKind: MapLink["kind"]) => {
      nodes.push(leafNode);
      links.push({
        id: `link:${leafNode.id}`, source: node.id, target: leafNode.id,
        sourceId: node.id, targetId: leafNode.id,
        distance: 80, width: Math.max(1.2, 10 * leafNode.share),
        kind: linkKind,
      });
    };
    const seed = (j: number, count: number): { x: number; y: number } => {
      const spread = angle + (j - (count - 1) / 2) * 0.5;
      return { x: Math.cos(spread) * HABIT_SEED_RADIUS,
               y: Math.sin(spread) * HABIT_SEED_RADIUS };
    };

    if (leafMode === "habits") {
      const { visible, grouped } = groupSmallLeaves(phase.habits, opts.totalUsd);
      const leaves: (UsageHabit | null)[] =
        grouped.length > 0 ? [...visible, null] : visible;
      leaves.forEach((leaf, j) => {
        const share = leaf && opts.totalUsd > 0 ? leaf.cost_usd / opts.totalUsd : 0;
        const r = leaf ? habitRadius(share) : 10;
        const habitNode: MapNode = leaf
          ? {
              id: `habit:${leaf.key}@${phase.key}`, kind: "habit", label: leaf.label,
              sublabel: opts.costAvailable ? pct(share) : `${leaf.count}x`,
              r, share, labelTier: labelTier(r), polarity: leaf.polarity,
              phaseKey: phase.key, habitKey: leaf.key,
              ...seed(j, leaves.length),
            }
          : {
              id: `habit:other@${phase.key}`, kind: "habit",
              label: `+${grouped.length} more`, sublabel: "",
              r, share: 0, labelTier: labelTier(r), phaseKey: phase.key, grouped,
              ...seed(j, leaves.length),
            };
        pushLeaf(habitNode, leaf?.polarity ?? "structure");
      });
    } else {
      const { visible, grouped } = groupSmallLeaves(phase.tools, opts.totalUsd);
      const leaves: (UsageTool | null)[] =
        grouped.length > 0 ? [...visible, null] : visible;
      leaves.forEach((leaf, j) => {
        const share = leaf && opts.totalUsd > 0 ? leaf.cost_usd / opts.totalUsd : 0;
        const r = leaf ? habitRadius(share) : 10;
        const toolNode: MapNode = leaf
          ? {
              id: `tool:${leaf.key}@${phase.key}`, kind: "tool", label: leaf.label,
              sublabel: opts.costAvailable ? pct(share) : `${leaf.count}x`,
              r, share, labelTier: labelTier(r),
              phaseKey: phase.key, toolKey: leaf.key,
              ...seed(j, leaves.length),
            }
          : {
              id: `tool:other@${phase.key}`, kind: "tool",
              label: `+${grouped.length} more`, sublabel: "",
              r, share: 0, labelTier: labelTier(r), phaseKey: phase.key, grouped,
              ...seed(j, leaves.length),
            };
        pushLeaf(toolNode, "structure");
      });
    }
  });

  return { nodes, links };
}
