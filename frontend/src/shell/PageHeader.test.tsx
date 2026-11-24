import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PageHeader from "./PageHeader";
import { TestScopeProvider } from "./TestScopeProvider";
import { AnalysisScopeContext } from "./analysisScope";
import { ALL_TIME } from "./dateRange";

describe("PageHeader", () => {
  it("renders the title row", () => {
    render(
      <PageHeader section="Explore" title="Subgroups" experimental subtitle="Observed associations, not causes."
                  status="Updating…" actions={<button type="button">Plan history</button>} />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Subgroups" })).toBeInTheDocument();
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("Experimental")).toBeInTheDocument();
    expect(screen.getByText("Observed associations, not causes.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Updating…");
    expect(screen.getByRole("button", { name: "Plan history" })).toBeInTheDocument();
  });

  it("shows fixed scope chips without needing a scope provider", () => {
    render(<PageHeader title="Overview" scope={{ date: "fixed", project: "fixed" }} />);
    const scope = screen.getByRole("group", { name: "Scope" });
    expect(within(scope).getByText("All time")).toBeInTheDocument();
    expect(within(scope).getByText("All projects")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("omits empty zones", () => {
    const { container } = render(<PageHeader title="Sources & sync" />);
    expect(container.querySelector(".page-header-controls")).toBeNull();
    render(<PageHeader title="Session" scope={null} filters={<input aria-label="Search" />} />);
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Filters" })).toBeInTheDocument();
  });

  it("drives the shared scope from its controls", () => {
    render(
      <TestScopeProvider projects={[{ id: 1, name: "alpha" }]} today="2026-11-24">
        <PageHeader title="Cost" scope={{ date: "filter", project: "filter" }} />
      </TestScopeProvider>,
    );
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "7d" } });
    expect(screen.getByLabelText("Date range")).toHaveValue("7d");
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "1" } });
    expect(screen.getByLabelText("Project")).toHaveValue("1");
  });

  it("uses a page's own project list when given", () => {
    render(
      <TestScopeProvider projects={[{ id: 1, name: "alpha" }]}>
        <PageHeader title="Cost" scope={{ date: "filter", project: "filter" }}
                    projectOptions={[{ id: 9, name: "team-project" }]} />
      </TestScopeProvider>,
    );
    expect(screen.getByRole("option", { name: "team-project" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "alpha" })).not.toBeInTheDocument();
  });

  it("tells the scope when it shows the shared range", () => {
    const markRangeShown = vi.fn();
    const value = {
      range: ALL_TIME, resolvedRange: { from: null, to: null }, projectId: null, projects: [],
      setRange: vi.fn(), setProjectId: vi.fn(), markRangeShown,
    };
    const { rerender } = render(
      <AnalysisScopeContext.Provider value={value}>
        <PageHeader title="Context economics" scope={{ date: "fixed", project: "filter" }} />
      </AnalysisScopeContext.Provider>,
    );
    expect(markRangeShown).not.toHaveBeenCalled();
    rerender(
      <AnalysisScopeContext.Provider value={value}>
        <PageHeader title="Cost" scope={{ date: "filter", project: "filter" }} />
      </AnalysisScopeContext.Provider>,
    );
    expect(markRangeShown).toHaveBeenCalled();
  });

  it("refuses scope filters without a provider", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // jsdom also reports a render error as an uncaught window error; swallow that too.
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener("error", swallow);
    expect(() => render(<PageHeader title="Cost" scope={{ date: "filter", project: "fixed" }} />))
      .toThrow(/AnalysisScopeContext/);
    window.removeEventListener("error", swallow);
    error.mockRestore();
  });
});
