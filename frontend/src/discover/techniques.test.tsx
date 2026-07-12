import { describe, expect, it } from "vitest";
import { DEFAULT_TECHNIQUE, TECHNIQUES } from "./techniques";

describe("technique registry", () => {
  it("registers Usage drivers as a ready technique with a component", () => {
    const drivers = TECHNIQUES.find((t) => t.key === "drivers");
    expect(drivers).toBeDefined();
    expect(drivers?.label).toBe("Usage drivers");
    expect(drivers?.status).toBe("ready");
    expect(drivers?.component).toBeTypeOf("function");
  });

  it("keeps subgroup as the default technique", () => {
    expect(DEFAULT_TECHNIQUE).toBe("subgroup");
    expect(TECHNIQUES.some((t) => t.key === DEFAULT_TECHNIQUE)).toBe(true);
  });

  it("registers Limit hits as a ready technique with a component", () => {
    const limits = TECHNIQUES.find((t) => t.key === "limits");
    expect(limits?.status).toBe("ready");
    expect(limits?.label).toBe("Limit hits");
    expect(limits?.component).toBeTruthy();
  });
});
