import { describe, expect, it } from "vitest";
import { formatCostPeriod, spikeBaselineDescription } from "./costPeriods";

describe("cost period labels", () => {
  it("formats daily dates in UTC rather than exposing storage keys", () => {
    expect(formatCostPeriod({ bucket: "2026-05-02" }, "day")).toBe("May 2, 2026");
    expect(formatCostPeriod({ bucket: "2026-05-02" }, "day", true)).toBe("May 2");
  });

  it("uses explicit boundaries for weekly periods across a year boundary", () => {
    expect(formatCostPeriod({ bucket: "opaque", bucket_start: "2025-12-29", bucket_end: "2026-01-04" }, "week"))
      .toBe("Week of Dec 29, 2025");
  });

  it("handles legacy calendar-year week keys, including week zero", () => {
    expect(formatCostPeriod({ bucket: "2026-43" }, "week")).toBe("Week of Oct 26, 2026");
    expect(formatCostPeriod({ bucket: "2026-43", bucket_start: null }, "week")).toBe("Week of Oct 26, 2026");
    expect(formatCostPeriod({ bucket: "2026-00" }, "week")).toBe("Week of Dec 29, 2025");
    expect(formatCostPeriod({ bucket: "2024-01" }, "week")).toBe("Week of Jan 1, 2024");
  });

  it("does not show malformed identifiers as dates", () => {
    expect(formatCostPeriod({ bucket: "2026-02-30" }, "day")).toBe("Unknown date");
    expect(formatCostPeriod({ bucket: "2026-99" }, "week")).toBe("Unknown week");
  });

  it("explains the actual baseline window and its calendar unit", () => {
    const spike = { bucket: "2026-43", total_usd: 20, baseline_usd: 5, delta_usd: 15, delta_pct: 300, sessions: [] };
    expect(spikeBaselineDescription({ ...spike, baseline_period_count: 5 }, "week"))
      .toBe("Median of preceding 5 complete weeks");
    expect(spikeBaselineDescription(spike, "day")).toBe("Median of preceding 3–7 complete days");
  });
});
