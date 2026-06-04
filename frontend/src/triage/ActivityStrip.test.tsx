import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ActivityStrip from "./ActivityStrip";

describe("ActivityStrip", () => {
  it("renders an alert tick when alert-colored events are present", () => {
    const { container } = render(
      <ActivityStrip events={120} alerts={4} loops={0} subagents={0} />,
    );
    expect(container.querySelector('[data-testid="alert-tick"]')).not.toBeNull();
  });

  it("renders a loop band and subagent fork marks when present", () => {
    const { container } = render(
      <ActivityStrip events={300} alerts={0} loops={2} subagents={3} />,
    );
    expect(container.querySelector('[data-testid="loop-band"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="fork-mark"]').length).toBe(3);
  });
});
