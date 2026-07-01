import { describe, expect, it } from "vitest";
import { buildAreaChart } from "./teamCharts";

describe("buildAreaChart", () => {
  it("returns empty geometry for no data", () => {
    const chart = buildAreaChart([], 100, 50);
    expect(chart.linePath).toBe("");
    expect(chart.areaPath).toBe("");
    expect(chart.points).toEqual([]);
    expect(chart.yMax).toBe(0);
  });

  it("maps values into an area + line path scaled to the max", () => {
    const chart = buildAreaChart(
      [
        { label: "a", value: 10 },
        { label: "b", value: 20 },
      ],
      100,
      50,
    );
    expect(chart.yMax).toBe(20);
    expect(chart.linePath).toBe("M0,25 L100,0");
    expect(chart.areaPath).toBe("M0,25 L100,0 L100,50 L0,50 Z");
    expect(chart.points).toEqual([
      { x: 0, y: 25, label: "a", value: 10 },
      { x: 100, y: 0, label: "b", value: 20 },
    ]);
  });

  it("flattens to the baseline when every value is zero", () => {
    const chart = buildAreaChart(
      [
        { label: "a", value: 0 },
        { label: "b", value: 0 },
      ],
      100,
      50,
    );
    expect(chart.yMax).toBe(0);
    expect(chart.linePath).toBe("M0,50 L100,50");
  });

  it("places a single point on the left", () => {
    const chart = buildAreaChart([{ label: "a", value: 5 }], 100, 50);
    expect(chart.points).toEqual([{ x: 0, y: 0, label: "a", value: 5 }]);
    expect(chart.linePath).toBe("M0,0");
  });
});
