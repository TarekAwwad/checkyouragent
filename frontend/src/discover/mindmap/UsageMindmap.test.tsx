import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UsageMapEvidenceResponse, UsageMapResponse } from "../../api/types";
import type { UsagePhase } from "../../api/types";
import MindmapCanvas from "./MindmapCanvas";
import UsageMindmap from "./UsageMindmap";

const PHASES: UsagePhase[] = [
  {
    key: "explore", label: "Explore", cost_usd: 50, tokens: 0, share: 0.5,
    tool_count: 10, session_count: 3,
    habits: [{ key: "re-reads", phase: "explore", label: "Repeated file re-reads",
               polarity: "anti", status: "confirmed", cost_usd: 5, count: 4,
               session_count: 2 }],
    tools: [{ key: "Read", label: "Read", cost_usd: 30, tokens: 0, count: 12,
              session_count: 3 },
            { key: "Grep", label: "Grep", cost_usd: 20, tokens: 0, count: 8,
              session_count: 2 }],
  },
  { key: "implement", label: "Implement", cost_usd: 30, tokens: 0, share: 0.3,
    tool_count: 6, session_count: 3, habits: [],
    tools: [{ key: "Edit", label: "Edit", cost_usd: 30, tokens: 0, count: 6,
              session_count: 3 }] },
  { key: "verify", label: "Verify", cost_usd: 20, tokens: 0, share: 0.2,
    tool_count: 4, session_count: 2, habits: [],
    tools: [{ key: "Bash", label: "Bash", cost_usd: 20, tokens: 0, count: 4,
              session_count: 2 }] },
];

const mapPayload: UsageMapResponse = {
  meta: {
    project_id: null, window: { date_from: null, date_to: null },
    total_usd: 100, total_tokens: 5_000_000, cost_available: true,
    costs_partial: false, sessions_analyzed: 12, events_classified: 340,
    share_basis: "cost",
  },
  phases: PHASES.concat([
    { key: "plan", label: "Plan", cost_usd: 0, tokens: 0, share: 0,
      tool_count: 0, session_count: 0, habits: [], tools: [] },
    { key: "operate", label: "Operate", cost_usd: 0, tokens: 0, share: 0,
      tool_count: 0, session_count: 0, habits: [], tools: [] },
    { key: "delegate", label: "Delegate", cost_usd: 0, tokens: 0, share: 0,
      tool_count: 0, session_count: 0, habits: [], tools: [] },
    { key: "converse", label: "Converse", cost_usd: 0, tokens: 0, share: 0,
      tool_count: 0, session_count: 0, habits: [], tools: [] },
  ]),
};

const evidencePayload: UsageMapEvidenceResponse = {
  node: "phase:explore", label: "Explore",
  rule: "Assistant turns whose tool calls classify as Explore.",
  cost_usd: 50,
  sessions: [{ session_id: 7, title: "Fix importer", project_name: "alpha",
               cost_usd: 30, count: 12, exemplar_event_ids: [101], detail: null }],
};

vi.mock("../../api/client", () => ({
  getUsageMap: vi.fn(() => Promise.resolve(mapPayload)),
  getUsageMapEvidence: vi.fn(() => Promise.resolve(evidencePayload)),
}));

function renderPage(onOpenSession = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UsageMindmap projects={[]} onOpenSession={onOpenSession} />
    </QueryClientProvider>,
  );
}

describe("MindmapCanvas", () => {
  it("renders the center, phase nodes with exact shares, and habit leaves", () => {
    render(<MindmapCanvas phases={PHASES} totalUsd={100} costAvailable
                          selectedNodeId={null} onSelectNode={vi.fn()} />);
    expect(screen.getByText("My usage")).toBeInTheDocument();
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("Repeated file re-reads")).toBeInTheDocument();
  });

  it("fires onSelectNode when a node is clicked", () => {
    const onSelect = vi.fn();
    render(<MindmapCanvas phases={PHASES} totalUsd={100} costAvailable
                          selectedNodeId={null} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Explore: 50%/ }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "phase:explore" }));
  });

  it("dims non-neighbors while hovering a node", () => {
    const { container } = render(
      <MindmapCanvas phases={PHASES} totalUsd={100} costAvailable
                     selectedNodeId={null} onSelectNode={vi.fn()} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: /Explore: 50%/ }));
    // Verify (not adjacent to Explore) is dimmed; the habit leaf (adjacent) is not.
    expect(container.querySelectorAll(".mindmap-node.is-dimmed").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Verify: 20%/ }).classList.contains("is-dimmed")).toBe(true);
    expect(screen.getByRole("button", { name: /Repeated file re-reads/ }).classList.contains("is-dimmed")).toBe(false);
    fireEvent.pointerLeave(screen.getByRole("button", { name: /Explore: 50%/ }));
    expect(container.querySelectorAll(".mindmap-node.is-dimmed")).toHaveLength(0);
  });
});

describe("UsageMindmap", () => {
  it("renders the map and shows evidence for the costliest phase by default", async () => {
    renderPage();
    expect(await screen.findByText("My usage")).toBeInTheDocument();
    expect(await screen.findByText(/classify as Explore/)).toBeInTheDocument();
    // share/cost rows from the floating card
    expect(screen.getByText("Share of spend")).toBeInTheDocument();
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
  });

  it("does not render a session list in the evidence card", async () => {
    renderPage();
    await screen.findByText(/classify as Explore/);
    expect(screen.queryByText("Fix importer")).not.toBeInTheDocument();
  });

  it("resets the selection when filters change", async () => {
    const { container } = renderPage();
    await screen.findByText("My usage");
    fireEvent.click(screen.getByRole("button", { name: /Implement: 30%/ }));
    expect(container.querySelector(".mindmap-node.is-selected")
      ?.getAttribute("aria-label")).toMatch(/^Implement/);
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-06-01" } });
    await waitFor(() => {
      const selected = container.querySelectorAll(".mindmap-node.is-selected");
      expect(selected).toHaveLength(1);
      expect(selected[0].getAttribute("aria-label")).toMatch(/^Explore/);
    });
  });

  it("shows compare deltas when both dates are set and compare is on", async () => {
    renderPage();
    await screen.findByText("My usage");
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-06-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-06-10" } });
    fireEvent.click(screen.getByLabelText("Compare with previous period"));
    expect((await screen.findAllByText("=")).length).toBeGreaterThan(0);
  });

  it("offers JSON and PNG export buttons", async () => {
    renderPage();
    await screen.findByText("My usage");
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeInTheDocument();
  });
});
