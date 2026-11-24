import { describe, expect, it } from "vitest";
import { presetRange } from "./dateRange";
import { UNRESOLVED_SLOT, scopeReducer, type ScopeAction } from "./analysisScope";

const today = "2026-11-24";
const data = (populated: boolean, latestDay: string | null): ScopeAction => (
  { type: "data", signal: { populated, latestDay }, today }
);

describe("scopeReducer", () => {
  it("opens on the last 30 days when there is recent activity", () => {
    expect(scopeReducer(UNRESOLVED_SLOT, data(true, "2026-11-20"))).toMatchObject({
      resolved: true, rangeIsAutomatic: true, populated: true, range: presetRange("30d"),
    });
  });

  it("opens on all time for old, missing or empty data", () => {
    expect(scopeReducer(UNRESOLVED_SLOT, data(true, "2026-01-01")).range.preset).toBe("all");
    expect(scopeReducer(UNRESOLVED_SLOT, data(false, null)).range.preset).toBe("all");
  });

  it("re-evaluates an automatic range on the first data after an empty start", () => {
    const empty = scopeReducer(UNRESOLVED_SLOT, data(false, null));
    expect(scopeReducer(empty, data(true, "2026-11-23")).range.preset).toBe("30d");
  });

  it("keeps a range the user picked when data arrives", () => {
    const empty = scopeReducer(UNRESOLVED_SLOT, data(false, null));
    const picked = scopeReducer(empty, { type: "setRange", range: presetRange("7d") });
    const after = scopeReducer(picked, data(true, "2026-11-23"));
    expect(after.range.preset).toBe("7d");
    expect(after.rangeIsAutomatic).toBe(false);
  });

  it("does not re-evaluate once resolved with data", () => {
    const slot = scopeReducer(UNRESOLVED_SLOT, data(true, "2026-01-01"));
    expect(scopeReducer(slot, { type: "data", signal: { populated: true, latestDay: "2026-11-23" }, today: "2026-11-25" }))
      .toBe(slot);
  });

  it("resets to unresolved", () => {
    const slot = scopeReducer(UNRESOLVED_SLOT, data(true, "2026-11-20"));
    expect(scopeReducer(slot, { type: "reset" })).toBe(UNRESOLVED_SLOT);
  });

  it("sets the project without touching the range", () => {
    const slot = scopeReducer(UNRESOLVED_SLOT, data(true, "2026-11-20"));
    const next = scopeReducer(slot, { type: "setProject", projectId: 4 });
    expect(next).toMatchObject({ projectId: 4, range: presetRange("30d"), rangeIsAutomatic: true });
  });

  it("lets the first data decide an unresolved slot, even over an earlier pick", () => {
    // An unresolved slot holds no context yet (startup, or right after a reset).
    const picked = scopeReducer(UNRESOLVED_SLOT, { type: "setRange", range: presetRange("7d") });
    expect(scopeReducer(picked, data(true, "2026-11-20")).range).toEqual(presetRange("30d"));
  });

  it("never switches an automatic range a page has shown", () => {
    const empty = scopeReducer(UNRESOLVED_SLOT, data(false, null));
    const shown = scopeReducer(empty, { type: "markShown" });
    const after = scopeReducer(shown, data(true, "2026-11-23"));
    expect(after.range.preset).toBe("all");
    expect(after.rangeShown).toBe(true);
  });

  it("marks a range shown once", () => {
    const shown = scopeReducer(UNRESOLVED_SLOT, { type: "markShown" });
    expect(scopeReducer(shown, { type: "markShown" })).toBe(shown);
  });
});
