import React from "react";
import type { ContextArchetype, ContextEconomicsMeta, ContextTrendBucket } from "../../api/types";
import { formatTokens, formatUsd } from "./ContextEconomics";

export const ARCHETYPE_COLORS: Record<string, string> = {
  rereads: "var(--info)",
  oversized: "var(--warning)",
  late_compaction: "var(--success)",
  stale_continuation: "var(--subagent)",
};

function TrendSparkline({ trend }: { trend: ContextTrendBucket[] }) {
  if (trend.length < 2) return null;
  const width = 160;
  const height = 40;
  const max = Math.max(...trend.map((t) => t.total_usd), 1e-9);
  const barWidth = width / trend.length;
  return (
    <div className="tax-meter-trend">
      <span>Weekly · avoidable share</span>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Weekly avoidable spend trend">
        {trend.map((bucket, i) => {
          const totalH = (bucket.total_usd / max) * height;
          const avoidableH = (bucket.avoidable_usd / max) * height;
          return (
            <g key={bucket.week_start}>
              <rect
                x={i * barWidth + 1}
                width={Math.max(1, barWidth - 2)}
                y={height - totalH}
                height={totalH}
                className="trend-total"
              />
              <rect
                x={i * barWidth + 1}
                width={Math.max(1, barWidth - 2)}
                y={height - avoidableH}
                height={avoidableH}
                className="trend-avoidable"
              >
                <title>
                  week of {bucket.week_start}: {formatUsd(bucket.avoidable_usd)} avoidable of {formatUsd(bucket.total_usd)}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function TaxMeterHero({
  meta,
  archetypes,
  selectedKey,
  onSelectArchetype,
}: {
  meta: ContextEconomicsMeta;
  archetypes: ContextArchetype[];
  selectedKey?: string | null;
  onSelectArchetype?: (key: string) => void;
}) {
  const total = Math.max(meta.total_usd, 1e-9);
  const supported = archetypes.filter((a) =>
    a.meets_support && (meta.cost_available ? a.savings_usd > 0 : a.savings_tokens > 0));
  const pct = meta.total_usd > 0 ? Math.round((meta.avoidable_usd / meta.total_usd) * 100) : 0;
  const supportedSum = supported.reduce((acc, a) => acc + a.savings_usd, 0);
  const segmentScale = supportedSum > 0 ? meta.avoidable_usd / supportedSum : 0;
  const avoidableTokens = supported.reduce((acc, a) => acc + a.savings_tokens, 0);

  return (
    <section className="tax-meter-hero">
      {meta.cost_available ? (
        <>
          <div className="tax-meter-stats">
            <div className="tax-meter-stat is-avoidable">
              <span>Avoidable</span>
              <strong>
                {formatUsd(meta.avoidable_usd)}{" "}
                <em>({pct}%)</em>
              </strong>
            </div>
            <div className="tax-meter-stat">
              <span>Total spend</span>
              <strong>{formatUsd(meta.total_usd)}</strong>
            </div>
            <div className="tax-meter-stat">
              <span>Necessary</span>
              <strong>{formatUsd(meta.necessary_usd)}</strong>
            </div>
            <TrendSparkline trend={meta.trend ?? []} />
          </div>
          <div
            className="tax-meter-bar"
            role="group"
            aria-label={`Avoidable spend breakdown: ${formatUsd(meta.avoidable_usd)} of ${formatUsd(meta.total_usd)}`}
          >
            <i
              className="tax-meter-necessary"
              style={{ width: `${(meta.necessary_usd / total) * 100}%` }}
              title={`Necessary ${formatUsd(meta.necessary_usd)}`}
            />
            {supported.map((archetype) => (
              <button
                key={archetype.key}
                type="button"
                className="tax-meter-segment"
                style={{
                  width: `${(archetype.savings_usd * segmentScale / total) * 100}%`,
                  background: ARCHETYPE_COLORS[archetype.key],
                }}
                title={`${archetype.title} ${formatUsd(archetype.savings_usd)} — jump to card`}
                aria-label={`${archetype.title}: ${formatUsd(archetype.savings_usd)}`}
                onClick={() => onSelectArchetype?.(archetype.key)}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="tax-meter-stats">
            <div className="tax-meter-stat is-avoidable">
              <span>Avoidable context</span>
              <strong>{formatTokens(avoidableTokens)}</strong>
            </div>
          </div>
          {avoidableTokens > 0 && (
            <div
              className="tax-meter-bar"
              role="group"
              aria-label={`Avoidable context breakdown: ${formatTokens(avoidableTokens)}`}
            >
              {supported.map((archetype) => (
                <button
                  key={archetype.key}
                  type="button"
                  className="tax-meter-segment"
                  style={{
                    width: `${(archetype.savings_tokens / avoidableTokens) * 100}%`,
                    background: ARCHETYPE_COLORS[archetype.key],
                  }}
                  title={`${archetype.title} ${formatTokens(archetype.savings_tokens)} — jump to card`}
                  aria-label={`${archetype.title}: ${formatTokens(archetype.savings_tokens)}`}
                  onClick={() => onSelectArchetype?.(archetype.key)}
                />
              ))}
            </div>
          )}
        </>
      )}
      <div className="tax-meter-legend">
        {archetypes.map((archetype) => {
          const gated = !archetype.meets_support;
          return (
            <button
              key={archetype.key}
              type="button"
              className={`tax-meter-legend-item${selectedKey === archetype.key ? " is-active" : ""}`}
              style={{ "--archetype-color": ARCHETYPE_COLORS[archetype.key] } as React.CSSProperties}
              disabled={gated}
              title={gated
                ? `Needs more evidence — ${archetype.findings_count} of ${meta.min_support} findings`
                : undefined}
              onClick={() => onSelectArchetype?.(archetype.key)}
            >
              <i style={{ background: ARCHETYPE_COLORS[archetype.key] }} />
              {archetype.title}
              <b>
                {gated
                  ? `${archetype.findings_count}/${meta.min_support}`
                  : meta.cost_available
                    ? formatUsd(archetype.savings_usd)
                    : formatTokens(archetype.savings_tokens)}
              </b>
            </button>
          );
        })}
        {meta.cost_available && (
          <span className="tax-meter-legend-item is-static">
            <i className="tax-meter-necessary-swatch" />
            Necessary
            <b>{formatUsd(meta.necessary_usd)}</b>
          </span>
        )}
      </div>
    </section>
  );
}
