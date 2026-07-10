import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import BallastLanes from "./BallastLanes";
import { PrivacyModeProvider } from "../../shell/PrivacyModeContext";
import type { ContextThread } from "../../api/types";

// 100% synthetic: a fabricated project path that never appears in real exports.
const RAW_LABEL = "Read result: d:\\Code\\synthetic-project\\secret.ts";

const thread: ContextThread = {
  agent_id: null,
  calls: [
    { turn: 0, ts: null, context_tokens: 10_000, model: "m" },
    { turn: 1, ts: null, context_tokens: 60_000, model: "m" },
  ],
  epochs: [{ start_turn: 0, end_turn: 1, ended_by: "end" }],
  contributors: [
    {
      id: "tool_result-1-1",
      kind: "tool_result",
      label: RAW_LABEL,
      entry_turn: 1,
      end_turn: 1,
      est_tokens: 49_000,
      accrued_usd: 0.05,
      event_id: 42,
    },
  ],
  findings: [],
};

function renderLanes(privacyMode: boolean) {
  return render(
    <PrivacyModeProvider value={privacyMode}>
      <BallastLanes thread={thread} highlightEventId={null} costAvailable={true} />
    </PrivacyModeProvider>,
  );
}

describe("BallastLanes privacy mode", () => {
  it("blurs the content-derived contributor label when privacy mode is on", () => {
    renderLanes(true);
    // The label text still renders (so the row keeps its shape) but is wrapped
    // in the Blurred treatment so raw paths never survive a screenshot.
    const label = screen.getByText(RAW_LABEL);
    expect(label.className).toMatch(/blurred/);
  });

  it("leaves the contributor label readable when privacy mode is off", () => {
    renderLanes(false);
    const label = screen.getByText(RAW_LABEL);
    expect(label.className).not.toMatch(/blurred/);
  });

  it("blurs the tooltip title when hovering a lane in privacy mode", () => {
    const { container } = renderLanes(true);
    fireEvent.mouseMove(screen.getByRole("listitem"));
    const title = container.querySelector(".chart-tooltip strong");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe(RAW_LABEL);
    expect(title!.querySelector("span[class*='blurred']")).not.toBeNull();
  });
});
