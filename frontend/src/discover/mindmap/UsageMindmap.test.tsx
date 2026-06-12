import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { UsagePhase } from "../../api/types";
import MindmapCanvas from "./MindmapCanvas";
import ShareRail from "./ShareRail";

const PHASES: UsagePhase[] = [
  {
    key: "explore", label: "Explore", cost_usd: 50, tokens: 0, share: 0.5,
    tool_count: 10, session_count: 3,
    habits: [{ key: "re-reads", phase: "explore", label: "Repeated file re-reads",
               polarity: "anti", status: "confirmed", cost_usd: 5, count: 4,
               session_count: 2 }],
  },
  { key: "implement", label: "Implement", cost_usd: 30, tokens: 0, share: 0.3,
    tool_count: 6, session_count: 3, habits: [] },
  { key: "verify", label: "Verify", cost_usd: 20, tokens: 0, share: 0.2,
    tool_count: 4, session_count: 2, habits: [] },
];

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
});

describe("ShareRail", () => {
  it("shows one segment per phase with exact percentages", () => {
    render(<ShareRail phases={PHASES} selectedPhaseKey={null} onSelect={vi.fn()} />);
    expect(screen.getByText("Explore 50%")).toBeInTheDocument();
    expect(screen.getByText("Implement 30%")).toBeInTheDocument();
    expect(screen.getByText("Verify 20%")).toBeInTheDocument();
  });

  it("selects a phase on click", () => {
    const onSelect = vi.fn();
    render(<ShareRail phases={PHASES} selectedPhaseKey={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /Explore 50%/ }));
    expect(onSelect).toHaveBeenCalledWith("explore");
  });
});
