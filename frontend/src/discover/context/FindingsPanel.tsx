import React from "react";
import type { ContextArchetype, ContextFinding } from "../../api/types";
import { findingKey, formatTokens, formatUsd } from "./ContextEconomics";
import { Blurred } from "../../shell/Blurred";

const PATH_OR_URL_TOKEN =
  /(?:https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])\S+|(?:[\w.@-]+[\\/])+[\w.@-]+\.[\w.@-]+/g;

function basenameFromPathOrUrl(value: string): string | null {
  const trailing = value.match(/[),.;:]+$/)?.[0] ?? "";
  const core = trailing ? value.slice(0, -trailing.length) : value;

  try {
    const parsed = new URL(core);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const name = segments.at(-1) ?? parsed.hostname;
    return `${decodeURIComponent(name)}${trailing}`;
  } catch {
    const withoutQuery = core.split(/[?#]/, 1)[0];
    const normalized = withoutQuery.replace(/\\/g, "/").replace(/\/+$/, "");
    const name = normalized.split("/").pop();
    return name && name !== normalized ? `${name}${trailing}` : null;
  }
}

function compactFindingLabel(label: string): string {
  return label.replace(PATH_OR_URL_TOKEN, (token) => basenameFromPathOrUrl(token) ?? token);
}

/**
 * The sessions affected by the selected archetype, reusing the subgroup page's
 * right-column list (driver-list-card / driver-card). Selecting a row loads it
 * into the investigator; opening the session happens from the investigator
 * header, which deep-links to the exact event.
 */
export default function FindingsPanel({
  archetype,
  costAvailable,
  activeFindingKey,
  onSelectFinding,
}: {
  archetype: ContextArchetype;
  costAvailable: boolean;
  activeFindingKey: string | null;
  onSelectFinding: (finding: ContextFinding) => void;
}) {
  const countNote = archetype.findings_count > archetype.findings.length
    ? `top ${archetype.findings.length} of ${archetype.findings_count}`
    : `${archetype.findings_count} finding${archetype.findings_count === 1 ? "" : "s"}`;

  return (
    <aside className="driver-list-card findings-panel">
      <div className="driver-card-head">
        <h3>Sessions to explore</h3>
        <span>{countNote}</span>
      </div>
      <div className="driver-card-grid" aria-label="Findings">
        {archetype.findings.map((finding) => {
          const isActive = findingKey(finding) === activeFindingKey;
          const label = compactFindingLabel(finding.label);
          const savings = costAvailable
            ? formatUsd(finding.savings_usd)
            : formatTokens(finding.savings_tokens);
          return (
            <button
              key={findingKey(finding)}
              type="button"
              className={`driver-card${isActive ? " is-selected" : ""}`}
              onClick={() => onSelectFinding(finding)}
              aria-pressed={isActive}
            >
              <span className="driver-card-topline">
                <span title={finding.label}><Blurred>{label}</Blurred></span>
                <b>{savings}</b>
              </span>
              <strong><Blurred>{finding.session_title ?? "Untitled session"}</Blurred></strong>
              <span className="driver-card-note">
                turn {finding.entry_turn} · carried {finding.carried_turns} turn{finding.carried_turns === 1 ? "" : "s"}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
