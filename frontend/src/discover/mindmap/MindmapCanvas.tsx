import React from "react";
import type { UsagePhase } from "../../api/types";
import { useChartTooltip } from "../context/chartTooltip";
import { formatTokens, formatUsd } from "../context/ContextEconomics";
import { buildMapLayout, type MapNode } from "./mapGeometry";

interface Props {
  phases: UsagePhase[];
  totalUsd: number;
  costAvailable: boolean;
  selectedNodeId: string | null;
  onSelectNode: (node: MapNode) => void;
  /** Optional: previous-period share per phase key, for compare delta chips. */
  previousShares?: Record<string, number>;
}

function deltaChip(node: MapNode, previousShares?: Record<string, number>): string | null {
  if (!previousShares || node.kind !== "phase" || !node.phaseKey) return null;
  const before = previousShares[node.phaseKey];
  if (before === undefined) return null;
  const pp = Math.round((node.share - before) * 100);
  if (pp === 0) return "=";
  return pp > 0 ? `▲${pp}pp` : `▼${-pp}pp`;
}

export default function MindmapCanvas({
  phases, totalUsd, costAvailable, selectedNodeId, onSelectNode, previousShares,
}: Props) {
  const layout = React.useMemo(
    () => buildMapLayout(phases, { totalUsd, costAvailable }),
    [phases, totalUsd, costAvailable],
  );
  const { ref, show, hide, tooltip } = useChartTooltip<HTMLDivElement>();
  const phaseByKey = React.useMemo(
    () => new Map(phases.map((p) => [p.key, p])), [phases]);

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
      return node.grouped.map((h) => `${h.label}: ${formatUsd(h.cost_usd)}`);
    }
    if (node.kind === "habit") {
      return [node.polarity === "good" ? "Good habit" : "Anti-pattern",
              node.sublabel ? `${node.sublabel} of spend` : ""].filter(Boolean);
    }
    return [costAvailable ? formatUsd(totalUsd) : ""].filter(Boolean);
  };

  return (
    <div className="mindmap-canvas chart-tooltip-host" ref={ref}>
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img"
           aria-label="Usage mindmap">
        {layout.edges.map((edge) => (
          <path key={edge.id} d={edge.d} className={
            `mindmap-edge${edge.polarity ? ` is-${edge.polarity}` : ""}`}
            strokeWidth={edge.width} fill="none" />
        ))}
        {layout.nodes.map((node) => (
          <g key={node.id} role="button" tabIndex={0}
             aria-label={`${node.label}${node.sublabel ? `: ${node.sublabel}` : ""}`}
             className={[
               "mindmap-node", `is-${node.kind}`,
               node.polarity ? `is-${node.polarity}` : "",
               selectedNodeId === node.id ? "is-selected" : "",
             ].filter(Boolean).join(" ")}
             onClick={() => onSelectNode(node)}
             onKeyDown={(e) => { if (e.key === "Enter") onSelectNode(node); }}
             onMouseMove={(e) => show(e, node.label, tipLines(node))}
             onMouseLeave={hide}>
            <ellipse cx={node.x} cy={node.y} rx={node.rx} ry={node.ry} />
            <text x={node.x} y={node.kind === "habit" ? node.y - node.ry - 6 : node.y - 2}
                  textAnchor="middle" className="mindmap-label">{node.label}</text>
            <text x={node.x} y={node.kind === "habit" ? node.y + 4 : node.y + 13}
                  textAnchor="middle" className="mindmap-sublabel">
              {node.sublabel}
            </text>
            {deltaChip(node, previousShares) && (
              <text x={node.x} y={node.y + 26} textAnchor="middle"
                    className="mindmap-delta">{deltaChip(node, previousShares)}</text>
            )}
          </g>
        ))}
      </svg>
      {tooltip}
    </div>
  );
}
