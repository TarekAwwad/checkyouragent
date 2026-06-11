import React from "react";
import { ExternalLink } from "lucide-react";
import type { ContextArchetype, ContextFinding } from "../../api/types";
import { formatTokens, formatUsd } from "./ContextEconomics";
import { ARCHETYPE_COLORS } from "./TaxMeterHero";

function MiniStream({ archetype }: { archetype: ContextArchetype }) {
  const series = archetype.exemplar?.series ?? [];
  if (series.length < 2) return null;
  const width = 180;
  const height = 56;
  const maxContext = Math.max(...series.map((point) => point.context_tokens), 1);
  const x = (index: number) => (index / (series.length - 1)) * width;
  const y = (tokens: number) => height - (tokens / maxContext) * height;
  const contextLine = series.map((p, i) => `${x(i).toFixed(1)},${y(p.context_tokens).toFixed(1)}`);
  const highlightTop = series.map((p, i) => `${x(i).toFixed(1)},${y(p.highlight_tokens).toFixed(1)}`);
  const floor = series.map((_, i) => `${x(series.length - 1 - i).toFixed(1)},${height}`);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="archetype-thumb"
      aria-label="Exemplar session context growth"
    >
      <path d={`M${contextLine.join(" L")} L${floor.join(" L")} Z`} className="thumb-context" />
      <path
        d={`M${highlightTop.join(" L")} L${floor.join(" L")} Z`}
        style={{ fill: ARCHETYPE_COLORS[archetype.key] }}
        opacity={0.85}
      />
    </svg>
  );
}

export default function ArchetypeCard({
  archetype,
  minSupport,
  costAvailable,
  onOpenSession,
  onInspectFinding,
}: {
  archetype: ContextArchetype;
  minSupport: number;
  costAvailable: boolean;
  onOpenSession: (sessionId: number) => void;
  onInspectFinding: (finding: ContextFinding) => void;
}) {
  const [showMath, setShowMath] = React.useState(false);

  if (!archetype.meets_support) {
    return (
      <article className="archetype-card is-gated" style={{ borderColor: ARCHETYPE_COLORS[archetype.key] }}>
        <h3>{archetype.title}</h3>
        <p className="discover-muted">
          Needs more evidence ({archetype.findings_count} finding{archetype.findings_count === 1 ? "" : "s"}, min {minSupport}).
        </p>
      </article>
    );
  }

  return (
    <article className="archetype-card" style={{ borderColor: ARCHETYPE_COLORS[archetype.key] }}>
      <header>
        <h3>{archetype.title}</h3>
        <strong>
          {costAvailable ? formatUsd(archetype.savings_usd) : formatTokens(archetype.savings_tokens)}
        </strong>
      </header>
      <MiniStream archetype={archetype} />
      <p>{archetype.description}</p>
      <p className="archetype-recommendation">{archetype.recommendation}</p>
      <ul className="archetype-findings">
        {archetype.findings.slice(0, 3).map((finding) => (
          <li key={`${finding.session_id}-${finding.entry_turn}-${finding.label}`}>
            <div>
              <strong>{finding.label}</strong>
              <span className="discover-muted">
                {finding.session_title ?? "Untitled"} · turn {finding.entry_turn} · carried {finding.carried_turns} turns
                · saves {costAvailable ? formatUsd(finding.savings_usd) : formatTokens(finding.savings_tokens)}
              </span>
            </div>
            <div className="archetype-finding-actions">
              <button type="button" onClick={() => onInspectFinding(finding)}>Inspect</button>
              <button type="button" onClick={() => onOpenSession(finding.session_id)}>
                <ExternalLink size={13} aria-hidden={true} /> Open session
              </button>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="archetype-math-toggle" onClick={() => setShowMath((v) => !v)}>
        How we estimated this
      </button>
      {showMath && (
        <div className="archetype-math">
          {archetype.thresholds.map((threshold) => (
            <code key={threshold.name}>
              {threshold.name} = {Math.round(threshold.value).toLocaleString("en-US")} ({threshold.provenance})
            </code>
          ))}
          {archetype.findings[0] && <code>counterfactual: {archetype.findings[0].counterfactual.model}</code>}
        </div>
      )}
    </article>
  );
}
