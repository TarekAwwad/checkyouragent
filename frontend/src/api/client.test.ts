import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCostAnalytics } from "./client";

function okJson(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

describe("api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(() => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("requests are sent with cache disabled so toggled state can't serve stale data", async () => {
    await getCostAnalytics({});
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBe("no-store");
  });

  it("getCostAnalytics encodes the historical pricing mode in the URL when given", async () => {
    await getCostAnalytics({ dateFrom: "2026-05-18" }, false);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("historical=false");

    fetchMock.mockClear();
    await getCostAnalytics({ dateFrom: "2026-05-18" }, true);
    expect(fetchMock.mock.calls[0][0] as string).toContain("historical=true");
  });

  it("omits the historical param when the mode is not provided", async () => {
    await getCostAnalytics({ dateFrom: "2026-05-18" });
    expect(fetchMock.mock.calls[0][0] as string).not.toContain("historical=");
  });
});
