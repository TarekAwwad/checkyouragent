import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import InspectorPanel from "./InspectorPanel";
import type { EventDetail, RiskFinding, SessionCard, Subagent } from "../api/types";

const session = { event_count: 10, tool_call_count: 2, subagent_count: 1, error_count: 0, system_count: 0,
  session_id: "s1", title: "Sess" } as unknown as SessionCard;

const event = { type: "tool_call", role: "assistant", timestamp: "2026-01-01T00:00:00Z",
  source_path: "x.jsonl", line_no: 5, agent_id: null, text_preview: "hi",
  tool_calls: [], tool_results: [], related_event_ids: [], raw_json: { a: 1 } } as unknown as EventDetail;

const subagents = [{ id: 1, agent_type: "explore", event_count: 12, description: "find things", name: null, agent_id: "ag1" }] as unknown as Subagent[];
const findings = [{
  id: 1,
  session_id: 1,
  severity: "high",
  category: "failed_verification_repair_loop",
  title: "Failed verification",
  explanation: "test failed before an edit",
  pattern: ["CALL:Bash:test", "RESULT:error:exit1"],
  support: 3,
  positive_support: 2,
  negative_support: 1,
  lift: 1.7,
  score: 4.2,
  start_event_id: 10,
  end_event_id: 12,
  evidence: {},
}] satisfies RiskFinding[];

describe("InspectorPanel tabs", () => {
  it("shows the Event tab by default and switches to Subagents", () => {
    render(<InspectorPanel session={session} event={event} subagents={subagents} loading={false} />);

    expect(screen.getByText("tool_call")).toBeInTheDocument();
    expect(screen.queryByText("find things")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Subagents" }));

    expect(screen.getByText("find things")).toBeInTheDocument();
    expect(screen.queryByText("tool_call")).not.toBeInTheDocument();
  });

  it("shows findings and selects their event bounds", () => {
    const onSelectEvent = vi.fn();
    render(
      <InspectorPanel
        session={session}
        event={event}
        subagents={subagents}
        findings={findings}
        loading={false}
        onSelectEvent={onSelectEvent}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Findings" }));

    expect(screen.getByText("Failed verification")).toBeInTheDocument();
    expect(screen.getByText("CALL:Bash:test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start event 10" }));
    expect(onSelectEvent).toHaveBeenCalledWith(10);
  });
});
