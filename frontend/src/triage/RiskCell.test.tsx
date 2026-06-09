import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RiskCell from "./RiskCell";
import { riskScore, riskBreakdown, riskClass } from "./riskScore";
import type { SessionCard } from "../api/types";

function session(partial: Partial<SessionCard>): SessionCard {
  return {
    id: 1, project_id: 1, project_name: "p", session_id: "s", title: null,
    first_ts: null, last_ts: null, cwd: null, version: null, entrypoint: null,
    git_branch: null, event_count: 0, turn_count: 0, tool_call_count: 0,
    subagent_count: 0, error_count: 0, system_count: 0, persisted_output_count: 0,
    input_tokens: 0, output_tokens: 0, loop_count: 0, max_repeat: 0,
    duration_seconds: 0, max_agent_events: 0, finding_count: 0,
    pattern_risk_score: 0, top_finding_category: null, top_finding_severity: null,
    top_finding_title: null, cost_usd: 0, cost_available: true, ...partial,
  };
}

// A session that lights up several risk signals at once.
const noisy = session({
  event_count: 500, error_count: 30, system_count: 5,
  loop_count: 4, max_repeat: 12, subagent_count: 6, max_agent_events: 300,
  input_tokens: 60_000, output_tokens: 60_000, duration_seconds: 3600,
  pattern_risk_score: 9, finding_count: 3,
});

function visibleKeys(s: SessionCard): string[] {
  const parts = riskBreakdown(s);
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return parts.filter((p) => p.value / total >= 0.08).map((p) => p.key);
}

describe("RiskCell", () => {
  it("renders the score to one decimal with its severity tier class", () => {
    const { getByTestId } = render(<RiskCell session={noisy} />);
    const score = getByTestId("risk-score");

    expect(score.textContent).toBe(riskScore(noisy).toFixed(1));
    expect(score.className).toContain(riskClass(riskScore(noisy)));
  });

  it("shows a flat calm track and no segments for a low-risk session", () => {
    const { getByTestId, queryAllByTestId } = render(<RiskCell session={session({})} />);

    expect(getByTestId("risk-bar").className).toContain("calm");
    expect(queryAllByTestId("risk-seg")).toHaveLength(0);
  });

  it("renders exactly the signals at or above 8% share, in breakdown order", () => {
    const { getAllByTestId } = render(<RiskCell session={noisy} />);
    const keys = getAllByTestId("risk-seg").map((el) => el.getAttribute("data-key"));

    expect(keys).toEqual(visibleKeys(noisy));
  });

  it("drops a signal contributing below the 8% threshold", () => {
    // Alerts and loops carry the risk; a single subagent fork is a tiny sliver dropped.
    const lopsided = session({ error_count: 40, loop_count: 5, max_repeat: 12, subagent_count: 1 });
    const { getAllByTestId } = render(<RiskCell session={lopsided} />);
    const keys = getAllByTestId("risk-seg").map((el) => el.getAttribute("data-key"));

    expect(keys).toContain("alerts");
    expect(keys).not.toContain("fanout");
  });

  it("gives the bar an accessible label naming the dominant signal", () => {
    const alertDriven = session({ error_count: 60, system_count: 10, loop_count: 2, max_repeat: 4 });
    const { getByTestId } = render(<RiskCell session={alertDriven} />);

    expect(getByTestId("risk-bar").getAttribute("aria-label")).toMatch(/Alerts \d+%/);
  });
});
