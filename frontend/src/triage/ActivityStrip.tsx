interface Props {
  events: number;
  alerts: number;
  loops: number;
  subagents: number;
}

// A compact "EKG" summary: baseline density bar with alert ticks, a loop band,
// and subagent fork marks. Positions are derived deterministically from counts
// (this is a per-session summary, not a true time axis — the trace view has that).
function ActivityStrip({ events, alerts, loops, subagents }: Props) {
  const W = 220;
  const H = 26;
  const density = Math.min(1, events / 1000);
  const alertTicks = Math.min(alerts, 12);
  const forks = Math.min(subagents, 8);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="activity" className="ekg">
      <rect width={W} height={H} fill="var(--track)" rx={4} />
      <rect x={0} y={H / 2 - 1} width={W * density} height={2} className="ekg-density" />
      {loops > 0 && (
        <rect data-testid="loop-band" x={W * 0.35} y={3} width={W * 0.3} height={H - 6} className="ekg-loop" />
      )}
      {Array.from({ length: alertTicks }).map((_, i) => (
        <line key={`a${i}`} data-testid="alert-tick"
          x1={W * 0.6 + i * 4} y1={3} x2={W * 0.6 + i * 4} y2={H - 3}
          className="ekg-alert" strokeWidth={1.5} />
      ))}
      {Array.from({ length: forks }).map((_, i) => (
        <line key={`f${i}`} data-testid="fork-mark"
          x1={W * 0.15 + i * 14} y1={H - 4} x2={W * 0.15 + i * 14 + 6} y2={5}
          className="ekg-fork" strokeWidth={1.5} />
      ))}
    </svg>
  );
}

export default ActivityStrip;
