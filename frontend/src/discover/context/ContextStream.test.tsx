import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import ContextStream from "./ContextStream";
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

describe("ContextStream privacy mode", () => {
  it("keeps aggregate band tooltip titles readable in privacy mode", () => {
    // Aggregate bands ("Conversation baseline", "Other (N)") are non-content
    // category labels: the tooltip blur is opt-in per call site, so
    // ContextStream's default show() must leave them readable.
    const { container } = render(
      <PrivacyModeProvider value={true}>
        <ContextStream thread={thread} highlightEventId={null} />
      </PrivacyModeProvider>,
    );
    const band = container.querySelector("path.stream-baseline");
    expect(band).not.toBeNull();
    fireEvent.mouseMove(band!);
    const title = container.querySelector(".chart-tooltip strong");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Conversation baseline");
    expect(title!.querySelector("span[class*='blurred']")).toBeNull();
  });

  it("blurs real contributor band tooltip titles in privacy mode", () => {
    // Real bands resolve to a contributor whose label is content-derived
    // (file paths, tool labels), so the tooltip title must be blur-wrapped.
    const { container } = render(
      <PrivacyModeProvider value={true}>
        <ContextStream thread={thread} highlightEventId={null} />
      </PrivacyModeProvider>,
    );
    const band = container.querySelector("path.stream-tool");
    expect(band).not.toBeNull();
    fireEvent.mouseMove(band!);
    const title = container.querySelector(".chart-tooltip strong");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe(RAW_LABEL);
    expect(title!.querySelector("span[class*='blurred']")).not.toBeNull();
  });
});
