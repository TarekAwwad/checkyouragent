import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TriageBoard from "./TriageBoard";
import type { Project, SessionCard } from "../api/types";

function s(partial: Partial<SessionCard>): SessionCard {
  return {
    id: 1, project_id: 1, project_name: "Hermes", session_id: "abc12345", title: null,
    first_ts: null, last_ts: null, cwd: null, version: null, entrypoint: null,
    git_branch: null, event_count: 0, turn_count: 0, tool_call_count: 0,
    subagent_count: 0, error_count: 0, system_count: 0, persisted_output_count: 0,
    input_tokens: 0, output_tokens: 0, loop_count: 0, max_repeat: 0,
    duration_seconds: 0, max_agent_events: 0, finding_count: 0,
    pattern_risk_score: 0, top_finding_category: null, top_finding_severity: null,
    top_finding_title: null, cost_usd: 0, cost_available: true, ...partial,
  };
}

const projects: Project[] = [
  { id: 1, export_name: "Hermes", display_name: "Hermes", inferred_cwd: null, session_count: 2, event_count: 0, subagent_count: 0, cost_usd: 0, cost_available: true },
];

describe("TriageBoard", () => {
  it("selects all projects by default once projects are available", () => {
    const projectOptions: Project[] = [
      { id: 1, export_name: "Hermes", display_name: "Hermes", inferred_cwd: null, session_count: 1, event_count: 0, subagent_count: 0 },
      { id: 2, export_name: "Dashboard", display_name: "Dashboard", inferred_cwd: null, session_count: 1, event_count: 0, subagent_count: 0 },
    ];
    const sessions = [
      s({ id: 1, project_id: 1, project_name: "Hermes", session_id: "herm0001" }),
      s({ id: 2, project_id: 2, project_name: "Dashboard", session_id: "dash0002" }),
    ];

    render(<TriageBoard projects={projectOptions} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("all");
    expect(screen.getByText(/herm0001/)).toBeInTheDocument();
    expect(screen.getByText(/dash0002/)).toBeInTheDocument();
  });

  it("sorts the highest-risk session into the first row by default", () => {
    const sessions = [
      s({ id: 1, session_id: "calm0000", event_count: 50 }),
      s({ id: 2, session_id: "risky111", event_count: 500, error_count: 30, loop_count: 4, max_repeat: 12 }),
    ];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);
    const rows = screen.getAllByRole("row").slice(1); // skip header
    expect(within(rows[0]).getByText(/risky111/)).toBeInTheDocument();
  });

  it("calls onOpenSession when a row is clicked", () => {
    const onOpen = vi.fn();
    const sessions = [s({ id: 7, session_id: "open7777" })];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={onOpen} />);
    fireEvent.click(screen.getByText(/open7777/));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
  });

  it("re-sorts by a signal using the explicit sort control", () => {
    const sessions = [
      s({ id: 1, session_id: "loop9999", loop_count: 8, max_repeat: 12 }),
      s({ id: 2, session_id: "error222", error_count: 2 }),
    ];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "error_count" } });

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/error222/)).toBeInTheDocument();
  });

  it("sorts fanout by the displayed subagent count", () => {
    const sessions = [
      s({ id: 1, session_id: "fan11111", subagent_count: 1, max_agent_events: 200 }),
      s({ id: 2, session_id: "fan99999", subagent_count: 9, max_agent_events: 5 }),
    ];

    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "subagent_count" } });

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/fan99999/)).toBeInTheDocument();
  });

  it("sorts loops by the displayed repeat count", () => {
    const sessions = [
      s({ id: 1, session_id: "loop4444", loop_count: 10, max_repeat: 4 }),
      s({ id: 2, session_id: "loop9999", loop_count: 2, max_repeat: 9 }),
    ];

    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "max_repeat" } });

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/loop9999/)).toBeInTheDocument();
  });

  it("renders and sorts by pattern findings", () => {
    const sessions = [
      s({ id: 1, session_id: "plain111" }),
      s({
        id: 2,
        session_id: "find9999",
        finding_count: 2,
        pattern_risk_score: 9,
        top_finding_category: "failed_verification_repair_loop",
        top_finding_severity: "high",
        top_finding_title: "Failed verification",
      }),
    ];

    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "patterns" } });

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/find9999/)).toBeInTheDocument();
    expect(within(rows[0]).getByText("Failed verification")).toBeInTheDocument();
  });

  it("shows each session's estimated cost", () => {
    const sessions = [s({ id: 1, session_id: "cost1234", cost_usd: 12.34 })];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);
    const row = screen.getAllByRole("row").slice(1)[0];
    expect(within(row).getByText("$12.34")).toBeInTheDocument();
  });

  it("shows the session start timestamp in the overview table", () => {
    const firstTs = "2026-06-03T10:00:00Z";
    render(
      <TriageBoard
        projects={projects}
        sessions={[s({ first_ts: firstTs })]}
        loading={false}
        onOpenSession={() => {}}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Started" })).toBeInTheDocument();
    const timestamp = screen.getByText(
      new Date(firstTs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    );
    expect(timestamp).toHaveAttribute("datetime", firstTs);
  });

  it("sorts sessions newest first from the Started column", () => {
    const sessions = [
      s({ id: 1, session_id: "older111", first_ts: "2026-06-01T10:00:00Z" }),
      s({ id: 2, session_id: "undated2", first_ts: null }),
      s({ id: 3, session_id: "newer333", first_ts: "2026-06-03T10:00:00Z" }),
    ];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.click(screen.getByRole("columnheader", { name: "Started" }));

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/newer333/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/older111/)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/undated2/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sort sessions" })).toHaveValue("first_ts");
  });

  it("sorts by the displayed cost when the Cost header is clicked", () => {
    const sessions = [
      s({ id: 1, session_id: "cheap111", cost_usd: 0.5 }),
      s({ id: 2, session_id: "spendy22", cost_usd: 8.75 }),
    ];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.click(screen.getByRole("columnheader", { name: "Cost" }));

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/spendy22/)).toBeInTheDocument();
  });

  it("summarizes the active project's total cost", () => {
    const projectOptions: Project[] = [
      { id: 1, export_name: "Hermes", display_name: "Hermes", inferred_cwd: null, session_count: 2, event_count: 0, subagent_count: 0, cost_usd: 1.75, cost_available: true },
    ];
    const sessions = [
      s({ id: 1, project_id: 1, project_name: "Hermes", session_id: "herm0001", cost_usd: 1.5 }),
      s({ id: 2, project_id: 1, project_name: "Hermes", session_id: "herm0002", cost_usd: 0.25 }),
    ];
    render(<TriageBoard projects={projectOptions} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    const summary = screen.getByLabelText("Project cost summary");
    expect(within(summary).getByText("$1.75")).toBeInTheDocument();
  });

  it("replaces noisy signal columns with self-explaining risk and impact cells", () => {
    const sessions = [
      s({ id: 1, session_id: "noisy001", event_count: 500, error_count: 30, loop_count: 4, max_repeat: 12, subagent_count: 6 }),
    ];
    const { container } = render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    expect(screen.queryByLabelText("Activity trace legend")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Errors" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Loops" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Fanout" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Impact" })).toBeInTheDocument();
    expect(screen.getByText("30 errors")).toBeInTheDocument();
    expect(screen.getByText("x12 loop")).toBeInTheDocument();
    expect(screen.getByText("6 fanout")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Investigate" })).toBeInTheDocument();
    expect(container.querySelector('[data-testid="risk-bar"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="risk-seg"]').length).toBeGreaterThan(0);
  });
});
