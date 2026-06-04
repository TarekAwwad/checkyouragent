import { describe, expect, it } from "vitest";
import { distinctModels, modelColor, shortModelName } from "./modelLane";
import type { ModelInput } from "./modelLane";

const spans: ModelInput[] = [
  { anchorCoord: 10, model: "claude-opus-4-7" },
  { anchorCoord: 30, model: null },
  { anchorCoord: 50, model: "claude-sonnet-4-6" },
  { anchorCoord: 80, model: "claude-opus-4-7" },
];

describe("distinctModels", () => {
  it("returns distinct models in first-appearance order", () => {
    expect(distinctModels(spans)).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });
});

describe("shortModelName", () => {
  it("strips the claude- prefix and trailing date", () => {
    expect(shortModelName("claude-opus-4-7")).toBe("opus-4-7");
    expect(shortModelName("claude-sonnet-4-6")).toBe("sonnet-4-6");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });

  it("passes through values without the claude- prefix", () => {
    expect(shortModelName("<synthetic>")).toBe("<synthetic>");
  });
});

describe("modelColor", () => {
  it("assigns a stable distinct color per model by ordered position", () => {
    const ordered = ["claude-opus-4-7", "claude-sonnet-4-6"];
    expect(modelColor("claude-opus-4-7", ordered)).toBe(modelColor("claude-opus-4-7", ordered));
    expect(modelColor("claude-opus-4-7", ordered)).not.toBe(modelColor("claude-sonnet-4-6", ordered));
  });
});
