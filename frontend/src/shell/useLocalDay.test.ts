import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalDay } from "./useLocalDay";

beforeEach(() => {
  vi.stubEnv("TZ", "Europe/Paris");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 24, 23, 59, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("useLocalDay", () => {
  it("rolls over at local midnight", () => {
    const { result } = renderHook(() => useLocalDay());
    expect(result.current).toBe("2026-11-24");
    act(() => { vi.advanceTimersByTime(61_000); });
    expect(result.current).toBe("2026-11-25");
  });

  it("catches up on focus when the timer was missed (sleeping laptop)", () => {
    const { result } = renderHook(() => useLocalDay());
    act(() => {
      vi.setSystemTime(new Date(2026, 10, 26, 9, 0));
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current).toBe("2026-11-26");
  });

  it("catches up when the tab becomes visible", () => {
    const { result } = renderHook(() => useLocalDay());
    act(() => {
      vi.setSystemTime(new Date(2026, 10, 27, 9, 0));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe("2026-11-27");
  });
});
