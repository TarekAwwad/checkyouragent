import React from "react";
import { useQuery } from "@tanstack/react-query";
import type { TechniqueProps } from "../techniques";
import type { LimitsResponse } from "../../api/types";
import { getLimits } from "../../api/client";
import WindowsTimeline from "./WindowsTimeline";
import CapZones from "./CapZones";
import { Blurred } from "../../shell/Blurred";

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
export default function LimitHits({ onOpenSession }: TechniqueProps) {
  const query = useQuery<LimitsResponse>({ queryKey: ["limits"], queryFn: getLimits });
  const data = query.data;
  const [selected, setSelected] = React.useState<number | null>(null);

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
            <section className="card" aria-label="Windows timeline">
              <div className="card-head">
                <h2>5-hour windows, hits marked</h2>
              </div>
              <div className="card-pad">
                <WindowsTimeline windows={data.windows} selected={selected}
                                 onSelectWindow={setSelected} />
              </div>
            </section>

            <section className="card" aria-label="Measured cap zones">
              <div className="card-head">
                <h2>Measured cap zones</h2>
              </div>
              <div className="card-pad">
                <CapZones eras={data.eras} />
              </div>
            </section>

            {selected != null && (
              <section className="card" aria-label="Window detail">
                <div className="card-head">
                  <h2>Window detail</h2>
                </div>
                <div className="card-pad">
                  {data.hits.filter((h) => h.window_index === selected).map((h) => (
                    <div key={h.ts} className="limit-hit-detail">
                      <span className={`limit-kind limit-kind-${h.kind}`}>{h.kind} limit</span>
                      <span>{new Date(h.ts).toLocaleString()}</span>
                      <span>
                        {h.blocked_minutes != null
                          ? `blocked ${formatBlocked(h.blocked_minutes)}`
                          : "reset time unknown"}
                      </span>
                      {h.usage_at_hit != null && (
                        <span>at {formatUsd(h.usage_at_hit)} of window usage</span>
                      )}
                      {h.occurrence_count > 1 && <span>seen {h.occurrence_count} times</span>}
                      <span className="limit-sessions">
                        {h.session_ids.map((id, i) => (
                          <button key={id} type="button" className="link-button"
                                  onClick={() => onOpenSession(id)}>
                            <Blurred>{h.session_titles[i] || `Session ${id}`}</Blurred>
                          </button>
                        ))}
                      </span>
                    </div>
                  ))}
                  {data.hits.every((h) => h.window_index !== selected) && (
                    <p>No hits in this window.</p>
                  )}
                </div>
              </section>
            )}

            <p className="limit-footnote">{data.meta.method_note}</p>
          </>
        )}
      </div>
    </main>
  );
}
