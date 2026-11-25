import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ALL_TIME, RANGE_LABELS, RANGE_PRESETS, addDays, dayBounds, defaultPreset, instantBounds,
  overlapsWindow, presetRange, previousRange, resolveRange, toLocalDay,
} from "./dateRange";

// Paris is UTC+1 in November and switches to summer time on 29 March 2026, so
// local and UTC days differ and one day has 23 hours. Node re-reads TZ when it
// is assigned; vi.stubEnv keeps this file free of `process` typings (.test.ts
// files are type-checked by `npm run build`).
beforeAll(() => { vi.stubEnv("TZ", "Europe/Paris"); });
afterAll(() => { vi.unstubAllEnvs(); });

describe("presets", () => {
  it("labels every preset in menu order", () => {
    expect(RANGE_PRESETS.map((p) => RANGE_LABELS[p])).toEqual(
      ["Today", "Last 7 days", "Last 30 days", "Last 90 days", "All time", "Custom range"]);
  });
});

describe("resolveRange", () => {
  const today = "2026-11-24";

  it("returns inclusive local windows that end today", () => {
    expect(resolveRange(presetRange("today"), today)).toEqual({ from: "2026-11-24", to: "2026-11-24" });
    expect(resolveRange(presetRange("7d"), today)).toEqual({ from: "2026-11-18", to: "2026-11-24" });
    expect(resolveRange(presetRange("30d"), today)).toEqual({ from: "2026-10-26", to: "2026-11-24" });
    expect(resolveRange(presetRange("90d"), today)).toEqual({ from: "2026-08-27", to: "2026-11-24" });
    expect(resolveRange(ALL_TIME, today)).toEqual({ from: null, to: null });
  });

  it("crosses month and year boundaries", () => {
    expect(resolveRange(presetRange("7d"), "2026-01-03")).toEqual({ from: "2025-12-28", to: "2026-01-03" });
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("returns custom dates as stored", () => {
    expect(resolveRange({ preset: "custom", from: "2026-05-01", to: null }, today))
      .toEqual({ from: "2026-05-01", to: null });
  });
});

describe("bounds", () => {
  it("sends local-day instants for local data", () => {
    expect(instantBounds({ from: "2026-11-24", to: "2026-11-24" })).toEqual({
      dateFrom: "2026-11-23T23:00:00.000Z", dateTo: "2026-11-24T22:59:59.999Z",
    });
  });

  it("handles the 23-hour day when summer time starts", () => {
    expect(instantBounds({ from: "2026-03-29", to: "2026-03-29" })).toEqual({
      dateFrom: "2026-03-28T23:00:00.000Z", dateTo: "2026-03-29T21:59:59.999Z",
    });
  });

  it("sends plain local dates for team bundles", () => {
    expect(dayBounds({ from: "2026-11-24", to: "2026-11-24" }))
      .toEqual({ dateFrom: "2026-11-24", dateTo: "2026-11-24" });
  });

  it("leaves open ends open", () => {
    expect(instantBounds({ from: null, to: null })).toEqual({ dateFrom: null, dateTo: null });
  });
});

describe("previousRange", () => {
  it("returns the equal-length window ending the day before", () => {
    expect(previousRange({ from: "2026-06-01", to: "2026-06-10" }))
      .toEqual({ from: "2026-05-22", to: "2026-05-31" });
  });

  it("has no previous window for an open range", () => {
    expect(previousRange({ from: null, to: null })).toBeNull();
    expect(previousRange({ from: "2026-06-01", to: null })).toBeNull();
  });
});

describe("toLocalDay and defaultPreset", () => {
  it("maps instants to the local day and keeps plain dates", () => {
    expect(toLocalDay("2026-11-23T23:30:00Z")).toBe("2026-11-24");
    expect(toLocalDay("2026-05-02")).toBe("2026-05-02");
    expect(toLocalDay(null)).toBeNull();
    expect(toLocalDay("not a date")).toBeNull();
  });

  it("opens on 30 days only when there is activity inside them", () => {
    expect(defaultPreset("2026-10-26", "2026-11-24")).toBe("30d");
    expect(defaultPreset("2026-10-25", "2026-11-24")).toBe("all");
    expect(defaultPreset(null, "2026-11-24")).toBe("all");
  });
});

describe("overlapsWindow", () => {
  // A literal, not instantBounds(): describe bodies run before beforeAll stubs TZ.
  const today = { dateFrom: "2026-11-23T23:00:00.000Z", dateTo: "2026-11-24T22:59:59.999Z" };

  it("keeps sessions that straddle either edge", () => {
    expect(overlapsWindow("2026-11-23T20:00:00Z", "2026-11-23T23:10:00Z", today)).toBe(true);
    expect(overlapsWindow("2026-11-24T22:00:00Z", "2026-11-25T01:00:00Z", today)).toBe(true);
  });

  it("drops sessions fully outside", () => {
    expect(overlapsWindow("2026-11-23T10:00:00Z", "2026-11-23T22:00:00Z", today)).toBe(false);
  });

  it("keeps undated sessions only without a window", () => {
    expect(overlapsWindow(null, null, { dateFrom: null, dateTo: null })).toBe(true);
    expect(overlapsWindow(null, null, today)).toBe(false);
  });
});
