// frontend/src/shell/Sidebar.test.tsx
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

function setup(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props = {
    view: "discover" as const,
    scope: "local" as const,
    discoverTechnique: "subgroup",
    collapsed: false,
    theme: "dark" as const,
    onSelectView: vi.fn(),
    onSelectScope: vi.fn(),
    onSelectTechnique: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onToggleTheme: vi.fn(),
    onOpenGlossary: vi.fn(),
    onDismissGlossaryHint: vi.fn(),
    historicalPricing: true,
    onToggleHistoricalPricing: vi.fn(),
    privacyMode: false,
    onTogglePrivacyMode: vi.fn(),
    ...overrides,
  };
  render(<Sidebar {...props} />);
  return props;
}

describe("Sidebar", () => {
  it("renders the brand and the local-scope nav", () => {
    setup();
    expect(screen.getByText("Check Your Agent")).toBeInTheDocument();
    expect(screen.getByText("local, read-only session data")).toBeInTheDocument();
    for (const name of ["Import", "Export", "Overview", "Cost", "Explore"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Data" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session" })).not.toBeInTheDocument();
  });

  it("shows only the aggregate views in team scope", () => {
    setup({ scope: "team", view: "map" });
    for (const name of ["Import", "Overview", "Cost"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // Export (share a local bundle) and Explore (subgroup drilldown) have no
    // team-bundle equivalent.
    expect(screen.queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explore" })).not.toBeInTheDocument();
  });

  it("renders the data-scope switch and routes scope changes", () => {
    const props = setup({ scope: "local" });
    const scopeGroup = screen.getByRole("group", { name: "Data scope" });
    const thisMachine = within(scopeGroup).getByRole("button", { name: "This machine" });
    const team = within(scopeGroup).getByRole("button", { name: "Team" });
    expect(thisMachine).toHaveAttribute("aria-pressed", "true");
    expect(team).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(team);
    expect(props.onSelectScope).toHaveBeenCalledWith("team");
  });

  it("renders a collapsed icon toggle for scope switching", () => {
    const props = setup({ scope: "team", collapsed: true });
    const scopeToggle = screen.getByRole("button", { name: /data scope: team\. switch to this machine/i });
    expect(scopeToggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(scopeToggle);
    expect(props.onSelectScope).toHaveBeenCalledWith("local");
  });

  it("marks the active view and routes nav clicks", () => {
    const props = setup({ view: "cost" });
    expect(screen.getByRole("button", { name: "Cost" })).toHaveClass("active");
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(props.onSelectView).toHaveBeenCalledWith("map");
  });

  it("shows the ready technique subnav when Explore is active", () => {
    const props = setup({ view: "discover" });
    const ready = screen.getByRole("button", { name: "Subgroups" });
    expect(ready).toHaveClass("active");
    fireEvent.click(ready);
    expect(props.onSelectTechnique).toHaveBeenCalledWith("subgroup");
    expect(screen.queryByRole("button", { name: /Sequence mining/ })).not.toBeInTheDocument();
  });

  it("hides the technique subnav when Explore is not active", () => {
    setup({ view: "cost" });
    expect(screen.queryByRole("button", { name: "Subgroups" })).not.toBeInTheDocument();
  });

  it("fires footer actions", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open glossary" }));
    fireEvent.click(screen.getByRole("button", { name: "Privacy mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Historical pricing" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    fireEvent.click(screen.getByRole("button", { name: /collapse sidebar/i }));
    expect(props.onOpenGlossary).toHaveBeenCalled();
    expect(props.onTogglePrivacyMode).toHaveBeenCalled();
    expect(props.onToggleHistoricalPricing).toHaveBeenCalled();
    expect(props.onToggleTheme).toHaveBeenCalled();
    expect(props.onToggleCollapsed).toHaveBeenCalled();
  });

  it("applies the collapsed class to the sidebar when collapsed", () => {
    setup({ collapsed: true });
    expect(screen.getByRole("complementary")).toHaveClass("is-collapsed");
  });

  it("does not show the glossary hint by default", () => {
    setup();
    expect(screen.queryByText("Not sure what a term means?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open glossary" })).not.toHaveClass("is-hinted");
  });

  it("pulses the help button and shows a dismissable coachmark when hinted", () => {
    const props = setup({ glossaryHint: true });

    expect(screen.getByRole("button", { name: "Open glossary" })).toHaveClass("is-hinted");
    expect(screen.getByText("Not sure what a term means?")).toBeInTheDocument();

    // The coachmark CTA opens the glossary...
    fireEvent.click(screen.getByRole("button", { name: "Browse glossary" }));
    expect(props.onOpenGlossary).toHaveBeenCalled();

    // ...and "Got it" dismisses the hint without opening it.
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(props.onDismissGlossaryHint).toHaveBeenCalled();
  });
});

describe("Sidebar historical-pricing toggle", () => {
  it("renders and toggles", () => {
    const onToggle = vi.fn();
    render(
      <Sidebar
        view="map"
        scope="local"
        discoverTechnique="subgroup"
        collapsed={false}
        theme="dark"
        onSelectView={vi.fn()}
        onSelectScope={vi.fn()}
        onSelectTechnique={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onToggleTheme={vi.fn()}
        onOpenGlossary={vi.fn()}
        historicalPricing={true}
        onToggleHistoricalPricing={onToggle}
        privacyMode={false}
        onTogglePrivacyMode={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: /historical pricing/i });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("reflects on/off state on the toggle button", () => {
    const base = {
      view: "map" as const,
      scope: "local" as const,
      discoverTechnique: "subgroup",
      collapsed: false,
      theme: "dark" as const,
      onSelectView: vi.fn(),
      onSelectScope: vi.fn(),
      onSelectTechnique: vi.fn(),
      onToggleCollapsed: vi.fn(),
      onToggleTheme: vi.fn(),
      onOpenGlossary: vi.fn(),
      onToggleHistoricalPricing: vi.fn(),
      privacyMode: false,
      onTogglePrivacyMode: vi.fn(),
    };
    const { rerender } = render(<Sidebar {...base} historicalPricing={true} />);
    let btn = screen.getByRole("button", { name: /historical pricing/i });
    expect(btn).toHaveClass("is-active");
    expect(btn).toHaveAttribute("aria-pressed", "true");

    rerender(<Sidebar {...base} historicalPricing={false} />);
    btn = screen.getByRole("button", { name: /historical pricing/i });
    expect(btn).not.toHaveClass("is-active");
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });
});
