import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import SessionDrilldown from "./SessionDrilldown";
import type { SessionContextEconomicsResponse } from "../../api/types";

const sessionPayload: SessionContextEconomicsResponse = {
  cost_available: true,
  threads: [{
    agent_id: null,
    calls: [
      { turn: 0, ts: null, context_tokens: 10_000, model: "m" },
      { turn: 1, ts: null, context_tokens: 60_000, model: "m" },
      { turn: 2, ts: null, context_tokens: 61_000, model: "m" },
    ],
    epochs: [{ start_turn: 0, end_turn: 2, ended_by: "end" }],
    contributors: [
      { id: "baseline-0", kind: "baseline", label: "System prompt + initial context",
        entry_turn: 0, end_turn: 2, est_tokens: 10_000, accrued_usd: 0.02, event_id: null },
      { id: "tool_result-1-1", kind: "tool_result", label: "Read result: dist/bundle.js",
        entry_turn: 1, end_turn: 2, est_tokens: 49_000, accrued_usd: 0.05, event_id: 42 },
    ],
    findings: [],
  }],
};

vi.mock("../../api/client", () => ({
  getSessionContextEconomics: vi.fn(() => Promise.resolve(sessionPayload)),
}));

describe("SessionDrilldown", () => {
  it("renders the stream bands and ballast lanes for the main thread", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SessionDrilldown
          sessionId={7}
          sessionTitle="Fix sourcemaps"
          highlightEventId={42}
          onOpenSession={vi.fn()}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("img", { name: /context composition/i })).toBeInTheDocument();
    expect(screen.getByText("Read result: dist/bundle.js")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open session/i })).toBeInTheDocument();
  });
});
