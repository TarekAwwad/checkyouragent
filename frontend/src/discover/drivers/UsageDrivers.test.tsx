import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, UsageCharacteristicsResponse } from "../../api/types";
import UsageDrivers from "./UsageDrivers";

const payload: UsageCharacteristicsResponse = {
  meta: {
    project_id: null, window: { date_from: null, date_to: null },
    total_usd: 100, total_tokens: 0, cost_available: true, costs_partial: false,
    sessions_analyzed: 5, share_basis: "cost",
    basis_note: "Shares are weighted by cost (USD).",
  },
  characteristics: [
    { key: "subagent_sessions", headline: "subagent-heavy sessions", share: 0.89,
      cost_usd: 89, kind: "session", guidance: "Be deliberate about spawning them." },
  ],
};

vi.mock("../../api/client", () => ({
  getUsageCharacteristics: vi.fn(() => Promise.resolve(payload)),
}));

const projects: Project[] = [];

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UsageDrivers projects={projects} onOpenSession={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("UsageDrivers", () => {
  it("renders characteristic rows from the API inline, not in a modal", async () => {
    renderPage();
    expect(await screen.findByText(/89%/)).toBeInTheDocument();
    expect(screen.getByText(/subagent-heavy sessions/)).toBeInTheDocument();
    expect(screen.getByText(/Be deliberate about spawning them\./)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toBeInTheDocument();
  });

  it("exposes the Day/Week/Month/All range presets", async () => {
    renderPage();
    await screen.findByText(/89%/);
    for (const name of ["Day", "Week", "Month", "All"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });
});
