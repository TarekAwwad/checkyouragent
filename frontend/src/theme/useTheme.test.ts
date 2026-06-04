import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getInitialTheme, useTheme } from "./useTheme";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("useTheme", () => {
  it("defaults to dark when nothing is stored", () => {
    expect(getInitialTheme()).toBe("dark");
  });

  it("respects a stored light preference", () => {
    localStorage.setItem("ccfr-theme", "light");
    expect(getInitialTheme()).toBe("light");
  });

  it("toggles theme, updates document, and persists", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => result.current.toggle());

    expect(result.current.theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("ccfr-theme")).toBe("light");
  });
});
