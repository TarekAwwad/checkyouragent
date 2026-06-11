import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ContextEconomics from "./ContextEconomics";
import type { ContextEconomicsResponse } from "../../api/types";

const corpusPayload: ContextEconomicsResponse = {
  meta: {
    project_id: null, min_support: 3,
    total_usd: 660, necessary_usd: 457, avoidable_usd: 203,
    unattributed_tokens: 1200, cost_available: true,
    sessions_analyzed: 64, sessions_skipped: 2,
  },
  archetypes: [
    {
      key: "oversized", title: "Oversized tool results",
      description: "desc", recommendation: "Use limit/offset reads.",
      meets_support: true, findings_count: 3,
      savings_usd: 96, savings_tokens: 1_000_000,
      thresholds: [{ name: "oversized_tokens", value: 8200, provenance: "p95 of 4,812 tool results" }],
      exemplar: {
        session_id: 7,
        series: [
          { turn: 0, context_tokens: 10_000, highlight_tokens: 0 },
          { turn: 1, context_tokens: 60_000, highlight_tokens: 50_000 },
        ],
      },
      findings: [{
        archetype: "oversized",
        session_id: 7, session_title: "Fix sourcemaps", project_name: "alpha",
        epoch: 0, entry_turn: 9, label: "Read result: dist/bundle.js (53,000 tok)",
        carried_turns: 64, carried_tokens: 53_000, savings_tokens: 51_000,
        savings_usd: 2.1,
        counterfactual: { model: "capped at median", params: { cap_tokens: 2000 } },
        event_id: 42,
      }],
    },
    {
      key: "rereads", title: "Redundant re-reads", description: "", recommendation: "",
      meets_support: false, findings_count: 1, savings_usd: 0, savings_tokens: 0,
      thresholds: [], exemplar: null, findings: [],
    },
  ],
};

vi.mock("../../api/client", () => ({
  getContextEconomics: vi.fn(() => Promise.resolve(corpusPayload)),
  getSessionContextEconomics: vi.fn(() => Promise.resolve({ threads: [], cost_available: true })),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ContextEconomics projects={[]} onOpenSession={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("ContextEconomics", () => {
  it("renders the hero verdict and archetype cards", async () => {
    renderPage();
    expect(await screen.findByText(/\$203/)).toBeInTheDocument();
    expect(screen.getByText("Oversized tool results")).toBeInTheDocument();
    expect(screen.getByText(/Read result: dist\/bundle\.js/)).toBeInTheDocument();
  });

  it("marks under-supported archetypes as needing more evidence", async () => {
    renderPage();
    await screen.findByText(/\$203/);
    expect(screen.getByText(/needs more evidence/i)).toBeInTheDocument();
  });
});
