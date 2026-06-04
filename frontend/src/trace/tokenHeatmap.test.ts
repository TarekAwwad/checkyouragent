import { describe, expect, it } from "vitest";
import { metricValue } from "./tokenHeatmap";

describe("metricValue", () => {
  it("selects input, output, or the sum", () => {
    const s = { input_tokens: 100, output_tokens: 10 };
    expect(metricValue(s, "input")).toBe(100);
    expect(metricValue(s, "output")).toBe(10);
    expect(metricValue(s, "total")).toBe(110);
  });
});
