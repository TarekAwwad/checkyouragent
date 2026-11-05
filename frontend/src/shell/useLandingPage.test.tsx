import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialHashView, rememberedLanding, useLandingPage } from "./useLandingPage";
import type { DataScope } from "./useDataScope";

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("landing page", () => {
  it("waits for the active dataset and lands on Cost when data exists", async () => {
    const hook = renderHook(({ hasData }) => useLandingPage("local", hasData), {
      initialProps: { hasData: undefined as boolean | undefined },
    });
    expect(hook.result.current.view).toBeNull();
    hook.rerender({ hasData: true });
    await waitFor(() => expect(hook.result.current.view).toBe("cost"));
  });

  it("keeps onboarding visible after the first import until the user chooses a page", async () => {
    const hook = renderHook(({ hasData }) => useLandingPage("local", hasData), { initialProps: { hasData: false } });
    await waitFor(() => expect(hook.result.current.view).toBe("import"));
    hook.rerender({ hasData: true });
    expect(hook.result.current.view).toBe("import");
    act(() => hook.result.current.setView("cost"));
    expect(hook.result.current.view).toBe("cost");
  });

  it("remembers analytical destinations separately for each scope", async () => {
    const hook = renderHook(({ scope }) => useLandingPage(scope, true), { initialProps: { scope: "local" as DataScope } });
    act(() => hook.result.current.setView("discover"));
    hook.rerender({ scope: "team" });
    await waitFor(() => expect(hook.result.current.view).toBe("cost"));
    act(() => hook.result.current.setView("map"));
    hook.rerender({ scope: "local" });
    await waitFor(() => expect(hook.result.current.view).toBe("discover"));
    expect(rememberedLanding("team")).toBe("map");
  });

  it("does not remember data management or a session as a landing page", () => {
    const hook = renderHook(() => useLandingPage("local", true));
    act(() => hook.result.current.setView("map"));
    for (const view of ["import", "export", "session"] as const) {
      act(() => hook.result.current.setView(view));
      expect(rememberedLanding("local")).toBe("map");
    }
  });

  it("uses onboarding for an empty scope even if another scope has a remembered page", async () => {
    localStorage.setItem("ccfr.lastAnalyticalPage.local", "discover");
    const hook = renderHook(() => useLandingPage("team", false));
    await waitFor(() => expect(hook.result.current.view).toBe("import"));
  });

  it("honors explicit supported URLs over the remembered destination", () => {
    localStorage.setItem("ccfr.lastAnalyticalPage.local", "map");
    window.history.replaceState(null, "", "#cost");
    const hook = renderHook(() => useLandingPage("local", true));
    expect(hook.result.current.view).toBe("cost");
    window.history.replaceState(null, "", "#session/7");
    expect(initialHashView("local")).toBe("session");
    expect(initialHashView("team")).toBeNull();
  });

  it("falls back to Cost for invalid or unsupported saved destinations", () => {
    localStorage.setItem("ccfr.lastAnalyticalPage.local", "export");
    localStorage.setItem("ccfr.lastAnalyticalPage.team", "discover");
    expect(rememberedLanding("local")).toBe("cost");
    expect(rememberedLanding("team")).toBe("cost");
  });

  it("supports navigation when browser storage is unavailable", () => {
    const get = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const hook = renderHook(() => useLandingPage("local", true));
    expect(hook.result.current.view).toBe("cost");
    act(() => hook.result.current.setView("map"));
    expect(hook.result.current.view).toBe("map");
    get.mockRestore();
    set.mockRestore();
  });
});
