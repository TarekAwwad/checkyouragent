import React from "react";
import { ChevronRight, Lightbulb } from "lucide-react";
import type { ContextArchetype } from "../../api/types";
import { formatTokens, formatUsd } from "./ContextEconomics";
import { ARCHETYPE_COLORS } from "./TaxMeterHero";

/**
 * Top of the left column: what the selected archetype means, what to do about
 * it, and how its savings were estimated.
 */
export default function ArchetypeBrief({
  archetype,
  costAvailable,
}: {
  archetype: ContextArchetype;
  costAvailable: boolean;
}) {
  const [showMath, setShowMath] = React.useState(false);
  const color = ARCHETYPE_COLORS[archetype.key] ?? "var(--accent)";

  return (
    <section className="archetype-brief">
      <header className="archetype-brief-head">
        <h3 className="archetype-brief-title">
          <i className="archetype-dot" style={{ background: color }} aria-hidden={true} />
          {archetype.title}
        </h3>
        <strong className="archetype-savings" style={{ color }}>
          {costAvailable ? formatUsd(archetype.savings_usd) : formatTokens(archetype.savings_tokens)}
        </strong>
      </header>
      {archetype.description && (
        <p className="archetype-brief-desc">{archetype.description}</p>
      )}
      {archetype.recommendation && (
        <p className="archetype-reco">
          <Lightbulb size={13} aria-hidden={true} />
          <span>{archetype.recommendation}</span>
        </p>
      )}
      <button
        type="button"
        className={`archetype-math-toggle${showMath ? " is-open" : ""}`}
        aria-expanded={showMath}
        onClick={() => setShowMath((v) => !v)}
      >
        <ChevronRight size={13} aria-hidden={true} />
        How we estimated this
      </button>
      {showMath && (
        <dl className="archetype-math">
          {archetype.thresholds.map((threshold) => (
            <div key={threshold.name}>
              <dt>{threshold.name}</dt>
              <dd>
                {Math.round(threshold.value).toLocaleString("en-US")}
                <span> · {threshold.provenance}</span>
              </dd>
            </div>
          ))}
          {archetype.findings[0] && (
            <div>
              <dt>counterfactual</dt>
              <dd>{archetype.findings[0].counterfactual.model}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
