import { describe, expect, it } from "vitest";
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

describe("riskScore", () => {
  it("is zero for a calm session", () => {
    expect(riskScore(session({}))).toBe(0);
  });

  it("ranks an error-heavy session above a calm one", () => {
    const calm = riskScore(session({ event_count: 100 }));
    const noisy = riskScore(session({ event_count: 100, error_count: 20, loop_count: 3 }));
    expect(noisy).toBeGreaterThan(calm);
  });

  it("breakdown exposes each weighted component", () => {
    const parts = riskBreakdown(session({ error_count: 10, loop_count: 2 }));
    expect(parts.map((p) => p.key).sort()).toEqual(
      ["alerts", "cost", "fanout", "loops", "patterns"],
    );
    expect(parts.every((p) => typeof p.value === "number")).toBe(true);
  });

  it("treats system events as alert-colored risk markers", () => {
    const parts = riskBreakdown(session({ system_count: 4 }));
    const alerts = parts.find((p) => p.key === "alerts");

    expect(alerts?.label).toBe("Alerts");
    expect(alerts?.value).toBeGreaterThan(0);
  });

  it("includes duration in the cost component", () => {
    const parts = riskBreakdown(session({ duration_seconds: 3600 }));
    const cost = parts.find((p) => p.key === "cost");

    expect(cost?.value).toBeGreaterThan(0);
  });

  it("includes token totals in the cost component", () => {
    const parts = riskBreakdown(session({ input_tokens: 60_000, output_tokens: 60_000 }));
    const cost = parts.find((p) => p.key === "cost");

    expect(cost?.value).toBeGreaterThan(0);
  });

  it("includes backend pattern findings in the risk components", () => {
    const parts = riskBreakdown(session({ pattern_risk_score: 12, finding_count: 2 }));
    const patterns = parts.find((p) => p.key === "patterns");

    expect(patterns?.label).toBe("Patterns");
    expect(patterns?.value).toBeGreaterThan(0);
  });
});

describe("riskClass", () => {
  it("flags scores at or above 6 as high", () => {
    expect(riskClass(6)).toBe("g-hi");
    expect(riskClass(9.2)).toBe("g-hi");
  });

  it("flags scores in the 3-to-6 band as medium", () => {
    expect(riskClass(3)).toBe("g-md");
    expect(riskClass(5.9)).toBe("g-md");
  });

  it("flags scores below 3 as low", () => {
    expect(riskClass(2.9)).toBe("g-lo");
    expect(riskClass(0)).toBe("g-lo");
  });
});
