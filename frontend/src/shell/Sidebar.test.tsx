// frontend/src/shell/Sidebar.test.tsx
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

function setup(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const props = {
    view: "discover" as const,
    discoverTechnique: "subgroup",
    collapsed: false,
    sessionEnabled: false,
    theme: "dark" as const,
    onSelectView: vi.fn(),
    onSelectTechnique: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onToggleTheme: vi.fn(),
    onOpenGlossary: vi.fn(),
    onDismissGlossaryHint: vi.fn(),
    ...overrides,
  };
  render(<Sidebar {...props} />);
  return props;
}

describe("Sidebar", () => {
  it("renders the brand and primary nav", () => {
    setup();
    expect(screen.getByText("Claude Analytics")).toBeInTheDocument();
    for (const name of ["Import", "Triage", "Cost", "Discover", "Session"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("marks the active view and routes nav clicks", () => {
    const props = setup({ view: "cost" });
    expect(screen.getByRole("button", { name: "Cost" })).toHaveClass("active");
    fireEvent.click(screen.getByRole("button", { name: "Triage" }));
    expect(props.onSelectView).toHaveBeenCalledWith("map");
  });

  it("disables Session until one is selected", () => {
    setup({ sessionEnabled: false });
    expect(screen.getByRole("button", { name: "Session" })).toBeDisabled();
  });

  it("shows the technique subnav when Discover is active", () => {
    const props = setup({ view: "discover" });
    const ready = screen.getByRole("button", { name: "Subgroups" });
    expect(ready).toHaveClass("active");
    fireEvent.click(ready);
    expect(props.onSelectTechnique).toHaveBeenCalledWith("subgroup");
    // "soon" techniques are present but disabled
    expect(screen.getByRole("button", { name: /Sequence mining/ })).toBeDisabled();
  });

  it("hides the technique subnav when Discover is not active", () => {
    setup({ view: "cost" });
    expect(screen.queryByRole("button", { name: "Subgroups" })).not.toBeInTheDocument();
  });

  it("fires footer actions", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open glossary" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    fireEvent.click(screen.getByRole("button", { name: /collapse sidebar/i }));
    expect(props.onOpenGlossary).toHaveBeenCalled();
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
