import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ContextEconomics from "./ContextEconomics";
import { TestScopeProvider } from "../../shell/TestScopeProvider";
import type { ContextEconomicsResponse } from "../../api/types";

const corpusPayload: ContextEconomicsResponse = {
  meta: {
    project_id: null,
    min_support: 3,
    recorded_api_equivalent_usd: 660,
    opportunity_usd: 203,
    unattributed_usd: 457,
    opportunity_tokens: 1_000_000,
    cost_available: true,
    costs_partial: false,
    unpriced_models: [],
    sessions_analyzed: 64,
    sessions_skipped: 2,
    trend: [
      { week_start: "2026-05-25", total_usd: 320, avoidable_usd: 110 },
      { week_start: "2026-06-01", total_usd: 340, avoidable_usd: 93 },
    ],
  },
  archetypes: [
    {
      key: "oversized",
      title: "Large result carry opportunity",
      description: "desc",
      recommendation: "Use limit/offset reads.",
      meets_support: true,
      findings_count: 3,
      savings_usd: 203,
      savings_tokens: 1_000_000,
      thresholds: [{
        name: "Read large-result threshold",
        value: 8200,
        provenance: "Read p95 of 4,812 results; 5,000 tok floor",
      }],
      exemplar: {
        session_id: 7,
        series: [
          { turn: 0, context_tokens: 10_000, highlight_tokens: 0 },
          { turn: 1, context_tokens: 60_000, highlight_tokens: 50_000 },
        ],
      },
      findings: [{
        archetype: "oversized",
        session_id: 7,
        session_title: "Fix sourcemaps",
        project_name: "alpha",
        epoch: 0,
        entry_turn: 9,
        label: "Read result: dist/bundle.js (53,000 tok)",
        carried_turns: 64,
        carried_tokens: 53_000,
        savings_tokens: 51_000,
        savings_usd: 2.1,
        counterfactual: {
          model: "Estimated carry reduction using the Read result median as a cap; token size is calibrated from observed context growth.",
          params: {
            observed_size: 212_000,
            estimated_tokens: 53_000,
            tool_baseline_tokens: 2_000,
            modeled_reduction_tokens: 51_000,
          },
        },
        event_id: 42,
        evidence_event_ids: [42],
      }],
    },
    {
      key: "rereads",
      title: "Repeated same-range reads",
      description: "",
      recommendation: "",
      meets_support: false,
      findings_count: 1,
      savings_usd: 0,
      savings_tokens: 0,
      thresholds: [],
      exemplar: null,
      findings: [],
    },
  ],
};

const mocks = vi.hoisted(() => ({
  getContextEconomics: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  getContextEconomics: mocks.getContextEconomics,
  getSessionContextEconomics: vi.fn(() => Promise.resolve({ threads: [], cost_available: true })),
}));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TestScopeProvider projects={[{ id: 3, name: "gamma" }]}>
        <ContextEconomics onOpenSession={vi.fn()} />
      </TestScopeProvider>
    </QueryClientProvider>,
  );
}

describe("ContextEconomics", () => {
  beforeEach(() => {
    mocks.getContextEconomics.mockReset();
    mocks.getContextEconomics.mockResolvedValue(corpusPayload);
  });

  it("renders the opportunity framing and archetype cards", async () => {
    renderPage();

    expect(await screen.findByText("Recorded estimated API-equivalent cost")).toBeInTheDocument();
    expect(screen.getByText("Estimated context opportunity")).toBeInTheDocument();
    expect(screen.getAllByText("Cost not attributed to detected opportunities").length)
      .toBeGreaterThan(0);
    expect(screen.getByText("$660")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /estimated context opportunity.*\$203 of \$660/i }))
      .toBeInTheDocument();
    expect(screen.queryByText(/^Necessary$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Avoidable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/% of your usage/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Large result carry opportunity").length).toBeGreaterThan(0);
    expect(screen.queryByText("Oversized tool results")).not.toBeInTheDocument();
    const compactLabel = screen.getByText(/Read result: bundle\.js/);
    expect(compactLabel).toBeInTheDocument();
    expect(compactLabel).toHaveAttribute("title", "Read result: dist/bundle.js (53,000 tok)");
  });

  it("keeps support calibration out of the default controls", async () => {
    renderPage();

    await screen.findByText("Estimated context opportunity");
    expect(screen.queryByRole("combobox", { name: /minimum support/i })).not.toBeInTheDocument();
    expect(mocks.getContextEconomics).toHaveBeenCalledWith({ projectId: null });
  });

  it("disables under-supported archetypes in the legend with an evidence hint", async () => {
    renderPage();
    await screen.findByText("Estimated context opportunity");
    const chip = screen.getByRole("button", { name: /Repeated same-range reads/ });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute("title", expect.stringMatching(/needs more evidence/i));
  });

  it("renders clickable hero segments per archetype", async () => {
    renderPage();
    await screen.findByText("Estimated context opportunity");
    expect(screen.getByRole("group", { name: /estimated context opportunity breakdown/i }))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Large result carry opportunity: $203" }))
      .toBeInTheDocument();
  });

  it("renders the weekly opportunity trend sparkline", async () => {
    renderPage();
    await screen.findByText("Estimated context opportunity");
    expect(screen.getByRole("img", { name: /weekly estimated context opportunity/i }))
      .toBeInTheDocument();
  });

  it("shows the counterfactual explanation when a finding is expanded", async () => {
    renderPage();
    await screen.findByText("Estimated context opportunity");
    const toggle = screen.getByRole("button", { name: /how we estimated this/i });
    toggle.click();
    expect(await screen.findByText(/Read p95 of 4,812 results/)).toBeInTheDocument();
    expect(screen.getByText(/estimated carry reduction using the Read result median as a cap/i))
      .toBeInTheDocument();
  });

  it("exposes both recorded receipts for a repeated-read finding", async () => {
    const base = corpusPayload.archetypes[0];
    const finding = base.findings[0];
    mocks.getContextEconomics.mockResolvedValue({
      ...corpusPayload,
      archetypes: [{
        ...base,
        key: "rereads",
        title: "Repeated same-range reads",
        findings: [{
          ...finding,
          archetype: "rereads",
          evidence_event_ids: [41, 42],
        }],
      }],
    });

    renderPage();

    expect(await screen.findByText(/2 receipts/)).toHaveAttribute(
      "title", "Recorded event receipts: 41, 42",
    );
  });

  it("explains partial pricing and does not render an opportunity percentage", async () => {
    mocks.getContextEconomics.mockResolvedValue({
      ...corpusPayload,
      meta: {
        ...corpusPayload.meta,
        costs_partial: true,
        unpriced_models: ["custom-model"],
      },
    });

    renderPage();

    expect(await screen.findByText(/pricing is partial/i)).toBeInTheDocument();
    expect(screen.getByText(/custom-model/)).toBeInTheDocument();
    expect(screen.queryByText(/\(31%\)/)).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /opportunity breakdown/i })).not.toBeInTheDocument();
  });

  it("keeps the header on an empty corpus and refetches for another project", async () => {
    mocks.getContextEconomics.mockResolvedValueOnce({
      ...corpusPayload, meta: { ...corpusPayload.meta, sessions_analyzed: 0 },
    });
    renderPage();
    expect(await screen.findByText("No imported sessions with usage data available.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Context economics" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "3" } });
    await waitFor(() => expect(mocks.getContextEconomics).toHaveBeenLastCalledWith({ projectId: 3 }));
    expect(await screen.findByText("Estimated context opportunity")).toBeInTheDocument();
  });

  it("keeps the header when the analysis fails", async () => {
    mocks.getContextEconomics.mockRejectedValueOnce(new Error("boom"));
    renderPage();
    expect(await screen.findByText("Context economics could not be loaded.")).toBeInTheDocument();
    expect(screen.getByLabelText("Project")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Scope" })).getByText("All time")).toBeInTheDocument();
  });
});
