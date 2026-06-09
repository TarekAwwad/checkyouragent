import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useCollapsed } from "./useCollapsed";

describe("useCollapsed", () => {
  afterEach(() => localStorage.clear());

  it("defaults to expanded", () => {
    const { result } = renderHook(() => useCollapsed());
    expect(result.current.collapsed).toBe(false);
  });

  it("toggles and persists to localStorage", () => {
    const { result } = renderHook(() => useCollapsed());
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem("ccfr-sidebar-collapsed")).toBe("1");
  });

  it("reads the persisted value on init", () => {
    localStorage.setItem("ccfr-sidebar-collapsed", "1");
    const { result } = renderHook(() => useCollapsed());
    expect(result.current.collapsed).toBe(true);
  });
});
