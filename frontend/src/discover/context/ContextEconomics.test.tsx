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
    total_tokens: 8_000_000, avoidable_tokens: 1_000_000, avoidable_token_share: 0.125,
    sessions_analyzed: 64, sessions_skipped: 2,
    trend: [
      { week_start: "2026-05-25", total_usd: 320, avoidable_usd: 110 },
      { week_start: "2026-06-01", total_usd: 340, avoidable_usd: 93 },
    ],
  },
  archetypes: [
    {
      key: "oversized", title: "Oversized tool results",
      description: "desc", recommendation: "Use limit/offset reads.",
      meets_support: true, findings_count: 3,
      // avoidable_usd (203) equals the sum of supported archetypes' savings, as the
      // backend always guarantees, so the hero bar fills to exactly the headline %.
      savings_usd: 203, savings_tokens: 1_000_000,
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
    // hero shows three separate stat cells: Total spend / Avoidable / Necessary
    expect(await screen.findByText("Total spend")).toBeInTheDocument();
    expect(screen.getByText("Avoidable")).toBeInTheDocument();
    expect(screen.getByText("$660")).toBeInTheDocument();
    // bar aria-label confirms both headline numbers
    expect(screen.getByRole("group", { name: /\$203 of \$660/i })).toBeInTheDocument();
    expect(screen.getAllByText("Oversized tool results").length).toBeGreaterThan(0);
    const compactLabel = screen.getByText(/Read result: bundle\.js/);
    expect(compactLabel).toBeInTheDocument();
    expect(compactLabel).toHaveAttribute("title", "Read result: dist/bundle.js (53,000 tok)");
  });

  it("disables under-supported archetypes in the legend with an evidence hint", async () => {
    renderPage();
    await screen.findByText("Total spend");
    const chip = screen.getByRole("button", { name: /Redundant re-reads/ });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("title", expect.stringMatching(/needs more evidence/i));
  });

  it("renders clickable hero segments per archetype", async () => {
    renderPage();
    await screen.findByText("Total spend");
    const hero = screen.getByRole("group", { name: /avoidable spend breakdown/i });
    expect(hero).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Oversized tool results: $203" })).toBeInTheDocument();
  });

  it("renders the weekly trend sparkline", async () => {
    renderPage();
    await screen.findByText("Total spend");
    expect(screen.getByRole("img", { name: /weekly avoidable spend trend/i })).toBeInTheDocument();
  });

  it("shows the counterfactual explanation when a finding is expanded", async () => {
    renderPage();
    await screen.findByText("Total spend");
    const toggle = screen.getByRole("button", { name: /how we estimated this/i });
    toggle.click();
    expect(await screen.findByText(/p95 of 4,812 tool results/)).toBeInTheDocument();
  });
});
