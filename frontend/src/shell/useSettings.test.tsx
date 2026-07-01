import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "./useSettings";

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useSettings", () => {
  let serverSettings: { historical_pricing: boolean; privacy_mode?: boolean };
  const putBodies: Array<{ historical_pricing: boolean; privacy_mode: boolean }> = [];

  beforeEach(() => {
    localStorage.clear();
    serverSettings = { historical_pricing: true, privacy_mode: false };
    putBodies.length = 0;
    vi.spyOn(global, "fetch").mockImplementation((url, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as { historical_pricing: boolean; privacy_mode: boolean };
        putBodies.push(body);
        serverSettings = body;
        return Promise.resolve(new Response(JSON.stringify(serverSettings), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(serverSettings), { status: 200 }));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("loads the setting and toggles it", async () => {
    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.historicalPricing).toBe(true));
    await act(async () => result.current.setHistoricalPricing(false));
    await waitFor(() => expect(result.current.historicalPricing).toBe(false));
    expect(putBodies.at(-1)).toEqual({ historical_pricing: false, privacy_mode: false });
  });

  it("loads persisted privacy when there is no local preference", async () => {
    serverSettings = { historical_pricing: true, privacy_mode: true };
    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.privacyMode).toBe(true));
    expect(localStorage.getItem("ccfr_privacy_mode")).toBe("true");
  });

  it("preserves an existing local privacy preference and saves it", async () => {
    localStorage.setItem("ccfr_privacy_mode", "true");
    serverSettings = { historical_pricing: true, privacy_mode: false };
    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.privacyMode).toBe(true));
    await waitFor(() => expect(putBodies).toContainEqual({ historical_pricing: true, privacy_mode: true }));
  });

  it("saves privacy toggles with the current pricing mode", async () => {
    serverSettings = { historical_pricing: false, privacy_mode: false };
    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.historicalPricing).toBe(false));
    await act(async () => result.current.setPrivacyMode(true));
    await waitFor(() => expect(putBodies.at(-1)).toEqual({ historical_pricing: false, privacy_mode: true }));
  });
});
