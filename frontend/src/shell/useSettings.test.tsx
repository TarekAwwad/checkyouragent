import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "./useSettings";

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("useSettings", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockImplementation((url, init) => {
      if (init?.method === "PUT") {
        return Promise.resolve(new Response(init.body as string, { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ historical_pricing: true }), { status: 200 }),
      );
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("loads the setting and toggles it", async () => {
    const { result } = renderHook(() => useSettings(), { wrapper });
    await waitFor(() => expect(result.current.historicalPricing).toBe(true));
    await act(async () => result.current.setHistoricalPricing(false));
    await waitFor(() => expect(result.current.historicalPricing).toBe(false));
  });
});
