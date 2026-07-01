import { type MouseEvent, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Blurred } from "../shell/Blurred";
import {
  type ContributionSession,
  compactInt,
  formatDuration,
  prettyModel,
  prettySymbol,
} from "./specimen";

const SEQ_PREVIEW = 32;

interface Props {
  sample: ContributionSession;
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  blurRaw?: boolean;
}

// The literal first session that would be sent, shown in a modal: an annotated
// reading by default and the raw JSON it is derived from on demand. Uses the
// native <dialog> element (focus trap, Esc-to-close, backdrop) like the glossary.
export default function SpecimenModal({
  sample,
  open,
  onClose,
  title = "First exported session",
  description = "The exact first session in the bundle, shown as structured fields or raw JSON.",
  blurRaw = false,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [raw, setRaw] = useState(false);

  // Drive the dialog's modal state from the `open` prop, resetting to the
  // annotated view on each open so it never reopens showing stale raw JSON.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setRaw(false);
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Clicking the backdrop registers as a click on the <dialog> itself (its
  // children sit in the inner panel), so close when the target is the dialog.
  const handleClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) onClose();
  };

  const models = sample.models ?? [];
  const stats = sample.stats;
  const stopReasons = Object.entries(sample.stop_reasons ?? {});
  const risks = sample.risk_categories ?? [];
  const subagents = sample.subagents ?? [];
  const sequence = sample.sequence ?? [];

  // Aggregate subagents by type so repeated agents read as one compact row.
  const subagentGroups = Object.values(
    subagents.reduce<Record<string, { agent_type: string; agents: number; events: number }>>((acc, s) => {
      const group = acc[s.agent_type] || { agent_type: s.agent_type, agents: 0, events: 0 };
      group.agents += 1;
      group.events += s.event_count;
      acc[s.agent_type] = group;
      return acc;
    }, {}),
  );

  const activity: Array<[string, number | undefined]> = [
    ["turns", stats?.turns],
    ["tool calls", stats?.tool_calls],
    ["subagents", stats?.subagents],
    ["errors", stats?.errors],
    ["loops", stats?.loops],
  ];
  const activityShown = activity.filter(([, value]) => value !== undefined);

  return (
    <dialog
      ref={ref}
      className="specimen-dialog"
      aria-labelledby="specimen-title"
      onClose={onClose}
      onClick={handleClick}
    >
      <div className="specimen-panel">
        <div className="specimen-modal-head">
          <div className="specimen-title">
            <h2 id="specimen-title">{title}</h2>
            <p>{description}</p>
          </div>
          <div className="specimen-modal-tools">
            <div className="seg" role="group" aria-label="Specimen view">
              <button
                type="button"
                className={!raw ? "is-on" : ""}
                aria-pressed={!raw}
                onClick={() => setRaw(false)}
              >
                Annotated
              </button>
              <button
                type="button"
                className={raw ? "is-on" : ""}
                aria-pressed={raw}
                onClick={() => setRaw(true)}
              >
                Raw JSON
              </button>
            </div>
            <button
              type="button"
              className="specimen-close"
              aria-label="Close specimen"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="specimen-modal-body">
          {raw ? (
            <pre className="specimen-raw" aria-label="Raw specimen JSON">
              {blurRaw ? <Blurred>{JSON.stringify(sample, null, 2)}</Blurred> : JSON.stringify(sample, null, 2)}
            </pre>
          ) : (
            <>
              <dl className="specimen-facts">
                {models.length > 0 && (
                  <div>
                    <dt>Model</dt>
                    <dd>{models.map(prettyModel).join(", ")}</dd>
                  </div>
                )}
                {sample.first_date && (
                  <div>
                    <dt>Date</dt>
                    <dd>
                      {sample.first_date}
                      {sample.duration_s ? ` / ${formatDuration(sample.duration_s)}` : ""}
                    </dd>
                  </div>
                )}
                {sample.tokens && (
                  <div>
                    <dt>Tokens</dt>
                    <dd>
                      {compactInt(sample.tokens.input ?? 0)} in / {compactInt(sample.tokens.output ?? 0)} out
                      {sample.tokens.cache_read ? ` / ${compactInt(sample.tokens.cache_read)} cache` : ""}
                    </dd>
                  </div>
                )}
                {activityShown.length > 0 && (
                  <div>
                    <dt>Activity</dt>
                    <dd>{activityShown.map(([key, value]) => `${compactInt(value ?? 0)} ${key}`).join(" / ")}</dd>
                  </div>
                )}
                {stopReasons.length > 0 && (
                  <div>
                    <dt>Stop reasons</dt>
                    <dd className="chips">
                      {stopReasons.map(([key, value]) => (
                        <span className="chip" key={key}>
                          {key} <em>x{value}</em>
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
                {subagentGroups.length > 0 && (
                  <div>
                    <dt>Subagents</dt>
                    <dd className="chips">
                      {subagentGroups.map((group) => (
                        <span className="chip" key={group.agent_type}>
                          {group.agent_type} <em>x{group.agents}</em>
                          {group.events ? ` / ${compactInt(group.events)} ev` : ""}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
                {risks.length > 0 && (
                  <div>
                    <dt>Risk categories</dt>
                    <dd className="chips">
                      {risks.map((risk) => (
                        <span className="chip is-risk" key={risk}>
                          {risk}
                        </span>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>

              {sequence.length > 0 && (
                <div className="seq">
                  <div className="seq-label">
                    Tool / event sequence <em>{sequence.length} steps</em>
                  </div>
                  <ol className="seq-strand" aria-label="Event sequence">
                    {sequence.slice(0, SEQ_PREVIEW).map((step, index) => {
                      const { label, kind } = prettySymbol(step.sym);
                      return (
                        <li className={`seq-chip k-${kind}`} key={index} title={step.sym}>
                          {label}
                        </li>
                      );
                    })}
                    {sequence.length > SEQ_PREVIEW && (
                      <li className="seq-more">+{sequence.length - SEQ_PREVIEW} more</li>
                    )}
                  </ol>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
