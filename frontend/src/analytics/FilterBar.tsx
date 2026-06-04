// frontend/src/analytics/FilterBar.tsx
import { useState } from "react";
import type { CostAnalyticsFilters, CostAnalyticsMeta } from "../api/types";
import { displayModelName, formatTokens, formatUsd } from "./chartGeometry";

interface Props {
  filters: CostAnalyticsFilters;
  meta: CostAnalyticsMeta | undefined;
  onChange: (next: CostAnalyticsFilters) => void;
}

const RANGES: { label: string; days: number | null }[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "All time", days: null },
];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export default function FilterBar({ filters, meta, onChange }: Props) {
  const [rangeKey, setRangeKey] = useState("30");
  return (
    <div className="cost-filterbar">
      <select
        value={rangeKey}
        onChange={(e) => {
          setRangeKey(e.target.value);
          const range = RANGES.find((r) => String(r.days) === e.target.value);
          onChange({ ...filters, dateFrom: range?.days ? isoDaysAgo(range.days) : null });
        }}
      >
        {RANGES.map((r) => (
          <option key={r.label} value={String(r.days)}>{r.label}</option>
        ))}
      </select>

      <select
        value={filters.projectId ?? ""}
        onChange={(e) => onChange({ ...filters, projectId: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">All projects</option>
        {meta?.available_projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      <select
        value={filters.model ?? ""}
        onChange={(e) => onChange({ ...filters, model: e.target.value || null })}
      >
        <option value="">All models</option>
        {meta?.available_models.map((m) => (
          <option key={m} value={m}>{displayModelName(m)}</option>
        ))}
      </select>

      <div className="cost-total">
        <b>{meta && meta.available ? formatUsd(meta.total_usd) : "—"}</b>
        <span>
          {meta ? `${formatTokens(meta.total_tokens)} tokens · est.` : ""}
          {meta && meta.unpriced_models.length > 0 && (
            <span className="cost-partial" title={meta.unpriced_models.join(", ")}> · partial</span>
          )}
        </span>
      </div>
    </div>
  );
}
