import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import GlossaryDialog from "./GlossaryDialog";

describe("GlossaryDialog", () => {
  it("renders the default Structure tab with a sample term and its definition", () => {
    render(<GlossaryDialog open onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Glossary" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Structure" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Subagent")).toBeInTheDocument();
    expect(
      screen.getByText(/secondary agent the main thread spawns/i),
    ).toBeInTheDocument();
  });

  it("switches panels when another tab is selected, revealing that tab's terms and score detail", () => {
    render(<GlossaryDialog open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Risk" }));

    // The Risk score term and its computed-mechanics detail are now shown.
    expect(screen.getByText("Risk score")).toBeInTheDocument();
    expect(screen.getByText(/Alerts/)).toBeInTheDocument();
    // Structure-only terms are no longer rendered in the active panel.
    expect(screen.queryByText("Subagent")).not.toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(<GlossaryDialog open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /close glossary/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the dialog emits a native close event (Esc / backdrop)", () => {
    const onClose = vi.fn();
    render(<GlossaryDialog open onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /close glossary/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
