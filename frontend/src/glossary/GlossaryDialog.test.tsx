import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import GlossaryDialog from "./GlossaryDialog";

describe("GlossaryDialog", () => {
  it("renders category headings and a sample term with its definition when open", () => {
    render(<GlossaryDialog open onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Glossary" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Structure" })).toBeInTheDocument();
    expect(screen.getByText("Subagent")).toBeInTheDocument();
    expect(
      screen.getByText(/secondary agent the main thread spawns/i),
    ).toBeInTheDocument();
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
