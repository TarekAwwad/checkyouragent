// frontend/src/analytics/FilterBar.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import type { CostAnalyticsFilters, CostAnalyticsMeta } from "../api/types";
import type { DataScope } from "../shell/useDataScope";
import { displayModelName, formatTokens, formatUsd } from "./chartGeometry";

interface Props {
  filters: CostAnalyticsFilters;
  meta: CostAnalyticsMeta | undefined;
  historical: boolean;
  onChange: (next: CostAnalyticsFilters) => void;
  onHistoricalChange: (value: boolean) => void;
  scope?: DataScope;
  rangeKey?: string;
  onRangeKeyChange?: (value: string) => void;
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

export default function FilterBar({
  filters,
  meta,
  historical,
  onChange,
  onHistoricalChange,
  scope = "local",
  rangeKey: controlledRangeKey,
  onRangeKeyChange,
}: Props) {
  const [localRangeKey, setLocalRangeKey] = useState(() => !filters.dateFrom && !filters.dateTo ? "all" : "custom");
  const rangeKey = controlledRangeKey ?? localRangeKey;
  const setRangeKey = (value: string) => {
    if (controlledRangeKey === undefined) setLocalRangeKey(value);
    onRangeKeyChange?.(value);
  };
  const projectNames = useRef({ scope, names: new Map<number, string>() });

  useEffect(() => {
    const names = projectNames.current.scope === scope ? projectNames.current.names : new Map<number, string>();
    for (const project of meta?.available_projects ?? []) names.set(project.id, project.name);
    projectNames.current = { scope, names };
  }, [scope, meta?.available_projects]);

  const missingProject = filters.projectId != null
    && !meta?.available_projects.some((project) => project.id === filters.projectId);
  const selectedProjectName = filters.projectId != null && projectNames.current.scope === scope
    ? projectNames.current.names.get(filters.projectId)
    : undefined;
  const missingModel = Boolean(filters.model && !meta?.available_models.includes(filters.model));
  // Missing metadata means the range is still loading. Keep the active filter
  // visible, and only describe zero activity once a response confirms it.
  const missingSuffix = meta ? " (no activity in range)" : "";
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
        {missingProject && (
          <option value={filters.projectId!}>
            {selectedProjectName || `Project ${filters.projectId}`}{missingSuffix}
          </option>
        )}
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
        {missingModel && (
          <option value={filters.model!}>{displayModelName(filters.model!)}{missingSuffix}</option>
        )}
        {meta?.available_models.map((m) => (
          <option key={m} value={m}>{displayModelName(m)}</option>
        ))}
      </select>

      <label
        className="cost-pricing-control"
        title={historical
          ? "Use price rates effective on each session's date"
          : "Use the current price table for every session"}
      >
        <input
          type="checkbox"
          checked={historical}
          onChange={(event) => onHistoricalChange(event.target.checked)}
        />
        <span>Historical pricing</span>
      </label>

      <div className="cost-total">
        <span>Estimated API-equivalent cost</span>
        <b>
          {meta && meta.available
            ? `${meta.costs_are_lower_bound ? "≥" : ""}${formatUsd(meta.total_usd)}`
            : "—"}
        </b>
        <span>
          {meta ? `${formatTokens(meta.total_tokens)} tokens` : ""}
          {meta?.costs_partial && (
            <span className="cost-partial" title={meta.unpriced_models.join(", ")}>
              {` · lower bound · excludes ${meta.unpriced_models.length} unpriced model${meta.unpriced_models.length === 1 ? "" : "s"}`}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
