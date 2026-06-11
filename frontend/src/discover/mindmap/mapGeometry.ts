// Pure layout math for the usage mindmap. No React, no DOM — everything here
// is unit-testable (same philosophy as streamGeometry.ts).
//
// Encoding contract (accuracy first): phase sectors are proportional to share
// with a small floor for label legibility; every node carries its exact share
// in `sublabel`, and the ShareRail shows the precise stacked breakdown.
import type { UsageHabit, UsagePhase } from "../../api/types";

export interface MapNode {
  id: string; // "center" | "phase:<key>" | "habit:<key>@<phase>" | "habit:other@<phase>"
  kind: "center" | "phase" | "habit";
  label: string;
  sublabel: string;
  x: number;
  y: number;
  rx: number;
  ry: number;
  share: number;
  polarity?: "good" | "anti";
  phaseKey?: string;
  habitKey?: string;          // unset on the grouped overflow leaf
  grouped?: UsageHabit[];     // members of an overflow leaf
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  d: string;
  width: number;
  polarity?: "good" | "anti";
}

export interface MapLayout {
  width: number;
  height: number;
  nodes: MapNode[];
  edges: MapEdge[];
}

export const MAP_WIDTH = 960;
export const MAP_HEIGHT = 640;
const CX = MAP_WIDTH / 2;
const CY = MAP_HEIGHT / 2;
const PHASE_RADIUS = 185;
const HABIT_RADIUS = 288;
const MIN_SECTOR_DEG = 28;       // floor so small-phase labels stay legible
const MAX_LEAVES_PER_PHASE = 4;
const MIN_HABIT_SHARE = 0.01;    // of total map cost; below this -> grouped

function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180; // 0 deg at 12 o'clock, clockwise
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

/** Proportional angular sectors with a legibility floor, renormalized to 360. */
export function sectorAngles(shares: number[]): { start: number; end: number }[] {
  if (shares.length === 0) return [];
  const floored = shares.map((s) => Math.max(MIN_SECTOR_DEG, s * 360));
  const total = floored.reduce((a, b) => a + b, 0);
  const sectors: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const value of floored) {
    const span = (value * 360) / total;
    sectors.push({ start: cursor, end: cursor + span });
    cursor += span;
  }
  return sectors;
}

/**
 * Visible leaves vs grouped overflow: top MAX_LEAVES_PER_PHASE by cost, and a
 * habit below MIN_HABIT_SHARE of the map total is always grouped. With no cost
 * basis (token fallback) everything within the cap stays visible.
 */
export function groupSmallHabits(
  habits: UsageHabit[],
  totalUsd: number,
): { visible: UsageHabit[]; grouped: UsageHabit[] } {
  const sorted = [...habits].sort((a, b) => b.cost_usd - a.cost_usd);
  const visible: UsageHabit[] = [];
  const grouped: UsageHabit[] = [];
  for (const habit of sorted) {
    const share = totalUsd > 0 ? habit.cost_usd / totalUsd : 0;
    const tooSmall = totalUsd > 0 && share < MIN_HABIT_SHARE;
    if (visible.length < MAX_LEAVES_PER_PHASE && !tooSmall) visible.push(habit);
    else grouped.push(habit);
  }
  return { visible, grouped };
}

/** Gentle quadratic curve from parent to child for the organic mindmap feel. */
export function branchPath(x0: number, y0: number, x1: number, y1: number): string {
  const mx = (x0 + x1) / 2 + (CX - (x0 + x1) / 2) * 0.12;
  const my = (y0 + y1) / 2 + (CY - (y0 + y1) / 2) * 0.12;
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function buildMapLayout(
  phases: UsagePhase[],
  opts: { totalUsd: number; costAvailable: boolean },
): MapLayout {
  const active = phases.filter((p) => p.share > 0 || p.habits.length > 0);
  const nodes: MapNode[] = [{
    id: "center", kind: "center", label: "My usage",
    sublabel: opts.costAvailable ? `$${opts.totalUsd.toFixed(opts.totalUsd >= 100 ? 0 : 2)}` : "",
    x: CX, y: CY, rx: 66, ry: 34, share: 1,
  }];
  const edges: MapEdge[] = [];
  const sectors = sectorAngles(active.map((p) => p.share));

  active.forEach((phase, index) => {
    const sector = sectors[index];
    const mid = (sector.start + sector.end) / 2;
    const pos = polar(mid, PHASE_RADIUS);
    const rx = 36 + 42 * Math.sqrt(phase.share);
    const phaseNode: MapNode = {
      id: `phase:${phase.key}`, kind: "phase", label: phase.label,
      sublabel: pct(phase.share), x: pos.x, y: pos.y, rx, ry: rx * 0.48,
      share: phase.share, phaseKey: phase.key,
    };
    nodes.push(phaseNode);
    edges.push({
      id: `edge-${phase.key}`, from: "center", to: phaseNode.id,
      d: branchPath(CX, CY, pos.x, pos.y),
      width: Math.max(2, 24 * phase.share),
    });

    const { visible, grouped } = groupSmallHabits(phase.habits, opts.totalUsd);
    const leaves: (UsageHabit | null)[] = grouped.length > 0 ? [...visible, null] : visible;
    if (leaves.length === 0) return;
    const pad = (sector.end - sector.start) * 0.18;
    leaves.forEach((leaf, j) => {
      const t = leaves.length === 1 ? 0.5 : j / (leaves.length - 1);
      const angle = sector.start + pad + t * (sector.end - sector.start - 2 * pad);
      const lp = polar(angle, HABIT_RADIUS);
      const share = leaf && opts.totalUsd > 0 ? leaf.cost_usd / opts.totalUsd : 0;
      const r = 11 + 28 * Math.sqrt(share);
      const node: MapNode = leaf
        ? {
            id: `habit:${leaf.key}@${phase.key}`, kind: "habit",
            label: leaf.label, sublabel: opts.costAvailable ? pct(share) : `${leaf.count}x`,
            x: lp.x, y: lp.y, rx: r, ry: r, share,
            polarity: leaf.polarity, phaseKey: phase.key, habitKey: leaf.key,
          }
        : {
            id: `habit:other@${phase.key}`, kind: "habit",
            label: `+${grouped.length} more`, sublabel: "",
            x: lp.x, y: lp.y, rx: 11, ry: 11, share: 0,
            phaseKey: phase.key, grouped,
          };
      nodes.push(node);
      edges.push({
        id: `edge-${node.id}`, from: phaseNode.id, to: node.id,
        d: branchPath(pos.x, pos.y, lp.x, lp.y),
        width: Math.max(1.5, 16 * share),
        polarity: leaf?.polarity,
      });
    });
  });

  return { width: MAP_WIDTH, height: MAP_HEIGHT, nodes, edges };
}
