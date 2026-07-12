import React from "react";
import { useQuery } from "@tanstack/react-query";
import type { TechniqueProps } from "../techniques";
import type { LimitsResponse } from "../../api/types";
import { getLimits } from "../../api/client";

export function formatBlocked(minutes: number): string {
  if (!minutes) return "0h";
  const hours = minutes / 60;
  return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value == null) return "n/a";
  return `$${value >= 100 ? value.toFixed(0) : value.toFixed(1)}`;
}

// Explore technique: measured subscription limits. Account-level by design,
// so unlike the other techniques there is no project filter (the window that
// capped may have been filled by several projects at once).
export default function LimitHits(_props: TechniqueProps) {
  const query = useQuery<LimitsResponse>({ queryKey: ["limits"], queryFn: getLimits });
  const data = query.data;

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <div className="discover-toolbar" aria-label="Limit hits controls">
          <div className="discover-toolbar-lead">
            <h1>Limit hits</h1>
            <p className="discover-subtitle">
              Every cap hit recorded in your logs, and the 5-hour windows behind
              them. Covers all projects: limits are account-level.
            </p>
          </div>
        </div>

        {query.isLoading && <div className="empty-state">Reconstructing windows.</div>}
        {query.isError && <div className="empty-state">Could not load limit analytics.</div>}

        {data && (
          <>
            <div className="limit-tiles" aria-label="Limit stats">
              <div className="limit-tile">
                <strong>{data.meta.total_hits}</strong>
                <span>limit hits</span>
              </div>
              <div className="limit-tile">
                <strong>{formatBlocked(data.meta.blocked_minutes)}</strong>
                <span>blocked</span>
              </div>
              <div className="limit-tile">
                <strong>{data.meta.hits_per_week_recent}</strong>
                <span>hits/week, last 28 days</span>
              </div>
              {data.eras
                .filter((era) => era.cap_median_usd != null)
                .map((era) => (
                  <div key={era.era || "all"} className="limit-tile">
                    <strong>{formatUsd(era.cap_median_usd)}</strong>
                    <span>{era.era ? `${era.era} cap, median` : "measured cap, median"}</span>
                  </div>
                ))}
            </div>
            <p className="limit-footnote">{data.meta.method_note}</p>
          </>
        )}
      </div>
    </main>
  );
}
