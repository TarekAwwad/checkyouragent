import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { localIsoDate, presetRange } from "./dateRange";
import type { ProjectOption, ScopeSignal } from "./analysisScope";
import type { DataScope } from "./useDataScope";
import { useScopeStore } from "./useScopeStore";

const recent: ScopeSignal = { populated: true, latestDay: localIsoDate(new Date()) };
const old: ScopeSignal = { populated: true, latestDay: "2000-01-01" };
const EPOCHS = { local: 0, team: 0 };
const NO_PROJECTS: ProjectOption[] = [];

interface Props {
  scope: DataScope;
  local: ScopeSignal | null;
  team: ScopeSignal | null;
  epochs?: { local: number; team: number };
  projects?: ProjectOption[];
}

function setup(initialProps: Props) {
  return renderHook((props: Props) => useScopeStore({
    scope: props.scope,
    signals: { local: props.local, team: props.team },
    epochs: props.epochs ?? EPOCHS,
    projects: props.projects ?? NO_PROJECTS,
    projectsLoaded: props.projects !== undefined,
  }), { initialProps });
}

describe("useScopeStore", () => {
  it("is not ready until the active scope's data has loaded", () => {
    const { result, rerender } = setup({ scope: "local", local: null, team: null });
    expect(result.current.ready).toBe(false);
    rerender({ scope: "local", local: recent, team: null });
    expect(result.current.ready).toBe(true);
    expect(result.current.value.range).toEqual(presetRange("30d"));
  });

  it("opens on all time when activity is old", () => {
    const { result } = setup({ scope: "local", local: old, team: null });
    expect(result.current.value.range.preset).toBe("all");
  });

  it("keeps a separate range per data scope", () => {
    const { result, rerender } = setup({ scope: "local", local: recent, team: null });
    act(() => result.current.value.setRange(presetRange("7d")));
    rerender({ scope: "team", local: recent, team: null });
    expect(result.current.ready).toBe(false);
    rerender({ scope: "team", local: recent, team: old });
    expect(result.current.value.range.preset).toBe("all");
    rerender({ scope: "local", local: recent, team: old });
    expect(result.current.value.range.preset).toBe("7d");
  });

  it("re-resolves a scope when its epoch changes", () => {
    const { result, rerender } = setup({ scope: "local", local: recent, team: null });
    act(() => result.current.value.setRange(presetRange("7d")));
    rerender({ scope: "local", local: recent, team: null, epochs: { local: 1, team: 0 } });
    expect(result.current.value.range).toEqual(presetRange("30d"));
  });

  it("drops a selected project that no longer exists", () => {
    const projects = [{ id: 1, name: "alpha" }];
    const { result, rerender } = setup({ scope: "local", local: recent, team: null, projects });
    act(() => result.current.value.setProjectId(1));
    expect(result.current.value.projectId).toBe(1);
    rerender({ scope: "local", local: recent, team: null, projects: [] });
    expect(result.current.value.projectId).toBeNull();
  });

  it("switches an automatic all-time range to 30 days after a first import", () => {
    const { result, rerender } = setup({ scope: "local", local: { populated: false, latestDay: null }, team: null });
    expect(result.current.value.range.preset).toBe("all");
    rerender({ scope: "local", local: recent, team: null });
    expect(result.current.value.range.preset).toBe("30d");
  });

  it("keeps an automatic range a page has shown when the first import arrives", () => {
    const { result, rerender } = setup({ scope: "local", local: { populated: false, latestDay: null }, team: null });
    act(() => result.current.value.markRangeShown());
    rerender({ scope: "local", local: recent, team: null });
    expect(result.current.value.range.preset).toBe("all");
  });

  it("re-resolves a preset at local midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 23, 59, 0));
    try {
      const { result } = setup({ scope: "local", local: { populated: true, latestDay: "2026-11-24" }, team: null });
      act(() => result.current.value.setRange(presetRange("today")));
      expect(result.current.value.resolvedRange).toEqual({ from: "2026-11-24", to: "2026-11-24" });
      act(() => { vi.advanceTimersByTime(61_000); });
      expect(result.current.value.resolvedRange).toEqual({ from: "2026-11-25", to: "2026-11-25" });
    } finally {
      vi.useRealTimers();
    }
  });
});
