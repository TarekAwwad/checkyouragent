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
import {
  formatLimitValue,
  formatResetInterval,
  hitUsage,
  type LimitBasis,
} from "./limitMath";

function hitCountsHint(counts: Record<string, number>): string {
  return Object.entries(counts).map(([kind, count]) => `${count} ${kind}`).join(" · ");
}

function sessionHitWindowCount(windows: LimitsResponse["windows"]): number {
  return windows.filter((w) => w.hit_kinds.includes("session")).length;
}

// Explore technique: measured subscription limits. Account-level by design,
// so unlike the other techniques there is no project filter (a limit window
// may have been filled by several projects at once).
export default function LimitHits({ onOpenSession }: TechniqueProps) {
  const query = useQuery<LimitsResponse>({ queryKey: ["limits"], queryFn: getLimits });
  const data = query.data;
  const [selected, setSelected] = React.useState<number | null>(null);
  const [planOpen, setPlanOpen] = React.useState(false);
  const [chosenBasis, setChosenBasis] = React.useState<LimitBasis | null>(null);

  // Derived, not an effect: a cost basis the price table cannot back would
  // otherwise paint one frame of all-zero dollars before flipping to tokens.
  // Partial prices still default to tokens, but cost stays reachable; without
  // a price table at all there is nothing to switch to.
  const costUnusable = data != null && !data.meta.cost_available;
  const defaultBasis: LimitBasis =
    data != null && (!data.meta.cost_available || data.meta.costs_partial) ? "tokens" : "cost";
  const basis: LimitBasis = costUnusable ? "tokens" : chosenBasis ?? defaultBasis;

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <div className="discover-toolbar" aria-label="Limit hits controls">
          <div className="discover-toolbar-lead">
            <h1>Limit hits</h1>
            <p className="discover-subtitle">Limit hits and 5-hour windows, all projects.</p>
          </div>
          <div className="limit-toolbar-actions">
            <div className="segmented-control" role="group" aria-label="Usage measurement">
              {(["tokens", "cost"] as LimitBasis[]).map((item) => (
                <button key={item} type="button"
                        className={basis === item ? "active" : ""}
                        aria-pressed={basis === item}
                        disabled={item === "cost" && costUnusable}
                        onClick={() => setChosenBasis(item)}>
                  {item === "cost" ? "Cost" : "Tokens"}
                </button>
              ))}
            </div>
            <button type="button" className="ghost-action" onClick={() => setPlanOpen(true)}>
              Plan history
            </button>
          </div>
        </div>

        {query.isLoading && (
          <div className="loading-view"><LoadingBar caption="Loading limit hits…" /></div>
        )}
        {query.isError && (
          <div className="empty-state panel-error">
            <strong>Failed to load</strong>
            <span>Limit hits could not be loaded.</span>
          </div>
        )}

        {data && (
          <>
            {!data.meta.cost_available && (
              <p className="tile-note">No price table: tokens only.</p>
            )}
            {data.meta.cost_available && data.meta.costs_partial && (
              <p className="tile-note">Some models are unpriced: costs are a lower bound.</p>
            )}
            <div className="cost-insight-strip limit-insight-strip" aria-label="Limit stats">
              <InsightStat label="Limit hits" value={data.meta.total_hits}
                           hint={hitCountsHint(data.meta.hit_counts)} />
              <InsightStat label="Time to reset"
                           value={formatResetInterval(data.meta.minutes_until_reset)}
                           hint="across all hits" />
              <InsightStat label="Windows with a session hit"
                           value={`${sessionHitWindowCount(data.windows)} of ${data.windows.length}`} />
            </div>
            <section className="card" aria-label="Windows timeline">
              <div className="card-head">
                <h2>5-hour windows</h2>
                <span className="card-count"><b>{data.meta.total_windows}</b> windows</span>
              </div>
              <div className="card-pad">
                <WindowsTimeline windows={data.windows} eras={data.eras}
                                 basis={basis} selected={selected}
                                 onSelectWindow={setSelected} />
              </div>
            </section>

            <section className="card" aria-label="Usage at session-limit hit">
              <div className="card-head">
                <h2>Usage at session-limit hit</h2>
              </div>
              <div className="card-pad">
                <CapZones eras={data.eras} basis={basis} />
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
                        {h.minutes_until_reset != null
                          ? `resets in ${formatResetInterval(h.minutes_until_reset)}`
                          : "reset time unknown"}
                      </span>
                      {hitUsage(h, basis) != null && (
                        <span>
                          at {formatLimitValue(hitUsage(h, basis), basis)} usage
                        </span>
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
          </>
        )}

        {planOpen && <PlanHistoryModal onClose={() => setPlanOpen(false)} />}
      </div>
    </main>
  );
}
