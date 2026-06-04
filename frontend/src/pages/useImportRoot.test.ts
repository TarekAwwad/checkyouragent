import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useImportRoot } from "./useImportRoot";

describe("useImportRoot", () => {
  beforeEach(() => localStorage.clear());

  it("falls back to the backend default when no override is stored", () => {
    const { result } = renderHook(() => useImportRoot("/srv/Data"));
    expect(result.current.root).toBe("/srv/Data");
    expect(result.current.isOverridden).toBe(false);
  });

  it("persists an override to localStorage and reports it as overridden", () => {
    const { result } = renderHook(() => useImportRoot("/srv/Data"));
    act(() => result.current.setRoot("  /mnt/exports  "));

    expect(result.current.root).toBe("/mnt/exports");
    expect(result.current.isOverridden).toBe(true);
    expect(localStorage.getItem("ccfr.importRoot")).toBe("/mnt/exports");
  });

  it("treats an override equal to the default as not overridden", () => {
    const { result } = renderHook(() => useImportRoot("/srv/Data"));
    act(() => result.current.setRoot("/srv/Data"));

    expect(result.current.root).toBe("/srv/Data");
    expect(result.current.isOverridden).toBe(false);
    expect(localStorage.getItem("ccfr.importRoot")).toBeNull();
  });

  it("resetToDefault clears the stored override", () => {
    localStorage.setItem("ccfr.importRoot", "/mnt/exports");
    const { result } = renderHook(() => useImportRoot("/srv/Data"));
    expect(result.current.root).toBe("/mnt/exports");

    act(() => result.current.resetToDefault());

    expect(result.current.root).toBe("/srv/Data");
    expect(result.current.isOverridden).toBe(false);
    expect(localStorage.getItem("ccfr.importRoot")).toBeNull();
  });

  it("keeps a stored override even before the backend default loads", () => {
    localStorage.setItem("ccfr.importRoot", "/mnt/exports");
    const { result } = renderHook(() => useImportRoot(undefined));
    expect(result.current.root).toBe("/mnt/exports");
    expect(result.current.isOverridden).toBe(true);
  });
});
