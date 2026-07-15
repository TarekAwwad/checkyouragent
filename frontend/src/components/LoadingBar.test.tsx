import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LoadingBar from "./LoadingBar";

describe("LoadingBar", () => {
  it("renders a status role with the default label at panel size", () => {
    render(<LoadingBar />);
    const bar = screen.getByRole("status");
    expect(bar).toHaveClass("loading-bar", "loading-bar--panel");
    expect(bar).toHaveAttribute("aria-label", "Loading…");
  });

  it("applies the requested size", () => {
    render(<LoadingBar size="inline" />);
    expect(screen.getByRole("status")).toHaveClass("loading-bar--inline");
  });

  it("does not reuse generic layout classes for its size", () => {
    render(<LoadingBar size="tile" />);
    expect(screen.getByRole("status")).not.toHaveClass("tile");
  });

  it("shows a string caption under the bar and uses it as the accessible label", () => {
    render(<LoadingBar size="panel" caption="Loading sessions…" />);
    expect(screen.getByText("Loading sessions…")).toHaveClass("loading-bar-caption");
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Loading sessions…");
  });

  it("omits the caption element when none is given", () => {
    const { container } = render(<LoadingBar />);
    expect(container.querySelector(".loading-bar-caption")).toBeNull();
  });
});
