import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TraceView from "./TraceView";
import type { SessionCost, TraceResponse } from "../api/types";

const emptyCost: SessionCost = {
  usd: 0,
  available: false,
  unpriced_models: [],
  tokens: { base_input: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 0 },
};

const trace: TraceResponse = {
  session_id: 1,
  first_ts: "2026-01-01T00:00:00Z",
  last_ts: "2026-01-01T00:10:00Z",
  lanes: [
    { lane_id: "main", label: "main thread", kind: "main" },
    { lane_id: "a1", label: "a1", kind: "subagent" },
  ],
  spans: [
    { id: "span-1", event_id: 1, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:01:00Z", end_ts: "2026-01-01T00:02:00Z", tool_use_id: "u1", tool_name: "Read", is_loop: true },
    { id: "span-2", event_id: 2, lane: "a1", kind: "subagent_event", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:05:00Z", end_ts: null, tool_use_id: null, tool_name: null, is_loop: false },
  ],
  cost: emptyCost,
};

const loopTrace: TraceResponse = {
  session_id: 2,
  first_ts: "2026-01-01T00:00:00Z",
  last_ts: "2026-01-01T00:10:00Z",
  lanes: [
    { lane_id: "main", label: "main thread", kind: "main" },
  ],
  spans: [
    { id: "span-1", event_id: 1, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:01:00Z", end_ts: "2026-01-01T00:01:30Z", tool_use_id: "u1", tool_name: "Read", is_loop: true, loop_run_id: "main-tool-loop-1", loop_position: 1, loop_count: 3, loop_start_event_id: 1, loop_end_event_id: 3 },
    { id: "span-2", event_id: 2, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:02:00Z", end_ts: "2026-01-01T00:02:30Z", tool_use_id: "u2", tool_name: "Read", is_loop: true, loop_run_id: "main-tool-loop-1", loop_position: 2, loop_count: 3, loop_start_event_id: 1, loop_end_event_id: 3 },
    { id: "span-3", event_id: 3, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:03:00Z", end_ts: "2026-01-01T00:03:30Z", tool_use_id: "u3", tool_name: "Read", is_loop: true, loop_run_id: "main-tool-loop-1", loop_position: 3, loop_count: 3, loop_start_event_id: 1, loop_end_event_id: 3 },
    { id: "span-4", event_id: 4, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:08:00Z", end_ts: "2026-01-01T00:08:30Z", tool_use_id: "u4", tool_name: "Bash", is_loop: false },
  ],
  cost: emptyCost,
};

const gapTrace: TraceResponse = {
  session_id: 3,
  first_ts: "2026-01-01T00:00:00Z",
  last_ts: "2026-01-01T00:10:00Z",
  lanes: [
    { lane_id: "main", label: "main thread", kind: "main" },
  ],
  spans: [
    { id: "gap-1", event_id: 1, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:01:00Z", end_ts: "2026-01-01T00:01:20Z", tool_use_id: "u1", tool_name: "Read", is_loop: false },
    { id: "gap-2", event_id: 2, lane: "main", kind: "tool_result", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:02:00Z", end_ts: "2026-01-01T00:02:20Z", tool_use_id: "u2", tool_name: "Read", is_loop: false },
    { id: "gap-3", event_id: 3, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:09:00Z", end_ts: "2026-01-01T00:09:20Z", tool_use_id: "u3", tool_name: "Write", is_loop: false },
  ],
  cost: emptyCost,
};

const interleavedLoopTrace: TraceResponse = {
  session_id: 4,
  first_ts: "2026-01-01T00:00:00Z",
  last_ts: "2026-01-01T00:06:00Z",
  lanes: [
    { lane_id: "main", label: "main thread", kind: "main" },
  ],
  spans: [
    { id: "call-1", event_id: 1, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:01:00Z", end_ts: "2026-01-01T00:01:10Z", tool_use_id: "u1", tool_name: "Read", is_loop: true, loop_run_id: "main-tool-loop-1", loop_position: 1, loop_count: 3, loop_start_event_id: 1, loop_end_event_id: 5 },
    { id: "result-2", event_id: 2, lane: "main", kind: "tool_result", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:01:10Z", end_ts: null, tool_use_id: "u1", tool_name: null, is_loop: false },
    { id: "call-3", event_id: 3, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:02:00Z", end_ts: "2026-01-01T00:02:10Z", tool_use_id: "u2", tool_name: "Read", is_loop: true, loop_run_id: "main-tool-loop-1", loop_position: 2, loop_count: 3, loop_start_event_id: 1, loop_end_event_id: 5 },
    { id: "result-4", event_id: 4, lane: "main", kind: "tool_result", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:02:10Z", end_ts: null, tool_use_id: "u2", tool_name: null, is_loop: false },
    { id: "call-5", event_id: 5, lane: "main", kind: "tool_call", input_tokens: 0, output_tokens: 0, model: null, start_ts: "2026-01-01T00:03:00Z", end_ts: "2026-01-01T00:03:10Z", tool_use_id: "u3", tool_name: "Read", is_loop: true, loop_run_id: "main-tool-loop-1", loop_position: 3, loop_count: 3, loop_start_event_id: 1, loop_end_event_id: 5 },
  ],
  cost: emptyCost,
};

const chartTrace: TraceResponse = {
  session_id: 7,
  first_ts: "2026-01-01T00:00:00Z",
  last_ts: "2026-01-01T00:10:00Z",
  lanes: [
    { lane_id: "main", label: "main thread", kind: "main" },
  ],
  spans: [
    { id: "c-1", event_id: 1, lane: "main", kind: "assistant", input_tokens: 1000, output_tokens: 100, model: "claude-opus-4-7", start_ts: "2026-01-01T00:01:00Z", end_ts: null, tool_use_id: null, tool_name: null, is_loop: false },
    { id: "c-2", event_id: 2, lane: "main", kind: "assistant", input_tokens: 100, output_tokens: 1000, model: "claude-sonnet-4-6", start_ts: "2026-01-01T00:08:00Z", end_ts: null, tool_use_id: null, tool_name: null, is_loop: false },
  ],
  cost: {
    usd: 1.23,
    available: true,
    unpriced_models: [],
    tokens: { base_input: 1100, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 1100 },
  },
};

const denseTrace: TraceResponse = {
  session_id: 8,
  first_ts: "2026-01-01T00:00:00Z",
  last_ts: "2026-01-01T00:10:00Z",
  lanes: [
    { lane_id: "main", label: "main thread", kind: "main" },
    { lane_id: "a1", label: "a1", kind: "subagent" },
  ],
  spans: Array.from({ length: 7 }, (_, index) => ({
    id: `dense-${index + 10}`,
    event_id: index + 10,
    lane: index < 6 ? "main" : "a1",
    kind: index < 6 ? "assistant" : "subagent_event",
    input_tokens: 0,
    output_tokens: 0,
    model: null,
    start_ts: `2026-01-01T00:01:0${index}Z`,
    end_ts: null,
    tool_use_id: null,
    tool_name: null,
    is_loop: false,
  })),
  cost: emptyCost,
};

function eventX(container: HTMLElement, eventId: number): number {
  const span = container.querySelector(`[data-event-id="${eventId}"]`);
  expect(span).not.toBeNull();
  return Number((span as SVGElement).getAttribute("x"));
}

describe("TraceView", () => {
  it("renders one labeled row per lane", () => {
    render(<TraceView trace={trace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);
    expect(screen.getByText("main thread")).toBeInTheDocument();
    expect(screen.getByText("a1")).toBeInTheDocument();
  });

  it("selects an event when a span is clicked", () => {
    const onSelect = vi.fn();
    const { container } = render(<TraceView trace={trace} selectedEventId={null} playheadTimestamp={null} onSelect={onSelect} />);
    const span = container.querySelector('[data-event-id="1"]');
    expect(span).not.toBeNull();
    fireEvent.click(span as Element);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("explains the trace visualization colors", () => {
    render(<TraceView trace={trace} selectedEventId={1} playheadTimestamp={null} onSelect={() => {}} />);

    const legend = screen.getByLabelText("Trace visualization legend");
    expect(legend).toHaveTextContent("User turn");
    expect(legend).toHaveTextContent("Assistant");
    expect(legend).toHaveTextContent("Tool call/result");
    expect(legend).toHaveTextContent("Subagent");
    expect(legend).toHaveTextContent("System / tool error");
    expect(legend).toHaveTextContent("Loop span");
    expect(legend).toHaveTextContent("Selected event");
  });

  it("keeps trace controls visible", () => {
    render(<TraceView trace={chartTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    expect(screen.queryByText("View options")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Subagent" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Group dense" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Log scale" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Timeline spacing" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Token metric" })).toBeInTheDocument();
  });

  it("filters visible spans when legend event types are toggled", () => {
    const { container } = render(<TraceView trace={trace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Subagent" }));

    expect(container.querySelector('[data-event-id="1"]')).toBeNull();
    expect(container.querySelector('[data-event-id="2"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Subagent" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Subagent" }));

    expect(container.querySelector('[data-event-id="1"]')).not.toBeNull();
    expect(container.querySelector('[data-event-id="2"]')).not.toBeNull();
  });

  it("renders every repeated loop event as its own uniform span", () => {
    const { container } = render(<TraceView trace={loopTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    expect(container.querySelector('[data-event-id="1"]')).not.toBeNull();
    expect(container.querySelector('[data-event-id="2"]')).not.toBeNull();
    expect(container.querySelector('[data-event-id="3"]')).not.toBeNull();
    // No "\u00d7N" text overlay, and no SVG text in the lanes at all.
    expect(screen.queryByText("Read \u00d73")).toBeNull();
    expect(container.querySelector(".trace-lanes text")).toBeNull();
  });

  it("keeps interleaved loop calls and results as individual spans", () => {
    const { container } = render(<TraceView trace={interleavedLoopTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    [1, 2, 3, 4, 5].forEach((id) =>
      expect(container.querySelector(`[data-event-id="${id}"]`)).not.toBeNull(),
    );
    expect(screen.queryByText("Read \u00d73")).toBeNull();
  });

  it("marks a loop run with a clickable region band that selects the run", () => {
    const onSelect = vi.fn();
    const { container } = render(<TraceView trace={loopTrace} selectedEventId={null} playheadTimestamp={null} onSelect={onSelect} />);

    const region = container.querySelector("[data-loop-region]");
    expect(region).not.toBeNull();
    fireEvent.click(region as Element);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("brushes the minimap to zoom the visible trace window", () => {
    const { container } = render(<TraceView trace={trace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);
    const minimap = container.querySelector(".trace-minimap svg") as SVGSVGElement;

    expect(container.querySelector('[data-event-id="2"]')).not.toBeNull();
    fireEvent.mouseDown(minimap, { clientX: 0 });
    fireEvent.mouseMove(minimap, { clientX: 300 });
    fireEvent.mouseUp(minimap, { clientX: 300 });

    expect(container.querySelector('[data-event-id="1"]')).not.toBeNull();
    expect(container.querySelector('[data-event-id="2"]')).toBeNull();
  });

  it("draws a replay playhead on the minimap, lanes, and token chart", () => {
    const { container } = render(<TraceView trace={trace} selectedEventId={null} playheadTimestamp="2026-01-01T00:05:00Z" onSelect={() => {}} />);

    expect(container.querySelector('[data-playhead="minimap"]')).not.toBeNull();
    expect(container.querySelector('[data-playhead="lane-main"]')).not.toBeNull();
    expect(container.querySelector('[data-playhead="chart"]')).not.toBeNull();
  });

  it("offers raw, compressed, and normalized spacing modes", () => {
    render(<TraceView trace={trace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    expect(screen.getByRole("option", { name: "Raw time" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Compressed gaps" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Event order" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Group dense" })).toBeChecked();
  });

  it("batches dense lane events and drills into the batch on click", () => {
    const { container } = render(<TraceView trace={denseTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    const batch = container.querySelector("[data-trace-batch]");
    expect(batch).not.toBeNull();
    expect(batch).toHaveAttribute("data-batch-size", "6");
    expect(batch).toHaveAttribute("data-batch-event-ids", "10,11,12,13,14,15");
    expect(container.querySelector('[data-event-id="10"]')).toBeNull();

    fireEvent.click(batch as Element);

    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(container.querySelector(".trace-brush")).not.toBeNull();
    expect(container.querySelector("[data-trace-batch]")).toBeNull();
    expect(container.querySelector('[data-event-id="10"]')).not.toBeNull();
    expect(container.querySelector('[data-event-id="15"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(container.querySelector(".trace-brush")).toBeNull();
    expect(container.querySelector("[data-trace-batch]")).not.toBeNull();
    expect(container.querySelector('[data-event-id="10"]')).toBeNull();
  });

  it("can disable dense event batching", () => {
    const { container } = render(<TraceView trace={denseTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Group dense" }));

    expect(container.querySelector("[data-trace-batch]")).toBeNull();
    expect(container.querySelector('[data-event-id="10"]')).not.toBeNull();
    expect(container.querySelector('[data-event-id="15"]')).not.toBeNull();
  });

  it("compresses long empty gaps by default while preserving a raw mode", () => {
    const { container } = render(<TraceView trace={gapTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);
    const spacing = screen.getByLabelText("Timeline spacing");

    const compressedX = eventX(container, 3);
    fireEvent.change(spacing, { target: { value: "raw" } });
    const rawX = eventX(container, 3);

    expect(compressedX).toBeLessThan(rawX);
  });

  it("can normalize spans to even event ordering", () => {
    const { container } = render(<TraceView trace={gapTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    fireEvent.change(screen.getByLabelText("Timeline spacing"), { target: { value: "normalized" } });

    const first = eventX(container, 1);
    const second = eventX(container, 2);
    const third = eventX(container, 3);

    expect(second - first).toBeCloseTo(third - second, 5);
  });

  it("renders a token+model chart with a metric toggle and a model legend", () => {
    const { container } = render(<TraceView trace={chartTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    expect(screen.getByLabelText("Token usage by model")).toBeInTheDocument();
    const metric = screen.getByLabelText("Token metric");
    const scale = screen.getByRole("checkbox", { name: "Log scale" });
    expect(metric).toBeInTheDocument();
    expect(scale).toBeChecked();
    expect(container.querySelector(".trace-view-options")).toBeNull();
    expect(container.querySelector(".trace-chart-footer .trace-chart-toggle")).not.toBeNull();
    expect(container.querySelector(".trace-chart-gutter .trace-chart-toggle")).toBeNull();
    expect(container.querySelector(".trace-chart-gutter .trace-token-metric")).not.toBeNull();
    expect(container.querySelector(".trace-chart-gutter .trace-token-total")).not.toBeNull();
    expect(container.querySelector(".trace-chart-gutter .trace-chart-scale")).toBeNull();
    expect(screen.getByRole("option", { name: "Total" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Input" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Output" })).toBeInTheDocument();
    expect(screen.getByText("2.2k total tokens")).toBeInTheDocument();
    expect(screen.getByText("opus-4-7")).toBeInTheDocument();
    expect(screen.getByText("sonnet-4-6")).toBeInTheDocument();
  });

  it("shows the estimated cost when pricing is available", () => {
    const { rerender } = render(<TraceView trace={chartTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);
    expect(screen.getByText("$1.23")).toBeInTheDocument();

    // No cost chip when pricing is unavailable.
    rerender(<TraceView trace={trace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);
    expect(screen.queryByText("$1.23")).toBeNull();
  });

  it("redraws the chart area when the token metric changes", () => {
    const { container } = render(<TraceView trace={chartTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);
    // Raw spacing makes the projection (and thus the path) deterministic.
    fireEvent.change(screen.getByLabelText("Timeline spacing"), { target: { value: "raw" } });

    const areaD = () => (container.querySelector(".trace-chart-track path") as SVGPathElement).getAttribute("d");
    fireEvent.change(screen.getByLabelText("Token metric"), { target: { value: "input" } });
    const inputD = areaD();
    fireEvent.change(screen.getByLabelText("Token metric"), { target: { value: "output" } });
    expect(areaD()).not.toBe(inputD);
  });

  it("can turn the logarithmic token scale off", () => {
    const { container } = render(<TraceView trace={chartTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);
    fireEvent.change(screen.getByLabelText("Timeline spacing"), { target: { value: "raw" } });
    fireEvent.change(screen.getByLabelText("Token metric"), { target: { value: "input" } });

    const areaD = () => (container.querySelector(".trace-chart-track path") as SVGPathElement).getAttribute("d");
    const scale = screen.getByRole("checkbox", { name: "Log scale" });
    const logD = areaD();

    fireEvent.click(scale);

    expect(scale).not.toBeChecked();
    expect(areaD()).not.toBe(logD);
  });

  it("exposes a hover hit target per assistant message", () => {
    const { container } = render(<TraceView trace={chartTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    expect(container.querySelector('.trace-chart-track [data-point-event="1"]')).not.toBeNull();
    expect(container.querySelector('.trace-chart-track [data-point-event="2"]')).not.toBeNull();
  });

  it("no longer renders the old heatmap or model band lanes", () => {
    const { container } = render(<TraceView trace={chartTrace} selectedEventId={null} playheadTimestamp={null} onSelect={() => {}} />);

    expect(screen.queryByLabelText("Token usage heatmap")).toBeNull();
    expect(screen.queryByLabelText("Model timeline")).toBeNull();
    expect(container.querySelector(".trace-token-track")).toBeNull();
    expect(container.querySelector(".trace-model-track")).toBeNull();
  });
});
