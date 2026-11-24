import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getUsageMapEvidence } from "../../api/client";
import type { UsageMapEvidenceResponse, UsageMapResponse } from "../../api/types";
import type { UsagePhase } from "../../api/types";
import MindmapCanvas from "./MindmapCanvas";
import UsageMindmap from "./UsageMindmap";
import { buildActivityMapExport } from "./exportMap";

const PHASES: UsagePhase[] = [
  {
    key: "explore", label: "Explore", activity_count: 50, activity_share: 0.5,
    main_activity_count: 10, subagent_activity_count: 40,
    text_assistant_step_count: 0,
    tool_count: 10, session_count: 3,
    habits: [{ key: "re-reads", phase: "explore", label: "Repeated file re-reads",
               activity_count: 4, session_count: 2 }],
    tools: [{ key: "Read", label: "Read", activity_count: 30,
              session_count: 3 },
            { key: "Grep", label: "Grep", activity_count: 20,
              session_count: 2 }],
  },
  { key: "implement", label: "Implement", activity_count: 30, activity_share: 0.3,
    main_activity_count: 30, subagent_activity_count: 0,
    text_assistant_step_count: 0,
    tool_count: 6, session_count: 3, habits: [],
    tools: [{ key: "Edit", label: "Edit", activity_count: 30,
              session_count: 3 }] },
  { key: "verify", label: "Verify", activity_count: 20, activity_share: 0.2,
    main_activity_count: 20, subagent_activity_count: 0,
    text_assistant_step_count: 0,
    tool_count: 4, session_count: 2, habits: [],
    tools: [{ key: "Bash", label: "Bash", activity_count: 20,
              session_count: 2 }] },
];

const mapPayload: UsageMapResponse = {
  meta: {
    project_id: null, window: { date_from: null, date_to: null },
    total_usd: 100, total_tokens: 5_000_000, cost_available: true,
    costs_partial: false, sessions_analyzed: 12, events_classified: 340,
    total_activity_count: 100, tool_call_count: 99,
    text_assistant_step_count: 1,
    activity_basis: "tool_calls_and_assistant_steps",
    methodology: "Each tool call counts once; a text-only assistant step counts once. This is observed activity, not cost attribution.",
  },
  phases: PHASES.concat([
    { key: "plan", label: "Plan", activity_count: 0, activity_share: 0,
      main_activity_count: 0, subagent_activity_count: 0,
      text_assistant_step_count: 0,
      tool_count: 0, session_count: 0, habits: [], tools: [] },
    { key: "operate", label: "Operate", activity_count: 0, activity_share: 0,
      main_activity_count: 0, subagent_activity_count: 0,
      text_assistant_step_count: 0,
      tool_count: 0, session_count: 0, habits: [], tools: [] },
    { key: "delegate", label: "Delegate", activity_count: 0, activity_share: 0,
      main_activity_count: 0, subagent_activity_count: 0,
      text_assistant_step_count: 0,
      tool_count: 0, session_count: 0, habits: [], tools: [] },
    { key: "converse", label: "Synthesize", activity_count: 0, activity_share: 0,
      main_activity_count: 0, subagent_activity_count: 0,
      text_assistant_step_count: 0,
      tool_count: 0, session_count: 0, habits: [], tools: [] },
  ]),
};

const evidencePayload: UsageMapEvidenceResponse = {
  node: "phase:explore", label: "Explore",
  rule: "Observed tool calls classified as Explore.",
  activity_count: 50,
  sessions: [{ session_id: 7, title: "Fix importer", project_name: "alpha",
               session_cost_usd: 30, activity_count: 12,
               exemplar_event_ids: [101], detail: null }],
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
  it("renders observed activity, phase shares, and neutral pattern leaves", () => {
    const { container } = render(<MindmapCanvas phases={PHASES} totalActivity={100}
                          selectedNodeId={null} onSelectNode={vi.fn()} />);
    expect(screen.getByText("Observed")).toBeInTheDocument();
    expect(screen.getByText("Explore")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("Repeated file…")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Activity map" }))
      .toHaveTextContent(/not cost attribution/i);
    expect(container.querySelector(".is-good")).toBeNull();
    expect(container.querySelector(".is-anti")).toBeNull();
  });

  it("uses compact label plates and keeps full labels available to assistive technology", () => {
    const { container } = render(<MindmapCanvas phases={PHASES} totalActivity={100}
                          selectedNodeId={null} onSelectNode={vi.fn()} />);
    expect(container.querySelectorAll(".mindmap-label-plate").length)
      .toBeGreaterThan(0);
    expect(container.querySelector(".mindmap-label-plate text"))
      .toHaveAttribute("font-size", "9");
    expect(screen.getByRole("button", { name: /Repeated file re-reads/ }))
      .toBeInTheDocument();
    expect(container.querySelector(".mindmap-node-metric"))
      .not.toBeNull();
  });

  it("fires onSelectNode when a node is clicked", () => {
    const onSelect = vi.fn();
    render(<MindmapCanvas phases={PHASES} totalActivity={100}
                          selectedNodeId={null} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Explore: 50%/ }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "phase:explore" }));
  });

  it("renders tool leaves and a tool legend in the tools lens", () => {
    const { container } = render(
      <MindmapCanvas phases={PHASES} totalActivity={100}
                     selectedNodeId={null} onSelectNode={vi.fn()}
                     leafMode="tools" />);
    expect(screen.getByRole("button", { name: /Read: 30 calls/ })).toBeInTheDocument();
    expect(screen.queryByText("Repeated file re-reads")).not.toBeInTheDocument();
    expect(container.querySelector(".mindmap-legend i.is-tool")).not.toBeNull();
    expect(container.querySelector(".mindmap-legend i.is-pattern")).toBeNull();
  });

  it("dims non-neighbors while hovering a node", () => {
    const { container } = render(
      <MindmapCanvas phases={PHASES} totalActivity={100}
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
  beforeEach(() => {
    vi.mocked(getUsageMapEvidence).mockClear();
  });

  it("labels the view as an observed-activity map", async () => {
    renderPage();
    expect(await screen.findByRole("heading", { name: "Activity map" }))
      .toBeInTheDocument();
    expect(screen.getByText(/observed activity, not cost attribution/i)).toBeInTheDocument();
    expect(await screen.findByText(/classified as Explore/)).toBeInTheDocument();
    expect(screen.getByText("Share of observed activity")).toBeInTheDocument();
    expect(screen.queryByText(/share of spend/i)).not.toBeInTheDocument();
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
  });

  it("links evidence sessions and exemplar events back to investigation", async () => {
    const onOpenSession = vi.fn();
    renderPage(onOpenSession);
    await screen.findByText(/classified as Explore/);
    expect(screen.queryByRole("button", { name: "Fix importer" }))
      .not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: "View 1 receipt" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Fix importer" }));
    expect(onOpenSession).toHaveBeenCalledWith(7, null);
    fireEvent.click(screen.getByRole("button", { name: "Event 101" }));
    expect(onOpenSession).toHaveBeenCalledWith(7, 101);
    expect(screen.getByText(/session cost in selected window/i)).toBeInTheDocument();
  });

  it("resets the selection when filters change", async () => {
    const { container } = renderPage();
    await screen.findByText("Observed");
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
    await screen.findByText("Observed");
    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-06-01" } });
    fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-06-10" } });
    fireEvent.click(screen.getByLabelText("Compare with previous period"));
    expect((await screen.findAllByText("=")).length).toBeGreaterThan(0);
  });

  it("offers JSON and PNG export buttons", async () => {
    renderPage();
    await screen.findByText("Observed");
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export PNG" })).toBeInTheDocument();
  });

  it("switches between the neutral patterns and tools lenses", async () => {
    renderPage();
    await screen.findByText("Observed");
    expect(screen.getByText("Repeated file re-reads")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(await screen.findByRole("button", { name: /Read: 30 calls/ })).toBeInTheDocument();
    expect(screen.queryByText("Repeated file re-reads")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Patterns" }));
    expect(await screen.findByText("Repeated file re-reads")).toBeInTheDocument();
  });

  it("resets the selection to the most active phase when the lens changes", async () => {
    const { container } = renderPage();
    await screen.findByText("Observed");
    fireEvent.click(screen.getByRole("button", { name: /Implement: 30%/ }));
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    await waitFor(() => {
      const selected = container.querySelectorAll(".mindmap-node.is-selected");
      expect(selected).toHaveLength(1);
      expect(selected[0].getAttribute("aria-label")).toMatch(/^Explore/);
    });
  });

  it("requests tool evidence when a tool node is clicked", async () => {
    renderPage();
    await screen.findByText("Observed");
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    fireEvent.click(await screen.findByRole("button", { name: /Read: 30 calls/ }));
    await waitFor(() => {
      expect(vi.mocked(getUsageMapEvidence)).toHaveBeenCalledWith(
        "tool:Read@explore", expect.anything());
    });
  });

  it("rescales activity shares when the origin filter is set to Subagents", async () => {
    renderPage();
    await screen.findByText("Observed");
    fireEvent.click(screen.getByRole("button", { name: "Subagents" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Explore: 100%/ })).toBeInTheDocument();
    });
  });
});

describe("activity map export", () => {
  it("exports observed activity fields without causal cost allocation", () => {
    const exported = buildActivityMapExport(mapPayload);
    const json = JSON.stringify(exported);

    expect(exported.export_kind).toBe("observed_activity_map");
    expect(exported.methodology).toMatch(/not cost attribution/i);
    expect(json).toContain("activity_count");
    expect(json).not.toContain("cost_usd");
    expect(json).not.toContain("total_tokens");
    expect(json).not.toContain("main_cost");
    expect(json).not.toContain("subagent_cost");
    expect(json).not.toContain("share_of_spend");
  });
});
