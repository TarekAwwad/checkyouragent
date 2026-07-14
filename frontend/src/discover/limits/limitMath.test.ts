import { describe, expect, it } from "vitest";
import type { LimitEraEntry, LimitHitEntry, LimitWindowEntry } from "../../api/types";
import { activeEra, buildVerdict, eraRates, meanUsageAtHit } from "./limitMath";

function win(start: string, end: string, era: string, hit = false): LimitWindowEntry {
  return { start, end, value_usd: 10, tokens: 1, era, hit_kinds: hit ? ["session"] : [] };
}

function hit(windowIndex: number | null): LimitHitEntry {
  return {
    ts: "2026-07-01T01:00:00Z", kind: "session", reset_at: null,
    blocked_minutes: null, usage_at_hit: null, occurrence_count: 1,
    window_index: windowIndex, session_ids: [], session_titles: [],
  };
}

function era(overrides: Partial<LimitEraEntry>): LimitEraEntry {
  return {
    era: "Pro", window_count: 10, session_hit_count: 2, blocked_minutes: 60,
    cap_median_usd: 10, cap_min_usd: 8, cap_max_usd: 12, near_miss_count: 1,
    cap_percentile: 0.7, usage_at_hit_usd: [8, 12], ...overrides,
  };
}

describe("eraRates", () => {
  it("floors tenure at one week and counts hits per era", () => {
    const windows = [
      win("2026-07-01T00:00:00Z", "2026-07-01T05:00:00Z", "Pro", true),
      win("2026-07-02T00:00:00Z", "2026-07-02T05:00:00Z", "Pro"),
    ];
    const rates = eraRates(windows, [hit(0)]);
    expect(rates.get("Pro")).toMatchObject({ hitCount: 1, weeks: 1, perWeek: 1 });
  });

  it("uses real tenure once past a week and skips unattached hits", () => {
    const windows = [
      win("2026-06-01T00:00:00Z", "2026-06-01T05:00:00Z", "Pro", true),
      win("2026-06-15T00:00:00Z", "2026-06-15T05:00:00Z", "Pro", true),
    ];
    const rates = eraRates(windows, [hit(0), hit(1), hit(null)]);
    expect(rates.get("Pro")!.weeks).toBeGreaterThan(2);
    expect(rates.get("Pro")!.hitCount).toBe(2);
    expect(rates.get("Pro")!.perWeek).toBeCloseTo(1, 1);
  });
});

describe("activeEra and meanUsageAtHit", () => {
  it("reports the newest window's era and the mean hit usage", () => {
    const windows = [
      win("2026-06-01T00:00:00Z", "2026-06-01T05:00:00Z", "Pro"),
      win("2026-07-01T00:00:00Z", "2026-07-01T05:00:00Z", "Max 5x"),
    ];
    expect(activeEra(windows)).toBe("Max 5x");
    expect(activeEra([])).toBeNull();
    expect(meanUsageAtHit(era({}))).toBe(10);
    expect(meanUsageAtHit(era({ usage_at_hit_usd: [] }))).toBeNull();
  });
});

describe("buildVerdict", () => {
  it("calls a hit-free plan comfortably dimensioned", () => {
    const v = buildVerdict(
      era({ session_hit_count: 0, blocked_minutes: 0 }),
      { hitCount: 0, weeks: 4, perWeek: 0 },
    );
    expect(v?.tone).toBe("good");
    expect(v?.text).toMatch(/comfortably dimensioned/);
  });

  it("flags heavy weekly waiting as outgrown", () => {
    const v = buildVerdict(era({ blocked_minutes: 1000 }), { hitCount: 5, weeks: 2, perWeek: 2.5 });
    expect(v?.tone).toBe("tight");
    expect(v?.text).toMatch(/outgrown/);
  });

  it("calls a top-decile cap well dimensioned", () => {
    const v = buildVerdict(
      era({ cap_percentile: 0.95, blocked_minutes: 30 }),
      { hitCount: 1, weeks: 4, perWeek: 0.25 },
    );
    expect(v?.tone).toBe("good");
    expect(v?.text).toMatch(/well dimensioned: only your top 5%/);
  });

  it("defaults to the watch verdict in between", () => {
    const v = buildVerdict(era({}), { hitCount: 2, weeks: 2, perWeek: 1 });
    expect(v?.tone).toBe("watch");
    expect(v?.text).toMatch(/watch the trend/);
  });

  it("returns nothing without an era", () => {
    expect(buildVerdict(undefined, undefined)).toBeNull();
  });
});
