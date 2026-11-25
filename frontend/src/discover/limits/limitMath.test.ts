import { describe, expect, it, vi } from "vitest";
import type { LimitEraEntry } from "../../api/types";
import * as limitMath from "./limitMath";
import {
  eraDateRange,
  eraHitLevel,
  eraName,
  formatLimitTick,
  formatLimitValue,
  formatResetInterval,
} from "./limitMath";

function era(overrides: Partial<LimitEraEntry>): LimitEraEntry {
  return {
    era: "Pro", window_count: 10, session_hit_count: 2, minutes_until_reset: 60,
    hit_level_median_usd: 10, hit_level_min_usd: 8, hit_level_max_usd: 12,
    hit_level_median_tokens: 1000, hit_level_min_tokens: 800, hit_level_max_tokens: 1200,
    hit_level_percentile: 0.7, hit_level_percentile_tokens: 0.95,
    usage_at_hit_usd: [8, 12], usage_at_hit_tokens: [800, 1200],
    start_date: "2026-05-01", end_date: "2026-06-01", weeks: 4, hits_per_week: 0.5,
    ...overrides,
  };
}

describe("formatLimitValue and formatLimitTick", () => {
  it("keeps cents on measured values so a cheap window is not a free one", () => {
    expect(formatLimitValue(0.04, "cost")).toBe("$0.04");
    expect(formatLimitValue(2.47, "cost")).toBe("$2.47");
    expect(formatLimitValue(0, "cost")).toBe("$0");
    expect(formatLimitValue(null, "cost")).toBe("n/a");
    expect(formatLimitValue(900_000, "tokens")).toBe("900k tok");
  });

  it("rounds axis ticks, which sit in a narrow gutter", () => {
    expect(formatLimitTick(52.5, "cost")).toBe("$53");
    expect(formatLimitTick(2.47, "cost")).toBe("$2.5");
    expect(formatLimitTick(0, "cost")).toBe("$0");
    expect(formatLimitTick(333.25, "tokens")).toBe("333 tok");
    expect(formatLimitTick(2_300_000, "tokens")).toBe("2.3M tok");
  });
});

describe("eraDateRange and eraName", () => {
  // Pinned clock and locale: the year rule depends on "now", and the month
  // names on the runtime locale (a French machine prints "1 mai").
  const now = new Date("2026-11-24T12:00:00Z");
  const range = (overrides: Partial<LimitEraEntry>) =>
    eraDateRange(era(overrides), now, "en-US");

  it("labels a period by its plan dates, end exclusive", () => {
    expect(range({})).toBe("May 1 – Jun 1");
    expect(range({ end_date: null })).toBe("since May 1");
    expect(range({ start_date: null })).toBe("until Jun 1");
    expect(range({ start_date: null, end_date: null })).toBeNull();
  });

  it("reads plan dates as calendar days, not local midnight", () => {
    // "2026-05-01" parsed as UTC midnight would print Apr 30 west of UTC.
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      expect(range({ start_date: "2026-05-01", end_date: null })).toBe("since May 1");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("adds the year only when it is not the current one", () => {
    expect(range({ start_date: "2025-12-01", end_date: "2026-02-01" }))
      .toBe("Dec 1, 2025 – Feb 1");
  });

  it("names the unplanned period by whether other periods exist", () => {
    expect(eraName(era({ era: "Pro" }), 3)).toBe("Pro");
    expect(eraName(era({ era: "" }), 1)).toBe("All usage");
    expect(eraName(era({ era: "" }), 2)).toBe("Before plan history");
  });
});

describe("eraHitLevel and reset formatting", () => {
  it("selects matching observed fields for each basis", () => {
    expect(eraHitLevel(era({}), "cost")).toEqual({
      values: [8, 12], median: 10, min: 8, max: 12, percentile: 0.7,
    });
    expect(eraHitLevel(era({}), "tokens")).toEqual({
      values: [800, 1200], median: 1000, min: 800, max: 1200, percentile: 0.95,
    });
  });

  it("formats the reset-minus-hit interval neutrally", () => {
    expect(formatResetInterval(49.3)).toBe("0.8h");
    expect(formatResetInterval(0)).toBe("0h");
  });
});

describe("automatic verdict removal", () => {
  it("does not export a plan-fit verdict builder", () => {
    expect(limitMath).not.toHaveProperty("buildVerdict");
  });
});
