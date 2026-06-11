import React from "react";
import type { ContextArchetype, ContextEconomicsMeta } from "../../api/types";
import { formatUsd } from "./ContextEconomics";

export const ARCHETYPE_COLORS: Record<string, string> = {
  rereads: "var(--info)",
  oversized: "var(--warning)",
  late_compaction: "var(--success)",
  stale_continuation: "var(--subagent)",
};

export default function TaxMeterHero({
  meta,
  archetypes,
}: {
  meta: ContextEconomicsMeta;
  archetypes: ContextArchetype[];
}) {
  const total = Math.max(meta.total_usd, 1e-9);
  const supported = archetypes.filter((a) => a.meets_support && a.savings_usd > 0);
  const pct = meta.total_usd > 0 ? Math.round((meta.avoidable_usd / meta.total_usd) * 100) : 0;

  return (
    <section className="tax-meter-hero">
      <h2>
        {meta.cost_available
          ? <>{formatUsd(meta.total_usd)} total · est. {formatUsd(meta.avoidable_usd)} avoidable ({pct}%)</>
          : <>Cost unavailable — token-only view</>}
      </h2>
      <div
        className="tax-meter-bar"
        role="img"
        aria-label={`Avoidable spend breakdown: ${formatUsd(meta.avoidable_usd)} of ${formatUsd(meta.total_usd)}`}
      >
        <i
          className="tax-meter-necessary"
          style={{ width: `${(meta.necessary_usd / total) * 100}%` }}
          title={`Necessary ${formatUsd(meta.necessary_usd)}`}
        />
        {supported.map((archetype) => (
          <i
            key={archetype.key}
            style={{
              width: `${(archetype.savings_usd / total) * 100}%`,
              background: ARCHETYPE_COLORS[archetype.key],
            }}
            title={`${archetype.title} ${formatUsd(archetype.savings_usd)}`}
          />
        ))}
      </div>
      <p className="discover-muted">
        {meta.sessions_analyzed} sessions analyzed
        {meta.sessions_skipped > 0 && ` · ${meta.sessions_skipped} skipped (no usage data)`}
        {meta.unattributed_tokens > 0 && " · unattributed growth excluded from savings"}
      </p>
    </section>
  );
}
