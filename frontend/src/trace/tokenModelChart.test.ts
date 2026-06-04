import { describe, expect, it } from "vitest";
import { buildTokenModelChart, sessionMaxForMetric, sessionSumForMetric } from "./tokenModelChart";
import type { ChartPointInput } from "./tokenModelChart";

const identity = (coord: number) => coord;

// model-bearing spans plus zero-token and null-model spans that must be ignored
const spans: ChartPointInput[] = [
  { event_id: 1, anchorCoord: 0, model: "claude-opus-4-7", input_tokens: 80, output_tokens: 20, start_ts: "t1" },
  { event_id: 2, anchorCoord: 25, model: "claude-opus-4-7", input_tokens: 40, output_tokens: 10, start_ts: "t2" },
  { event_id: 3, anchorCoord: 50, model: "claude-sonnet-4-6", input_tokens: 90, output_tokens: 10, start_ts: "t3" },
  { event_id: 4, anchorCoord: 75, model: "claude-opus-4-7", input_tokens: 5, output_tokens: 0, start_ts: "t4" },
  { event_id: 5, anchorCoord: 85, model: "claude-opus-4-7", input_tokens: 0, output_tokens: 0, start_ts: "t5" },
  { event_id: 9, anchorCoord: 10, model: null, input_tokens: 9999, output_tokens: 9999 },
];

describe("sessionMaxForMetric", () => {
  it("returns the peak metric over model-bearing spans, ignoring null-model spans", () => {
    expect(sessionMaxForMetric(spans, "total")).toBe(100);
    expect(sessionMaxForMetric(spans, "input")).toBe(90);
    expect(sessionMaxForMetric(spans, "output")).toBe(20);
  });

  it("returns 0 when no span carries a model", () => {
    expect(sessionMaxForMetric([{ event_id: 9, anchorCoord: 1, model: null, input_tokens: 5, output_tokens: 5 }], "total")).toBe(0);
  });
});

describe("sessionSumForMetric", () => {
  it("sums the metric over model-bearing spans, ignoring null-model spans", () => {
    // input: 80+40+90+5+0 = 215 · output: 20+10+10+0+0 = 40 · total: 100+50+100+5+0 = 255
    expect(sessionSumForMetric(spans, "input")).toBe(215);
    expect(sessionSumForMetric(spans, "output")).toBe(40);
    expect(sessionSumForMetric(spans, "total")).toBe(255);
  });

  it("keeps total equal to input + output (the whole point of the readout)", () => {
    expect(sessionSumForMetric(spans, "total")).toBe(
      sessionSumForMetric(spans, "input") + sessionSumForMetric(spans, "output"),
    );
  });

  it("returns 0 when no span carries a model", () => {
    expect(sessionSumForMetric([{ event_id: 9, anchorCoord: 1, model: null, input_tokens: 5, output_tokens: 5 }], "total")).toBe(0);
  });
});

describe("buildTokenModelChart", () => {
  it("places points on a log session-max scale in coordinate order", () => {
    const { points } = buildTokenModelChart(spans, identity, 100, 100, "total", 100);
    expect(points).toHaveLength(4); // null-model and zero-token spans excluded
    expect(points[0]).toMatchObject({ x: 0, y: 0, value: 100, event_id: 1 }); // peak -> top
    // Log scale: 50 of 100 sits well above the linear midpoint (closer to the top).
    expect(points[1].y).toBeCloseTo(100 - (Math.log1p(50) / Math.log1p(100)) * 100, 5);
    expect(points[1].y).toBeLessThan(50);
    expect(points[3]).toMatchObject({ x: 75, value: 5, event_id: 4 });
    expect(points.some((point) => point.event_id === 5)).toBe(false);
  });

  it("can place points on a linear session-max scale when log scaling is disabled", () => {
    const { points } = buildTokenModelChart(spans, identity, 100, 100, "total", 100, false);
    expect(points).toHaveLength(4);
    expect(points[0].y).toBe(0);
    expect(points[1].y).toBe(50);
    expect(points[3].y).toBe(95);
  });

  it("groups consecutive same-model edges into one segment, splitting at a model change", () => {
    const { segments } = buildTokenModelChart(spans, identity, 100, 100, "total", 100);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ model: "claude-opus-4-7", firstEventId: 1 });
    expect(segments[1]).toMatchObject({ model: "claude-sonnet-4-6", firstEventId: 3 });
    expect(segments[0].areaPath.startsWith("M 0,100")).toBe(true);
    expect(segments[0].areaPath.endsWith("Z")).toBe(true);
    expect(segments[0].linePath.startsWith("M 0,0")).toBe(true);
  });

  it("clamps point x to the visible track when the projector pushes them offscreen", () => {
    const shifted = (coord: number) => coord - 60; // 0,25,50 -> negative; 75 -> 15
    const { points } = buildTokenModelChart(spans, shifted, 100, 100, "total", 100);
    expect(points[0].x).toBe(0); // clamped left
    expect(points[3].x).toBe(15);
  });

  it("returns no points for zero-token spans", () => {
    const { points } = buildTokenModelChart([spans[4]], identity, 100, 100, "total", 0);
    expect(points).toEqual([]);
  });

  it("returns one point and no segment for a single model-bearing span", () => {
    const single = [spans[0]];
    const { points, segments } = buildTokenModelChart(single, identity, 100, 100, "total", 100);
    expect(points).toHaveLength(1);
    expect(segments).toHaveLength(0);
  });

  it("produces a single segment when every model-bearing span uses the same model", () => {
    const sameModel: ChartPointInput[] = [
      { event_id: 1, anchorCoord: 0, model: "claude-opus-4-7", input_tokens: 10, output_tokens: 0 },
      { event_id: 2, anchorCoord: 25, model: "claude-opus-4-7", input_tokens: 20, output_tokens: 0 },
      { event_id: 3, anchorCoord: 50, model: "claude-opus-4-7", input_tokens: 30, output_tokens: 0 },
    ];
    const { segments } = buildTokenModelChart(sameModel, identity, 100, 100, "total", 30);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ model: "claude-opus-4-7", firstEventId: 1 });
  });

  it("returns empty points and segments when no span carries a model", () => {
    const { points, segments } = buildTokenModelChart([spans[5]], identity, 100, 100, "total", 0);
    expect(points).toEqual([]);
    expect(segments).toEqual([]);
  });
});
