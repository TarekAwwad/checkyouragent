// frontend/src/analytics/FilterBar.tsx
import { useMemo, useState } from "react";
import type { CostAnalyticsFilters, CostAnalyticsMeta } from "../api/types";
import { displayModelName, formatTokens, formatUsd } from "./chartGeometry";

interface Props {
  filters: CostAnalyticsFilters;
  meta: CostAnalyticsMeta | undefined;
  onChange: (next: CostAnalyticsFilters) => void;
}

const RANGE_OPTIONS: { key: string; label: string; days: number | null }[] = [
  { key: "7", label: "Last 7 days", days: 7 },
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
  { key: "custom", label: "Custom range", days: null },
];

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function toDateInputValue(value: string | null | undefined): string {
  if (!value) return "";
  const directMatch = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (directMatch) return directMatch[0];

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function dateBoundaryIso(value: string, boundary: "start" | "end"): string | null {
  if (!value) return null;
  return boundary === "start" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`;
}

export default function FilterBar({ filters, meta, onChange }: Props) {
  const [rangeKey, setRangeKey] = useState("30");
  const dateFromValue = useMemo(() => toDateInputValue(filters.dateFrom), [filters.dateFrom]);
  const dateToValue = useMemo(() => toDateInputValue(filters.dateTo), [filters.dateTo]);

  return (
    <div className="cost-filterbar">
      <select
        aria-label="Date range"
        value={rangeKey}
        onChange={(e) => {
          setRangeKey(e.target.value);
          const range = RANGE_OPTIONS.find((r) => r.key === e.target.value);
          if (!range || range.key === "custom") return;
          onChange({
            ...filters,
            dateFrom: range.days ? isoDaysAgo(range.days) : null,
            dateTo: null,
          });
        }}
      >
        {RANGE_OPTIONS.map((r) => (
          <option key={r.key} value={r.key}>{r.label}</option>
        ))}
      </select>

      <input
        aria-label="Start date"
        type="date"
        value={dateFromValue}
        onChange={(e) => {
          setRangeKey("custom");
          onChange({ ...filters, dateFrom: dateBoundaryIso(e.target.value, "start") });
        }}
      />

      <input
        aria-label="End date"
        type="date"
        value={dateToValue}
        onChange={(e) => {
          setRangeKey("custom");
          onChange({ ...filters, dateTo: dateBoundaryIso(e.target.value, "end") });
        }}
      />

      <select
        aria-label="Project"
        value={filters.projectId ?? ""}
        onChange={(e) => onChange({ ...filters, projectId: e.target.value ? Number(e.target.value) : null })}
      >
        <option value="">All projects</option>
        {meta?.available_projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      <select
        aria-label="Model"
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
