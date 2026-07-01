import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDataScope } from "./useDataScope";

describe("useDataScope", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("defaults to local when nothing is stored", () => {
    const { result } = renderHook(() => useDataScope());
    expect(result.current.scope).toBe("local");
  });

  it("persists the scope and rehydrates it on a fresh mount", () => {
    const first = renderHook(() => useDataScope());
    act(() => first.result.current.setScope("team"));
    expect(first.result.current.scope).toBe("team");
    expect(localStorage.getItem("ccfr.dataScope")).toBe("team");

    const second = renderHook(() => useDataScope());
    expect(second.result.current.scope).toBe("team");
  });

  it("ignores an unrecognized stored value", () => {
    localStorage.setItem("ccfr.dataScope", "bogus");
    const { result } = renderHook(() => useDataScope());
    expect(result.current.scope).toBe("local");
  });
});
