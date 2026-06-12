import React from "react";
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation,
} from "d3-force";
import type { UsagePhase } from "../../api/types";
import { useChartTooltip } from "../context/chartTooltip";
import { formatTokens, formatUsd } from "../formatting";
import { buildForceModel, type LeafMode, type MapLink, type MapNode } from "./forceModel";

interface Props {
  phases: UsagePhase[];
  totalUsd: number;
  costAvailable: boolean;
  selectedNodeId: string | null;
  onSelectNode: (node: MapNode) => void;
  /** Optional: previous-period share per phase key, for compare delta chips. */
  previousShares?: Record<string, number>;
  /** Which leaf layer hangs off the phases. Defaults to the habits lens. */
  leafMode?: LeafMode;
}

const DEFAULT_SIZE = { width: 960, height: 560 };
const DRAG_CLICK_TOLERANCE_PX = 4;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 4;

function deltaChip(node: MapNode, previousShares?: Record<string, number>): string | null {
  if (!previousShares || node.kind !== "phase" || !node.phaseKey) return null;
  const before = previousShares[node.phaseKey];
  if (before === undefined) return null;
  const pp = Math.round((node.share - before) * 100);
  if (pp === 0) return "=";
  return pp > 0 ? `▲${pp}pp` : `▼${-pp}pp`;
}

/** Gentle quadratic pull toward the pinned center at the origin. */
function edgePath(s: MapNode, t: MapNode): string {
  const mx = ((s.x + t.x) / 2) * 0.88;
  const my = ((s.y + t.y) / 2) * 0.88;
  return `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${t.x.toFixed(1)} ${t.y.toFixed(1)}`;
}

export default function MindmapCanvas({
  phases, totalUsd, costAvailable, selectedNodeId, onSelectNode, previousShares,
  leafMode = "habits",
}: Props) {
  const model = React.useMemo(
    () => buildForceModel(phases, { totalUsd, costAvailable, leafMode }),
    [phases, totalUsd, costAvailable, leafMode],
  );
  const byId = React.useMemo(
    () => new Map(model.nodes.map((n) => [n.id, n])), [model]);
  const phaseByKey = React.useMemo(
    () => new Map(phases.map((p) => [p.key, p])), [phases]);
  const neighbors = React.useMemo(() => {
    const map = new Map<string, Set<string>>(
      model.nodes.map((n) => [n.id, new Set([n.id])]));
    for (const link of model.links) {
      map.get(link.sourceId)?.add(link.targetId);
      map.get(link.targetId)?.add(link.sourceId);
    }
    return map;
  }, [model]);

  const { ref: hostRef, show, hide, tooltip } = useChartTooltip<HTMLDivElement>();
  const svgRef = React.useRef<SVGSVGElement>(null);
  const viewRef = React.useRef<SVGGElement>(null);
  const nodeRefs = React.useRef(new Map<string, SVGGElement>());
  const linkRefs = React.useRef(new Map<string, SVGPathElement>());
  const simRef = React.useRef<Simulation<MapNode, MapLink> | null>(null);
  const [size, setSize] = React.useState(DEFAULT_SIZE);
  const sizeRef = React.useRef(DEFAULT_SIZE);
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);

  const applyPositions = React.useCallback(() => {
    for (const node of model.nodes) {
      nodeRefs.current.get(node.id)
        ?.setAttribute("transform", `translate(${node.x},${node.y})`);
    }
    for (const link of model.links) {
      const s = byId.get(link.sourceId);
      const t = byId.get(link.targetId);
      if (s && t) linkRefs.current.get(link.id)?.setAttribute("d", edgePath(s, t));
    }
  }, [model, byId]);

  React.useEffect(() => {
    const simulation = forceSimulation<MapNode>(model.nodes)
      .force("link", forceLink<MapNode, MapLink>(model.links)
        .id((n) => n.id).distance((l) => l.distance).strength(0.8))
      .force("charge", forceManyBody<MapNode>().strength(-220))
      .force("collide", forceCollide<MapNode>(
        (n) => n.r + (n.labelTier === "inside" ? 8 : 22)))
      .force("x", forceX(0).strength(0.03))
      .force("y", forceY(0).strength(0.03))
      .on("tick", applyPositions);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      simulation.stop();
      simulation.tick(300);
      applyPositions();
    }
    simRef.current = simulation;
    return () => { simulation.stop(); simRef.current = null; };
  }, [model, applyPositions]);

  // Keep the simulation space centered at any stage size (jsdom has no
  // ResizeObserver; tests render at DEFAULT_SIZE).
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0) {
        sizeRef.current = { width: rect.width, height: rect.height };
        setSize({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hostRef]);

  // --- pan / zoom (imperative on the view group; no re-render per frame) ----
  const viewState = React.useRef({ k: 1, x: 0, y: 0 });
  const applyView = React.useCallback(() => {
    const { k, x, y } = viewState.current;
    viewRef.current?.setAttribute("transform", `translate(${x} ${y}) scale(${k})`);
  }, []);
  const zoomBy = React.useCallback((factor: number) => {
    viewState.current.k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewState.current.k * factor));
    applyView();
  }, [applyView]);
  const resetView = React.useCallback(() => {
    viewState.current = { k: 1, x: 0, y: 0 };
    applyView();
  }, [applyView]);

  React.useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // React's onWheel is passive; preventDefault needs a manual listener.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const state = viewState.current;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.k * factor));
      const applied = next / state.k;
      if (applied === 1) return;
      const rect = svg.getBoundingClientRect();
      // Cursor position in the centered viewBox coordinate space.
      const px = (e.clientX - rect.left) * (sizeRef.current.width / rect.width)
        - sizeRef.current.width / 2;
      const py = (e.clientY - rect.top) * (sizeRef.current.height / rect.height)
        - sizeRef.current.height / 2;
      state.x = px - (px - state.x) * applied;
      state.y = py - (py - state.y) * applied;
      state.k = next;
      applyView();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [applyView]);

  // --- drag (nodes) and pan (background) ------------------------------------
  const dragRef = React.useRef<{ node: MapNode; startX: number; startY: number } | null>(null);
  const panRef = React.useRef<{ x: number; y: number } | null>(null);
  const movedRef = React.useRef(false);

  const toWorld = (e: React.PointerEvent): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    const { width, height } = sizeRef.current;
    const px = (e.clientX - rect.left) * (width / rect.width) - width / 2;
    const py = (e.clientY - rect.top) * (height / rect.height) - height / 2;
    const { k, x, y } = viewState.current;
    return { x: (px - x) / k, y: (py - y) / k };
  };

  const onNodePointerDown = (node: MapNode) => (e: React.PointerEvent<SVGGElement>) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { node, startX: e.clientX, startY: e.clientY };
    movedRef.current = false;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    panRef.current = { x: e.clientX, y: e.clientY };
    svgRef.current?.classList.add("is-panning");
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (drag) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY)
          > DRAG_CLICK_TOLERANCE_PX) {
        movedRef.current = true;
      }
      if (movedRef.current && drag.node.id !== "center") {
        const w = toWorld(e);
        drag.node.fx = w.x;
        drag.node.fy = w.y;
        simRef.current?.alphaTarget(0.25).restart();
      }
      return;
    }
    if (panRef.current) {
      viewState.current.x += e.clientX - panRef.current.x;
      viewState.current.y += e.clientY - panRef.current.y;
      panRef.current = { x: e.clientX, y: e.clientY };
      applyView();
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    if (drag && drag.node.id !== "center") {
      drag.node.fx = null;
      drag.node.fy = null;
    }
    dragRef.current = null;
    panRef.current = null;
    simRef.current?.alphaTarget(0);
    svgRef.current?.classList.remove("is-panning");
  };

  // --- tooltip content -------------------------------------------------------
  const tipLines = (node: MapNode): string[] => {
    if (node.kind === "phase" && node.phaseKey) {
      const phase = phaseByKey.get(node.phaseKey);
      if (!phase) return [];
      return [
        `${Math.round(phase.share * 1000) / 10}% of spend`,
        costAvailable ? formatUsd(phase.cost_usd) : formatTokens(phase.tokens),
        `${phase.tool_count} tool calls in ${phase.session_count} sessions`,
      ];
    }
    if (node.kind === "habit" && node.grouped) {
      return node.grouped.map((h) =>
        `${h.label}: ${costAvailable ? formatUsd(h.cost_usd) : `${h.count}x`}`);
    }
    if (node.kind === "habit") {
      return [node.polarity === "good" ? "Good habit" : "Anti-pattern",
              node.sublabel
                ? (costAvailable ? `${node.sublabel} of spend` : node.sublabel)
                : ""].filter(Boolean);
    }
    if (node.kind === "tool" && node.grouped) {
      return node.grouped.map((t) =>
        `${t.label}: ${costAvailable ? formatUsd(t.cost_usd) : `${t.count}x`}`);
    }
    if (node.kind === "tool") {
      const tool = node.phaseKey && node.toolKey
        ? phaseByKey.get(node.phaseKey)?.tools.find((t) => t.key === node.toolKey)
        : undefined;
      return [
        node.sublabel
          ? (costAvailable ? `${node.sublabel} of spend` : node.sublabel)
          : "",
        tool ? `${tool.count} calls in ${tool.session_count} sessions` : "",
      ].filter(Boolean);
    }
    return [costAvailable ? formatUsd(totalUsd) : ""].filter(Boolean);
  };

  const focusSet = hoveredId ? neighbors.get(hoveredId) : null;

  return (
    <div className="mindmap-canvas chart-tooltip-host" ref={hostRef}>
      <div className="mindmap-legend" aria-hidden="true">
        <span><i className="is-phase" /> phase</span>
        {leafMode === "habits" ? (
          <>
            <span><i className="is-good" /> good habit</span>
            <span><i className="is-anti" /> anti-pattern</span>
          </>
        ) : (
          <span><i className="is-tool" /> tool</span>
        )}
      </div>
      <svg ref={svgRef} role="img" aria-label="Usage map"
           viewBox={`${-size.width / 2} ${-size.height / 2} ${size.width} ${size.height}`}
           onPointerDown={onPointerDown} onPointerMove={onPointerMove}
           onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
        <g ref={viewRef}>
          <g>
            {model.links.map((link) => {
              const s = byId.get(link.sourceId)!;
              const t = byId.get(link.targetId)!;
              const dimmed = focusSet
                && !(focusSet.has(link.sourceId) && focusSet.has(link.targetId));
              return (
                <path key={link.id}
                      ref={(el) => {
                        if (el) linkRefs.current.set(link.id, el);
                        else linkRefs.current.delete(link.id);
                      }}
                      className={["mindmap-edge", `is-${link.kind}`,
                                  dimmed ? "is-dimmed" : ""].filter(Boolean).join(" ")}
                      strokeWidth={link.width} d={edgePath(s, t)} />
              );
            })}
          </g>
          <g>
            {model.nodes.map((node) => {
              const chip = deltaChip(node, previousShares);
              const dimmed = focusSet && !focusSet.has(node.id);
              return (
                <g key={node.id}
                   ref={(el) => {
                     if (el) nodeRefs.current.set(node.id, el);
                     else nodeRefs.current.delete(node.id);
                   }}
                   role="button" tabIndex={0}
                   aria-label={`${node.label}${node.sublabel ? `: ${node.sublabel}` : ""}`}
                   className={["mindmap-node", `is-${node.kind}`,
                     node.polarity ? `is-${node.polarity}` : "",
                     selectedNodeId === node.id ? "is-selected" : "",
                     dimmed ? "is-dimmed" : ""].filter(Boolean).join(" ")}
                   transform={`translate(${node.x},${node.y})`}
                   onPointerDown={onNodePointerDown(node)}
                   onClick={() => { if (!movedRef.current) onSelectNode(node); }}
                   onKeyDown={(e) => { if (e.key === "Enter") onSelectNode(node); }}
                   onPointerEnter={() => setHoveredId(node.id)}
                   onMouseMove={(e) => show(e, node.label, tipLines(node))}
                   onPointerLeave={() => { setHoveredId(null); hide(); }}>
                  <circle className="mindmap-ring" r={node.r + 4} />
                  <circle className="mindmap-body" r={node.r} />
                  {node.labelTier === "inside" && (
                    <>
                      <text className="mindmap-node-label" textAnchor="middle" dy={-2}>
                        {node.label}
                      </text>
                      <text className="mindmap-node-share" textAnchor="middle" dy={13}>
                        {node.sublabel}
                      </text>
                    </>
                  )}
                  {node.labelTier === "split" && (
                    <>
                      <text className="mindmap-node-share" textAnchor="middle" dy={4}>
                        {node.sublabel}
                      </text>
                      <text className="mindmap-node-label" textAnchor="middle"
                            dy={node.r + 14}>
                        {node.label}
                      </text>
                    </>
                  )}
                  {node.labelTier === "below" && (
                    <>
                      <text className="mindmap-node-label" textAnchor="middle"
                            dy={node.r + 13}>
                        {node.label}
                      </text>
                      <text className="mindmap-node-share" textAnchor="middle"
                            dy={node.r + 25}>
                        {node.sublabel}
                      </text>
                    </>
                  )}
                  {chip && (
                    <text className="mindmap-delta" textAnchor="middle"
                          dy={node.labelTier === "inside" ? 27 : node.r + 27}>
                      {chip}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>
      <div className="mindmap-zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>+</button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(0.83)}>−</button>
        <button type="button" aria-label="Reset view" onClick={resetView}>⤢</button>
      </div>
      {tooltip}
    </div>
  );
}
