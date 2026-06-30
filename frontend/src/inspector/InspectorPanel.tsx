import React from "react";
import { AlertTriangle, Braces, Link2, Loader2, Repeat } from "lucide-react";
import type { EventDetail, RiskFinding, SessionCard, Subagent } from "../api/types";
import type { LoopContext } from "../trace/loopContext";
import { loopExplanation } from "../trace/loopContext";
import { Blurred } from "../shell/Blurred";

interface Props {
  session: SessionCard;
  event: EventDetail | undefined;
  loopContext?: LoopContext;
  subagents: Subagent[];
  findings?: RiskFinding[];
  loading: boolean;
  onSelectEvent?: (eventId: number) => void;
}

type Tab = "event" | "subagents" | "findings";

function formatCategory(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function InspectorPanel({ event, loopContext, subagents, findings = [], loading, onSelectEvent }: Props) {
  const [tab, setTab] = React.useState<Tab>("event");

  return (
    <aside className="inspector-panel">
      <div className="inspector-tabs">
        <button className={tab === "event" ? "on" : ""} onClick={() => setTab("event")}>Event</button>
        <button className={tab === "subagents" ? "on" : ""} onClick={() => setTab("subagents")}>Subagents</button>
        <button className={tab === "findings" ? "on" : ""} onClick={() => setTab("findings")}>Findings</button>
        {loading && <Loader2 size={15} className="spin" />}
      </div>

      <Blurred as="div">
      {tab === "event" && (
        <section className="inspect-section">
          {!event && <p className="muted">Select a timeline item or trace span.</p>}
          {event && (
            <>
              <h3>Selected event</h3>
              <dl>
                <dt>Type</dt><dd><span className="kind-tag">{event.type}</span></dd>
                <dt>Role</dt><dd>{event.role || "none"}</dd>
                <dt>Time</dt><dd>{event.timestamp ? new Date(event.timestamp).toLocaleString() : "unknown"}</dd>
                <dt>Source</dt><dd>{event.source_path}:{event.line_no}</dd>
                <dt>Agent</dt><dd>{event.agent_id || "parent session"}</dd>
              </dl>
              {loopContext && (
                <div className="loop-evidence-panel">
                  <p><Repeat size={14} /> Loop evidence</p>
                  <dl>
                    <dt>Why</dt><dd>{loopExplanation(loopContext)}</dd>
                    <dt>Tool</dt><dd>{loopContext.toolName}</dd>
                    <dt>Position</dt><dd>{loopContext.position} of {loopContext.count}</dd>
                  </dl>
                </div>
              )}
              {event.text_preview && <p className="event-preview">{event.text_preview}</p>}
              {event.tool_calls.length > 0 && <Evidence title="Tool Calls" rows={event.tool_calls} />}
              {event.tool_results.length > 0 && <Evidence title="Tool Results" rows={event.tool_results} />}
              {event.related_event_ids.length > 0 && (
                <p className="related"><Link2 size={14} /> Related events: {event.related_event_ids.join(", ")}</p>
              )}
              {event.raw_json && (
                <details className="raw-json">
                  <summary><Braces size={14} /> Raw JSON</summary>
                  <pre>{JSON.stringify(event.raw_json, null, 2)}</pre>
                </details>
              )}
            </>
          )}
        </section>
      )}

      {tab === "subagents" && (
        <section className="inspect-section">
          <h3>Subagents · {subagents.length}</h3>
          {subagents.length === 0 ? (
            <p className="muted">No subagents recorded.</p>
          ) : (
            <div className="subagent-list">
              {subagents.slice(0, 12).map((agent) => (
                <details key={agent.id}>
                  <summary>
                    <span>{agent.agent_type || "Agent"}</span>
                    <b>{agent.event_count}</b>
                  </summary>
                  <p>{agent.description || agent.name || agent.agent_id}</p>
                  <small>{agent.agent_id}</small>
                </details>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "findings" && (
        <section className="inspect-section">
          <h3>Findings Â· {findings.length}</h3>
          {findings.length === 0 ? (
            <p className="muted">No risk pattern findings recorded.</p>
          ) : (
            <div className="finding-list">
              {findings.map((finding) => (
                <article key={finding.id} className={`finding-card sev-${finding.severity}`}>
                  <div className="finding-card-head">
                    <span>{formatCategory(finding.category)}</span>
                    <b>{finding.severity}</b>
                  </div>
                  <h4>{finding.title}</h4>
                  <p>{finding.explanation}</p>
                  <div className="finding-metrics">
                    <span>score {finding.score.toFixed(1)}</span>
                    <span>lift {finding.lift.toFixed(2)}</span>
                    <span>support {finding.positive_support}/{finding.support}</span>
                  </div>
                  {finding.pattern.length > 0 && (
                    <ol className="finding-pattern" aria-label={`Pattern for ${finding.title}`}>
                      {finding.pattern.map((symbol, index) => (
                        <li key={`${finding.id}-${index}`}>{symbol}</li>
                      ))}
                    </ol>
                  )}
                  {(finding.start_event_id || finding.end_event_id) && (
                    <div className="finding-jumps">
                      {finding.start_event_id && (
                        <button type="button" onClick={() => onSelectEvent?.(finding.start_event_id as number)}>
                          Start event {finding.start_event_id}
                        </button>
                      )}
                      {finding.end_event_id && finding.end_event_id !== finding.start_event_id && (
                        <button type="button" onClick={() => onSelectEvent?.(finding.end_event_id as number)}>
                          End event {finding.end_event_id}
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      </Blurred>
    </aside>
  );
}

function Evidence({ title, rows }: { title: string; rows: Array<Record<string, unknown>> }) {
  return (
    <details className="evidence" open>
      <summary><AlertTriangle size={14} /> {title}</summary>
      {rows.map((row, index) => (
        <pre key={index}>{JSON.stringify(row, null, 2)}</pre>
      ))}
    </details>
  );
}

export default InspectorPanel;
