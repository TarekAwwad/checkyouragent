import type React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Board from "./TriageBoard";
import type { Project, SessionCard } from "../api/types";
import { TestScopeProvider } from "../shell/TestScopeProvider";
import type { DateRange } from "../shell/dateRange";

// The board reads project and range from the shared scope; this wrapper keeps
// the existing render calls readable.
function TriageBoard({ projects, range, ...props }: React.ComponentProps<typeof Board> & {
  projects: Project[];
  range?: DateRange;
}) {
  return (
    <TestScopeProvider projects={projects.map((p) => ({ id: p.id, name: p.display_name }))} range={range}>
      <Board {...props} />
    </TestScopeProvider>
  );
}

function s(partial: Partial<SessionCard>): SessionCard {
  return {
    id: 1, project_id: 1, project_name: "Hermes", session_id: "abc12345", title: null,
    first_ts: null, last_ts: null, cwd: null, version: null, entrypoint: null,
    git_branch: null, event_count: 0, turn_count: 0, tool_call_count: 0,
    subagent_count: 0, error_count: 0, system_count: 0, persisted_output_count: 0,
    input_tokens: 0, output_tokens: 0,
    duration_seconds: 0, max_agent_events: 0, finding_count: 0,
    top_finding_title: null, top_finding_basis: null,
    cost_usd: 0, cost_available: true, ...partial,
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

    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("");
    expect(screen.getByText(/herm0001/)).toBeInTheDocument();
    expect(screen.getByText(/dash0002/)).toBeInTheDocument();
  });

  it("preserves search and project filtering", () => {
    const projectOptions: Project[] = [
      { id: 1, export_name: "Hermes", display_name: "Hermes", inferred_cwd: null, session_count: 1, event_count: 0, subagent_count: 0 },
      { id: 2, export_name: "Dashboard", display_name: "Dashboard", inferred_cwd: null, session_count: 1, event_count: 0, subagent_count: 0 },
    ];
    const sessions = [
      s({ id: 1, project_id: 1, project_name: "Hermes", session_id: "herm0001", title: "Refactor parser" }),
      s({ id: 2, project_id: 2, project_name: "Dashboard", session_id: "dash0002", title: "Build charts" }),
    ];

    render(<TriageBoard projects={projectOptions} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText("Search sessions"), { target: { value: "charts" } });
    expect(screen.getByText("Build charts")).toBeInTheDocument();
    expect(screen.queryByText("Refactor parser")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search sessions"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "1" } });
    expect(screen.getByText("Refactor parser")).toBeInTheDocument();
    expect(screen.queryByText("Build charts")).not.toBeInTheDocument();
  });

  it("keeps Errors only based on observed errors, not system events", () => {
    const sessions = [
      s({ id: 1, session_id: "system11", system_count: 8 }),
      s({ id: 2, session_id: "error222", error_count: 1 }),
    ];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Errors only" }));

    expect(screen.getByText(/error222/)).toBeInTheDocument();
    expect(screen.queryByText(/system11/)).not.toBeInTheDocument();
  });

  it("sorts the newest session into the first row by default", () => {
    const sessions = [
      s({ id: 1, session_id: "newer111", first_ts: "2026-06-03T10:00:00Z" }),
      s({
        id: 2,
        session_id: "older222",
        first_ts: "2026-06-01T10:00:00Z",
        event_count: 500,
        error_count: 30,
      }),
    ];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);
    const rows = screen.getAllByRole("row").slice(1); // skip header
    expect(within(rows[0]).getByText(/newer111/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sort sessions" })).toHaveValue("first_ts");
  });

  it("offers exactly the supported session sorts", () => {
    render(<TriageBoard projects={projects} sessions={[s({})]} loading={false} onOpenSession={() => {}} />);

    const options = within(screen.getByRole("combobox", { name: "Sort sessions" }))
      .getAllByRole("option")
      .map((option) => ({ value: (option as HTMLOptionElement).value, label: option.textContent }));

    expect(options).toEqual([
      { value: "first_ts", label: "Newest first" },
      { value: "last_ts", label: "Recently ended" },
      { value: "cost_usd", label: "Highest estimated API-equivalent cost" },
      { value: "error_count", label: "Most observed errors" },
      { value: "finding_count", label: "Supported finding" },
      { value: "event_count", label: "Highest event volume" },
      { value: "subagent_count", label: "Most subagents" },
    ]);
  });

  it("calls onOpenSession when a row is clicked", () => {
    const onOpen = vi.fn();
    const sessions = [s({ id: 7, session_id: "open7777" })];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={onOpen} />);
    fireEvent.click(screen.getByText(/open7777/));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }));
  });

  it("sorts by observed errors using the explicit sort control", () => {
    const sessions = [
      s({ id: 1, session_id: "clean111", system_count: 20 }),
      s({ id: 2, session_id: "error222", error_count: 2 }),
    ];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "error_count" } });

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/error222/)).toBeInTheDocument();
  });

  it("sorts by the displayed subagent count", () => {
    const sessions = [
      s({ id: 1, session_id: "fan11111", subagent_count: 1, max_agent_events: 200 }),
      s({ id: 2, session_id: "fan99999", subagent_count: 9, max_agent_events: 5 }),
    ];

    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "subagent_count" } });

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/fan99999/)).toBeInTheDocument();
  });

  it("renders and sorts by supported finding count", () => {
    const sessions = [
      s({ id: 1, session_id: "plain111" }),
      s({
        id: 2,
        session_id: "find9999",
        finding_count: 2,
        top_finding_title: "Repeated identical failure",
        top_finding_basis: "observed",
      }),
    ];

    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Sort sessions" }), { target: { value: "finding_count" } });

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/find9999/)).toBeInTheDocument();
    expect(within(rows[0]).getByText("Repeated identical failure")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Observed · 2 findings")).toBeInTheDocument();
  });

  it("shows each session's estimated cost", () => {
    const sessions = [s({ id: 1, session_id: "cost1234", cost_usd: 12.34 })];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);
    const row = screen.getAllByRole("row").slice(1)[0];
    expect(within(row).getByText("$12.34")).toBeInTheDocument();
  });

  it("shows the session start timestamp in the Sessions table", () => {
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
      new Date(firstTs).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
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

  it("shows the session end timestamp in the Sessions table", () => {
    const lastTs = "2026-06-03T11:30:00Z";
    render(
      <TriageBoard
        projects={projects}
        sessions={[s({ last_ts: lastTs })]}
        loading={false}
        onOpenSession={() => {}}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Ended" })).toBeInTheDocument();
    const timestamp = screen.getByText(
      new Date(lastTs).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
    );
    expect(timestamp).toHaveAttribute("datetime", lastTs);
  });

  it("sorts sessions by most recently ended from the Ended column", () => {
    const sessions = [
      s({ id: 1, session_id: "older111", last_ts: "2026-06-01T10:00:00Z" }),
      s({ id: 2, session_id: "undated2", last_ts: null }),
      s({ id: 3, session_id: "newer333", last_ts: "2026-06-03T10:00:00Z" }),
    ];
    render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    fireEvent.click(screen.getByRole("columnheader", { name: "Ended" }));

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText(/newer333/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/older111/)).toBeInTheDocument();
    expect(within(rows[2]).getByText(/undated2/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Sort sessions" })).toHaveValue("last_ts");
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

    const summary = screen.getByLabelText("Session totals");
    expect(within(summary).getByText("$1.75")).toBeInTheDocument();
  });

  it("removes risk and loop concepts while keeping observed activity metadata", () => {
    const sessions = [
      s({
        id: 1,
        session_id: "noisy001",
        event_count: 500,
        error_count: 30,
        system_count: 7,
        subagent_count: 6,
      }),
    ];
    const { container } = render(<TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={() => {}} />);

    expect(screen.queryByRole("columnheader", { name: "Risk" })).not.toBeInTheDocument();
    expect(screen.queryByText("Highest risk")).not.toBeInTheDocument();
    expect(screen.queryByText("Largest loop")).not.toBeInTheDocument();
    expect(screen.queryByText("Loop activity")).not.toBeInTheDocument();
    expect(screen.queryByText("x12 loop")).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="risk-score"]')).toBeNull();
    expect(container.querySelector('[data-testid="risk-bar"]')).toBeNull();
    expect(container.querySelector('[data-testid="risk-seg"]')).toBeNull();

    expect(screen.getByRole("columnheader", { name: "Supported finding" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Impact" })).toBeInTheDocument();
    expect(screen.getByText("30 errors")).toBeInTheDocument();
    expect(screen.getByText("6 subagents")).toBeInTheDocument();
    expect(screen.queryByText("6 fanout")).not.toBeInTheDocument();
    expect(screen.getByText("500 events")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Investigate" })).toBeInTheDocument();
  });

  it("keeps system events separate from observed errors and never calls them alerts", () => {
    render(
      <TriageBoard
        projects={projects}
        sessions={[s({ error_count: 2, system_count: 7 })]}
        loading={false}
        onOpenSession={() => {}}
      />,
    );

    const totals = screen.getByLabelText("Session totals");
    expect(within(totals).getByText("Observed errors").closest(".cost-insight")).toHaveTextContent("2");
    expect(screen.queryByText(/alert events/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/9 observed errors/i)).not.toBeInTheDocument();
  });

  it("shows subagent activity as neutral metadata, never as a fallback issue", () => {
    render(
      <TriageBoard
        projects={projects}
        sessions={[s({ subagent_count: 4 })]}
        loading={false}
        onOpenSession={() => {}}
      />,
    );

    expect(screen.getByText("4 subagents")).toBeInTheDocument();
    expect(screen.queryByText("Delegated work")).not.toBeInTheDocument();
    expect(screen.getByText("No supported finding detected")).toBeInTheDocument();
    expect(screen.queryByText("No immediate issue")).not.toBeInTheDocument();
  });

  it("lists sessions with any activity in the shared range", () => {
    const sessions = [
      s({ id: 1, session_id: "before01", first_ts: "2026-05-30T08:00:00Z", last_ts: "2026-05-31T08:00:00Z" }),
      s({ id: 2, session_id: "straddle", first_ts: "2026-05-31T20:00:00Z", last_ts: "2026-06-01T12:00:00Z" }),
      s({ id: 3, session_id: "inside03", first_ts: "2026-06-02T08:00:00Z", last_ts: "2026-06-02T09:00:00Z" }),
      s({ id: 4, session_id: "after004", first_ts: "2026-06-04T08:00:00Z", last_ts: "2026-06-04T09:00:00Z" }),
    ];
    render(
      <TriageBoard projects={projects} sessions={sessions} loading={false} onOpenSession={vi.fn()}
                   range={{ preset: "custom", from: "2026-06-01", to: "2026-06-02" }} />,
    );
    expect(screen.queryByText(/before01/)).not.toBeInTheDocument();
    expect(screen.getByText(/straddle/)).toBeInTheDocument();
    expect(screen.getByText(/inside03/)).toBeInTheDocument();
    expect(screen.queryByText(/after004/)).not.toBeInTheDocument();
  });

  it("keeps search, errors and sort in the header", () => {
    render(<TriageBoard projects={projects} sessions={[s({})]} loading={false} onOpenSession={() => {}} />);
    expect(within(screen.getByRole("group", { name: "Filters" })).getByPlaceholderText("Search sessions"))
      .toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Filters" })).getByLabelText("Errors only")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "View" })).getByLabelText("Sort sessions")).toBeInTheDocument();
  });
});
