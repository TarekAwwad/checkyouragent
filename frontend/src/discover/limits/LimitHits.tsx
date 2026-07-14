import React from "react";
import { useQuery } from "@tanstack/react-query";
import type { TechniqueProps } from "../techniques";
import type { LimitsResponse } from "../../api/types";
import { getLimits } from "../../api/client";
import WindowsTimeline from "./WindowsTimeline";
import CapZones from "./CapZones";
import PlanHistoryModal from "./PlanHistoryModal";
import { Blurred } from "../../shell/Blurred";
import InsightStat from "../../components/InsightStat";
import LoadingBar from "../../components/LoadingBar";
import { activeEra, buildVerdict, eraRates, formatBlocked, formatUsd } from "./limitMath";

function hitCountsHint(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([kind, count]) => `${count} ${kind}`);
  return parts.length > 0 ? parts.join(" · ") : "in your exported logs";
}

function cappedCount(windows: LimitsResponse["windows"]): number {
  return windows.filter((w) => w.hit_kinds.length > 0).length;
}

function cappedPct(windows: LimitsResponse["windows"]): number {
  if (windows.length === 0) return 0;
  return Math.round((cappedCount(windows) / windows.length) * 100);
}

// Explore technique: measured subscription limits. Account-level by design,
// so unlike the other techniques there is no project filter (the window that
// capped may have been filled by several projects at once).
export default function LimitHits({ onOpenSession }: TechniqueProps) {
  const query = useQuery<LimitsResponse>({ queryKey: ["limits"], queryFn: getLimits });
  const data = query.data;
  const [selected, setSelected] = React.useState<number | null>(null);
  const [planOpen, setPlanOpen] = React.useState(false);

  // The verdict reads the plan the user is on now (the newest window's era).
  const verdict = React.useMemo(() => {
    if (!data || data.windows.length === 0) return null;
    const era = activeEra(data.windows);
    return buildVerdict(
      data.eras.find((e) => e.era === era),
      eraRates(data.windows, data.hits).get(era ?? ""),
    );
  }, [data]);

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
          <button type="button" className="ghost-action" onClick={() => setPlanOpen(true)}>
            Plan history
          </button>
        </div>

        {query.isLoading && (
          <div className="loading-view"><LoadingBar caption="Reconstructing 5-hour windows…" /></div>
        )}
        {query.isError && (
          <div className="empty-state panel-error">
            <strong>Failed to load</strong>
            <span>Limit analytics could not be loaded.</span>
          </div>
        )}

        {data && (
          <>
            {!data.meta.cost_available && (
              <p className="tile-note">Price table unavailable, so window dollar values cannot be computed.</p>
            )}
            {data.meta.cost_available && data.meta.costs_partial && (
              <p className="tile-note">Some models lack prices, so window values are a lower bound.</p>
            )}
            <div className="cost-insight-strip limit-insight-strip" aria-label="Limit stats">
              <InsightStat label="Limit hits" value={data.meta.total_hits}
                           hint={hitCountsHint(data.meta.hit_counts)} />
              <InsightStat label="Time blocked" value={formatBlocked(data.meta.blocked_minutes)}
                           hint="from parsed reset times" />
              <InsightStat label="Capped windows" value={`${cappedPct(data.windows)}%`}
                           hint={`${cappedCount(data.windows)} of ${data.windows.length} windows hit a cap`} />
            </div>
            {verdict && (
              <p className="limit-verdict" data-tone={verdict.tone}>
                <i aria-hidden={true} />
                <span>{verdict.text}</span>
              </p>
            )}
            <section className="card" aria-label="Windows timeline">
              <div className="card-head">
                <h2>5-hour windows, hits marked</h2>
                <span className="card-count"><b>{data.meta.total_windows}</b> windows</span>
              </div>
              <div className="card-pad">
                <WindowsTimeline windows={data.windows} hits={data.hits} selected={selected}
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
                  <span className="card-count">
                    {new Date(data.windows[selected].start).toLocaleString()}
                  </span>
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

        {planOpen && <PlanHistoryModal onClose={() => setPlanOpen(false)} />}
      </div>
    </main>
  );
}
