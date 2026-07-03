import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSessionTurnCosts } from "../api/client";
import LoadingBar from "../components/LoadingBar";
import type { CostAnalyticsResponse, SessionCostEntry, TurnCostBreakdown, TurnCostDetail } from "../api/types";
import {
  buildTurnBubblePlot,
  displayModelName,
  formatSignedUsd,
  formatTokens,
  formatUsd,
  formatUsdPerMillion,
  turnDistributionSummary,
  turnDistributionSessions,
} from "./chartGeometry";
import { Blurred } from "../shell/Blurred";

interface Props {
  payload: CostAnalyticsResponse;
  onOpenSession: (sessionId: number) => void;
  available: boolean;
}

type Mode = "spend" | "turn";

const MODES: Array<{ key: Mode; label: string }> = [
  { key: "spend", label: "Top spend" },
  { key: "turn", label: "Turn distribution" },
];

const DETAIL_PLOT_FALLBACK_WIDTH = 480;
const DETAIL_PLOT_HEIGHT = 196;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 0) {
    return (ordered[middle - 1] + ordered[middle]) / 2;
  }
  return ordered[middle];
}

function turnTokenTotal(turn: TurnCostDetail): number {
  return turn.input_tokens + turn.output_tokens;
}

function turnEffectiveRate(turn: TurnCostDetail): number {
  const totalTokens = turnTokenTotal(turn);
  return totalTokens > 0 ? (turn.usd / totalTokens) * 1_000_000 : 0;
}

function modelSummary(models: string[]): string {
  if (models.length === 0) return "No priced model work";
  const labels = models.map(displayModelName);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2} more`;
}

function defaultTurn(detail: TurnCostBreakdown | undefined): TurnCostDetail | null {
  if (!detail || detail.turns.length === 0) return null;
  const ranked = [...detail.turns].sort((a, b) => b.usd - a.usd);
  return ranked.find((turn) => turn.is_outlier) ?? ranked[0] ?? null;
}

function buildTurnDetailPlot(detail: TurnCostBreakdown, selectedTurnId: number, width: number) {
  const safeWidth = Math.max(width, 280);
  const plotLeft = 34;
  const plotTop = 10;
  const plotWidth = safeWidth - plotLeft - 8;
  const plotHeight = DETAIL_PLOT_HEIGHT - plotTop - 24;
  const maxUsd = Math.max(detail.max_usd, detail.outlier_threshold_usd, ...detail.turns.map((turn) => turn.usd), 1);
  const slotWidth = plotWidth / Math.max(detail.turns.length, 1);
  const barWidth = Math.max(8, Math.min(22, slotWidth * 0.62));
  const selectedIndex = detail.turns.findIndex((turn) => turn.start_event_id === selectedTurnId);

  const bars = detail.turns.map((turn, index) => {
    const x = plotLeft + index * slotWidth + (slotWidth - barWidth) / 2;
    const height = maxUsd > 0 ? (turn.usd / maxUsd) * plotHeight : 0;
    return {
      turn,
      x,
      y: plotTop + plotHeight - height,
      width: barWidth,
      height,
      labelX: plotLeft + index * slotWidth + slotWidth / 2,
    };
  });

  const xLabelIndexes = detail.turns.length <= 6
    ? detail.turns.map((_, index) => index)
    : Array.from(new Set([0, Math.max(selectedIndex, 0), detail.turns.length - 1])).sort((a, b) => a - b);

  return {
    bars,
    yTicks: [maxUsd, maxUsd / 2, 0].map((value) => ({
      value,
      y: plotTop + plotHeight - (value / maxUsd) * plotHeight,
      label: formatUsd(value),
    })),
    xLabels: xLabelIndexes.map((index) => ({
      x: plotLeft + index * slotWidth + slotWidth / 2,
      label: String(detail.turns[index].index),
    })),
    medianY: plotTop + plotHeight - (detail.median_usd / maxUsd) * plotHeight,
    thresholdY: detail.outlier_threshold_usd > 0
      ? plotTop + plotHeight - (detail.outlier_threshold_usd / maxUsd) * plotHeight
      : null,
    plotLeft,
    plotTop,
    plotWidth,
    plotHeight,
    width: safeWidth,
    height: DETAIL_PLOT_HEIGHT,
  };
}

function buildTurnInsights(detail: TurnCostBreakdown, turn: TurnCostDetail): string[] {
  const tokenValues = detail.turns.map(turnTokenTotal).filter((value) => value > 0);
  const rateValues = detail.turns.map(turnEffectiveRate).filter((value) => value > 0);
  const medianTokens = median(tokenValues);
  const medianRate = median(rateValues);
  const reasons: string[] = [];

  if (turn.is_outlier) {
    reasons.push(`This turn sits above the session outlier threshold of ${formatUsd(detail.outlier_threshold_usd)}.`);
  } else if (detail.outlier_threshold_usd > 0) {
    reasons.push(`No single turn crosses the outlier threshold of ${formatUsd(detail.outlier_threshold_usd)}, so this view starts with the session's costliest turn.`);
  } else {
    reasons.push("This session does not have enough spread for a statistical outlier threshold, so the card focuses on the costliest turn.");
  }

  const totalTokens = turnTokenTotal(turn);
  if (totalTokens > 0 && medianTokens > 0 && totalTokens >= medianTokens * 1.5) {
    reasons.push(`Token volume is ${(totalTokens / medianTokens).toFixed(1)}x the session median (${formatTokens(totalTokens)} vs ${formatTokens(Math.round(medianTokens))}), which is the clearest cost driver here.`);
  }

  const rate = turnEffectiveRate(turn);
  if (rate > 0 && medianRate > 0 && rate >= medianRate * 1.25) {
    reasons.push(`Its effective rate is ${formatUsdPerMillion(rate)} versus a turn median of ${formatUsdPerMillion(medianRate)}, which points to pricier model usage or less cache relief.`);
  }

  if (turn.loop_count > 0 || turn.max_repeat > 1) {
    reasons.push(`Repeated tool activity appears in this turn (${turn.loop_count} loop run${turn.loop_count === 1 ? "" : "s"}, max repeat ${turn.max_repeat}), which often means retries or iterative recovery.`);
  } else if (turn.tool_call_count > 0) {
    reasons.push(`It includes ${turn.tool_call_count} tool call${turn.tool_call_count === 1 ? "" : "s"}, so orchestration overhead may be part of the spike.`);
  }

  if (turn.subagent_count > 0) {
    reasons.push(`Subagents handled ${turn.subagent_count} event${turn.subagent_count === 1 ? "" : "s"} in this turn, which can add extra model calls.`);
  }

  if (turn.error_count > 0) {
    reasons.push(`It contains ${turn.error_count} tool error${turn.error_count === 1 ? "" : "s"}, a common sign that retries or fallback work pushed spend up.`);
  }

  if (turn.models.length > 0) {
    reasons.push(`Priced model work in this turn comes from ${modelSummary(turn.models)}.`);
  }

  return reasons.slice(0, 4);
}

function metricLabel(session: SessionCostEntry, mode: Mode): string {
  if (mode === "turn") return `${formatUsd(session.turn_cost_stats.p95_usd)} p95`;
  return formatUsd(session.usd);
}

function metaLabel(session: SessionCostEntry, mode: Mode): string {
  if (mode === "turn") {
    return `${session.project_name} - median ${formatUsd(session.turn_cost_stats.median_usd)} - max ${formatUsd(session.turn_cost_stats.max_usd)} - ${session.turn_cost_stats.outlier_count} outliers`;
  }
  return `${session.project_name} - ${formatTokens(session.tokens)} tokens - ${session.turn_count || 0} turns`;
}

function badges(session: SessionCostEntry): string[] {
  const values = [];
  if (session.loop_count > 0) values.push(`loops ${session.loop_count}`);
  if (session.max_repeat > 0) values.push(`repeat ${session.max_repeat}`);
  if (session.error_count > 0) values.push(`errors ${session.error_count}`);
  if (session.subagent_count > 0) values.push(`subs ${session.subagent_count}`);
  if (session.finding_count > 0) values.push(`findings ${session.finding_count}`);
  return values;
}

function TurnDistributionPlot({
  sessions,
  onInspectSession,
  selectedSessionId,
}: {
  sessions: SessionCostEntry[];
  onInspectSession: (sessionId: number) => void;
  selectedSessionId: number | null;
}) {
  const plot = useMemo(() => buildTurnBubblePlot(sessions, 640, 240), [sessions]);
  if (plot.points.length === 0) {
    return <div className="empty-state">No turn distribution data in range.</div>;
  }

  const targetX = plot.xTicks[1]?.x ?? plot.plotLeft + plot.plotWidth * 0.5;
  const targetY = plot.yTicks[1]?.y ?? plot.plotTop + plot.plotHeight * 0.5;
  const targetWidth = Math.max(targetX - plot.plotLeft, 0);
  const targetHeight = Math.max(plot.plotTop + plot.plotHeight - targetY, 0);

  return (
    <div className="turn-bubble">
      <svg viewBox={`0 0 ${plot.width} ${plot.height}`} role="img" aria-label="Turn cost distribution">
        <rect className="tb-plot-bg" x={plot.plotLeft} y={plot.plotTop} width={plot.plotWidth} height={plot.plotHeight} rx={8} />
        <g className="tb-target" aria-label="Target zone">
          <rect className="tb-target-zone" x={plot.plotLeft} y={targetY} width={targetWidth} height={targetHeight} rx={8} />
          <rect className="tb-target-outline" x={plot.plotLeft} y={targetY} width={targetWidth} height={targetHeight} rx={8} />
        </g>
        {plot.yTicks.map((tick) => (
          <g key={`y-${tick.label}`}>
            <line className="tb-grid" x1={plot.plotLeft} x2={plot.plotLeft + plot.plotWidth} y1={tick.y} y2={tick.y} />
            <text className="tb-ylabel" x={plot.plotLeft - 8} y={tick.y + 3}>{tick.label}</text>
          </g>
        ))}
        {plot.xTicks.map((tick) => (
          <g key={`x-${tick.label}`}>
            <line className="tb-grid faint" x1={tick.x} x2={tick.x} y1={plot.plotTop} y2={plot.plotTop + plot.plotHeight} />
            <text className="tb-xlabel" x={tick.x} y={plot.plotTop + plot.plotHeight + 18}>{tick.label}</text>
          </g>
        ))}
        <text className="tb-axis-label x" x={plot.plotLeft + plot.plotWidth / 2} y={plot.height - 4}>median $/turn</text>
        <text className="tb-axis-label y" x={12} y={plot.plotTop + plot.plotHeight / 2} transform={`rotate(-90 12 ${plot.plotTop + plot.plotHeight / 2})`}>p95 $/turn</text>
        {plot.points.map((point) => {
          const inspectSession = () => onInspectSession(point.session.id);
          const outlierRatePct = Math.round(point.outlierRate * 100);
          const outlierLabel = point.outlierCount > 0
            ? `outliers ${point.outlierCount}/${point.session.turn_cost_stats.turn_count} turns (${outlierRatePct}%)`
            : "no outlier turns";
          return (
            <g
              key={point.session.id}
              className={`tb-point sev-${point.severity} ${selectedSessionId === point.session.id ? "is-active" : ""}`}
              onClick={inspectSession}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  inspectSession();
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`${point.session.title || point.session.session_id}: median ${formatUsd(point.session.turn_cost_stats.median_usd)}, p95 ${formatUsd(point.session.turn_cost_stats.p95_usd)}, ${outlierLabel}`}
            >
              <title>
                {`${point.session.title || point.session.session_id}\nmedian ${formatUsd(point.session.turn_cost_stats.median_usd)} - p95 ${formatUsd(point.session.turn_cost_stats.p95_usd)} - ${outlierLabel} - max ${formatUsd(point.session.turn_cost_stats.max_usd)} - total ${formatUsd(point.session.usd)}`}
              </title>
              {point.outlierCount > 0 && (
                <circle
                  className="tb-outlier-ring"
                  cx={point.x}
                  cy={point.y}
                  r={point.r + 3}
                  style={{
                    strokeWidth: 1.25 + point.outlierRate * 5,
                    opacity: 0.38 + Math.min(point.outlierRate * 1.5, 0.42),
                  }}
                />
              )}
              <circle className="tb-bubble" cx={point.x} cy={point.y} r={point.r} />
            </g>
          );
        })}
      </svg>
      <div className="tb-legend card-bottom-legend">
        <span><i className="sev-target" /> target zone</span>
        <span><i className="sev-normal" /> stable</span>
        <span><i className="sev-alert" /> outside target</span>
        <span><i className="sev-outlier" /> outlier turns</span>
        <em>Bubble size = total session cost</em>
      </div>
    </div>
  );
}

function TurnDistributionGuide({ sessions }: { sessions: SessionCostEntry[] }) {
  const summary = useMemo(() => turnDistributionSummary(sessions), [sessions]);

  return (
    <aside className="turn-explainer" aria-label="Turn distribution guide">
      <div className="turn-explainer-stat">
        <span>Outside target</span>
        <strong>{summary.attentionCount} of {summary.total}</strong>
        <small>sessions land outside the cheap-and-steady zone</small>
      </div>
      <div className="turn-explainer-hints">
        <p><strong>Lower-left:</strong> cheap and steady</p>
        <p><strong>Right:</strong> baseline cost is high</p>
        <p><strong>Up:</strong> a few turns spike</p>
        <p><strong>Ring:</strong> session contains unusually costly turns</p>
        <p><strong>Click:</strong> inspect the costly turns before leaving this page</p>
      </div>
    </aside>
  );
}

function TurnOutlierInspector({
  session,
  onOpenSession,
}: {
  session: SessionCostEntry | null;
  onOpenSession: (sessionId: number) => void;
}) {
  const [selectedTurnId, setSelectedTurnId] = useState<number | null>(null);
  const plotHostRef = useRef<HTMLDivElement | null>(null);
  const [plotWidth, setPlotWidth] = useState(DETAIL_PLOT_FALLBACK_WIDTH);
  const detailQuery = useQuery({
    queryKey: ["session-turn-costs", session?.id ?? null],
    queryFn: () => getSessionTurnCosts(session!.id),
    enabled: Boolean(session),
  });

  useEffect(() => {
    setSelectedTurnId(null);
  }, [session?.id]);

  useEffect(() => {
    const node = plotHostRef.current;
    if (!node) return;

    const updateWidth = (nextWidth: number) => {
      setPlotWidth((current) => {
        const rounded = Math.max(280, Math.round(nextWidth));
        return current === rounded ? current : rounded;
      });
    };

    updateWidth(node.clientWidth || DETAIL_PLOT_FALLBACK_WIDTH);

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const detail = detailQuery.data;
  const focusTurn = useMemo(() => {
    if (!detail) return null;
    return detail.turns.find((turn) => turn.start_event_id === selectedTurnId) ?? defaultTurn(detail);
  }, [detail, selectedTurnId]);
  const plot = useMemo(() => {
    if (!detail || !focusTurn) return null;
    return buildTurnDetailPlot(detail, focusTurn.start_event_id, plotWidth);
  }, [detail, focusTurn, plotWidth]);
  const insights = useMemo(() => {
    if (!detail || !focusTurn) return [];
    return buildTurnInsights(detail, focusTurn);
  }, [detail, focusTurn]);

  if (!session) {
    return (
      <aside className="turn-detail-card is-placeholder" aria-label="Turn outlier investigation">
        <p className="turn-detail-hint">Click a bubble to investigate session turns and outliers</p>
      </aside>
    );
  }

  return (
    <aside className="turn-detail-card" aria-label="Turn outlier investigation">
      <div className="turn-detail-header">
        <div>
          <span>Investigate outlier turns</span>
          <strong><Blurred>{session.title || session.session_id}</Blurred></strong>
          <small><Blurred>{session.project_name}</Blurred></small>
        </div>
        <button type="button" className="turn-detail-link" onClick={() => onOpenSession(session.id)}>
          Open session page
        </button>
      </div>

      {detailQuery.isLoading ? (
        <div className="turn-detail-empty"><LoadingBar caption="Loading turn-level cost breakdown…" /></div>
      ) : detailQuery.isError ? (
        <p className="turn-detail-empty">{detailQuery.error instanceof Error ? detailQuery.error.message : "Unable to load turn costs."}</p>
      ) : !detail || !focusTurn || !plot ? (
        <p className="turn-detail-empty">No user turns were found for this session.</p>
      ) : (
        <>
          <p className="turn-detail-preview">
            <strong><Blurred>{focusTurn.title}</Blurred></strong>
            {focusTurn.preview ? <Blurred>{` · ${focusTurn.preview}`}</Blurred> : " · No user prompt preview captured."}
          </p>
          <div className="turn-detail-body">
            <div className="turn-detail-plot" ref={plotHostRef}>
              <svg viewBox={`0 0 ${plot.width} ${plot.height}`} role="img" aria-label="Turn cost drilldown">
                {plot.yTicks.map((tick) => (
                  <g key={`turn-y-${tick.label}`}>
                    <line className="td-grid" x1={plot.plotLeft} x2={plot.plotLeft + plot.plotWidth} y1={tick.y} y2={tick.y} />
                    <text className="td-ylabel" x={plot.plotLeft - 6} y={tick.y + 3}>{tick.label}</text>
                  </g>
                ))}
                {plot.xLabels.map((label) => (
                  <text key={`turn-x-${label.label}`} className="td-xlabel" x={label.x} y={plot.plotTop + plot.plotHeight + 15}>{label.label}</text>
                ))}
                {plot.thresholdY !== null && (
                  <g>
                    <line className="td-threshold" x1={plot.plotLeft} x2={plot.plotLeft + plot.plotWidth} y1={plot.thresholdY} y2={plot.thresholdY} />
                    <text className="td-line-label" x={plot.plotLeft + plot.plotWidth} y={plot.thresholdY - 4}>outlier</text>
                  </g>
                )}
                <g>
                  <line className="td-median" x1={plot.plotLeft} x2={plot.plotLeft + plot.plotWidth} y1={plot.medianY} y2={plot.medianY} />
                  <text className="td-line-label" x={plot.plotLeft + plot.plotWidth} y={plot.medianY - 4}>median</text>
                </g>
                {plot.bars.map((bar) => (
                  <g
                    key={bar.turn.start_event_id}
                    className={`td-bar ${bar.turn.is_outlier ? "is-outlier" : ""} ${focusTurn.start_event_id === bar.turn.start_event_id ? "is-selected" : ""}`}
                    onClick={() => setSelectedTurnId(bar.turn.start_event_id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedTurnId(bar.turn.start_event_id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${bar.turn.title}, ${formatUsd(bar.turn.usd)}${bar.turn.is_outlier ? ", outlier" : ""}`}
                  >
                    <title>{`${bar.turn.title} · ${formatUsd(bar.turn.usd)} · ${formatTokens(turnTokenTotal(bar.turn))} tokens`}</title>
                    <rect x={bar.x} y={bar.y} width={bar.width} height={Math.max(bar.height, 2)} rx={4} />
                  </g>
                ))}
                <text className="td-axis-label" x={plot.plotLeft + plot.plotWidth / 2} y={plot.height - 3}>turn index</text>
              </svg>
            </div>
            <div className="turn-detail-metrics">
              <div className="turn-detail-metric">
                <span>Est. cost</span>
                <b>{formatUsd(focusTurn.usd)}</b>
                <small>{formatSignedUsd(focusTurn.usd - detail.median_usd)} vs session median</small>
              </div>
              <div className="turn-detail-metric">
                <span>Effective rate</span>
                <b>{formatUsdPerMillion(turnEffectiveRate(focusTurn))}</b>
                <small>{modelSummary(focusTurn.models)}</small>
              </div>
              <div className="turn-detail-metric">
                <span>Reliability</span>
                <b>{focusTurn.error_count} errors · {focusTurn.event_count} events</b>
                <small>{focusTurn.assistant_message_count} assistant messages</small>
              </div>
            </div>
            <div className="turn-detail-metrics">
              <div className="turn-detail-metric">
                <span>Token volume</span>
                <b>{formatTokens(turnTokenTotal(focusTurn))}</b>
                <small>{focusTurn.input_tokens > 0 ? `${formatTokens(focusTurn.input_tokens)} in` : "No priced input"} · {formatTokens(focusTurn.output_tokens)} out</small>
              </div>
              <div className="turn-detail-metric">
                <span>Orchestration</span>
                <b>{focusTurn.tool_call_count} tools · {focusTurn.subagent_count} subs</b>
                <small>{focusTurn.loop_count} loop runs · max repeat {focusTurn.max_repeat}</small>
              </div>
              <div className="turn-detail-metric">
                <span>Session share</span>
                <b>{session.usd > 0 ? `${Math.round((focusTurn.usd / session.usd) * 100)}%` : "0%"}</b>
                <small>{detail.outlier_count} outlier turn{detail.outlier_count === 1 ? "" : "s"} in {detail.turn_count}</small>
              </div>
            </div>
          </div>
          <div className="turn-detail-causes">
            <strong>Likely drivers</strong>
            {insights.map((insight) => (
              <p key={insight}>{insight}</p>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

export function TurnDistributionSection({
  sessions,
  onOpenSession,
  available,
}: {
  sessions: SessionCostEntry[];
  onOpenSession: (sessionId: number) => void;
  available: boolean;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  );

  useEffect(() => {
    if (selectedSessionId !== null && !sessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(null);
    }
  }, [selectedSessionId, sessions]);

  if (!available) {
    return <div className="empty-state">Cost estimate unavailable - no price table loaded.</div>;
  }

  return (
    <div className="turn-insight-layout">
      <div className="turn-insight-toprow">
        <TurnDistributionPlot sessions={sessions} onInspectSession={setSelectedSessionId} selectedSessionId={selectedSessionId} />
        <TurnDistributionGuide sessions={sessions} />
      </div>
      <TurnOutlierInspector session={selectedSession} onOpenSession={onOpenSession} />
    </div>
  );
}

export default function SessionInsights({ payload, onOpenSession, available }: Props) {
  const [mode, setMode] = useState<Mode>("spend");
  const rows = useMemo(() => {
    if (mode === "turn") return turnDistributionSessions(payload.sessions, 12);
    return payload.sessions.slice(0, 12);
  }, [mode, payload.sessions]);

  if (!available) {
    return <div className="empty-state">Cost estimate unavailable - no price table loaded.</div>;
  }

  return (
    <div className="session-insights">
      <div className="segmented-control" role="tablist" aria-label="Session insight mode">
        {MODES.map((item) => (
          <button
            key={item.key}
            type="button"
            className={mode === item.key ? "active" : ""}
            aria-selected={mode === item.key}
            onClick={() => setMode(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="empty-state">No sessions in range.</div>
      ) : (
        <ul className="session-insight-list">
          {rows.map((session) => (
            <li key={session.id}>
              <button type="button" onClick={() => onOpenSession(session.id)}>
                <span className="sil-main">
                  <span className="sil-title"><Blurred>{session.title || session.session_id}</Blurred></span>
                  <span className="sil-meta"><Blurred>{metaLabel(session, mode)}</Blurred></span>
                  {badges(session).length > 0 && (
                    <span className="sil-badges">
                      {badges(session).map((badge) => <i key={badge}>{badge}</i>)}
                    </span>
                  )}
                </span>
                <b>{metricLabel(session, mode)}</b>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
