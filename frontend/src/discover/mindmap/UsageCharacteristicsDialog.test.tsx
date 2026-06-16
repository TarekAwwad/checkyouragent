import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UsageCharacteristicsResponse } from "../../api/types";
import { getUsageCharacteristics } from "../../api/client";
import UsageCharacteristicsDialog from "./UsageCharacteristicsDialog";

const payload: UsageCharacteristicsResponse = {
  meta: {
    project_id: null, window: { date_from: "2026-06-10", date_to: "2026-06-16" },
    total_usd: 100, total_tokens: 0, cost_available: true, costs_partial: false,
    sessions_analyzed: 5, share_basis: "cost",
    basis_note: "Shares are weighted by cost (USD).",
  },
  characteristics: [
    { key: "subagent_sessions", headline: "subagent-heavy sessions", share: 0.89,
      cost_usd: 89, kind: "session", guidance: "Be deliberate about spawning them." },
    { key: "context_gt_150k", headline: ">150k context", share: 0.65,
      cost_usd: 65, kind: "call", guidance: "Longer sessions cost more." },
  ],
};

vi.mock("../../api/client", () => ({
  getUsageCharacteristics: vi.fn(() => Promise.resolve(payload)),
}));

function renderDialog(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UsageCharacteristicsDialog open={open} onClose={vi.fn()} projectId={null} />
    </QueryClientProvider>,
  );
}

describe("UsageCharacteristicsDialog", () => {
  it("renders one block per characteristic with rounded percentages", async () => {
    renderDialog();
    expect(await screen.findByText(/89%/)).toBeInTheDocument();
    expect(screen.getByText(/subagent-heavy sessions/)).toBeInTheDocument();
    expect(screen.getByText(/65%/)).toBeInTheDocument();
    expect(screen.getByText(/Be deliberate about spawning them\./)).toBeInTheDocument();
  });

  it("shows the cost-vs-limits caveat", async () => {
    renderDialog();
    expect(await screen.findByText(/weighted by cost/)).toBeInTheDocument();
  });

  it("exposes Day, Week, Month, and All window presets", async () => {
    renderDialog();
    await screen.findByText(/89%/);
    for (const name of ["Day", "Week", "Month", "All"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("queries the full history (no date filter) for the All preset", async () => {
    renderDialog();
    await screen.findByText(/89%/);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => {
      expect(vi.mocked(getUsageCharacteristics)).toHaveBeenCalledWith(
        expect.objectContaining({ dateFrom: null, dateTo: null }),
      );
    });
  });

  it("shows an error message when the query fails", async () => {
    vi.mocked(getUsageCharacteristics).mockRejectedValueOnce(new Error("boom"));
    renderDialog();
    expect(await screen.findByText(/Could not load usage characteristics\./)).toBeInTheDocument();
  });
});
