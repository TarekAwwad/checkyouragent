import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useGlossaryHint } from "./useGlossaryHint";

describe("useGlossaryHint", () => {
  afterEach(() => localStorage.clear());

  it("is unseen by default", () => {
    const { result } = renderHook(() => useGlossaryHint());
    expect(result.current.seen).toBe(false);
  });

  it("marks seen and persists to localStorage when dismissed", () => {
    const { result } = renderHook(() => useGlossaryHint());
    act(() => result.current.dismiss());
    expect(result.current.seen).toBe(true);
    expect(localStorage.getItem("ccfr-glossary-hint-seen")).toBe("1");
  });

  it("reads the persisted value on init", () => {
    localStorage.setItem("ccfr-glossary-hint-seen", "1");
    const { result } = renderHook(() => useGlossaryHint());
    expect(result.current.seen).toBe(true);
  });
});
