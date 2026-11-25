import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { getUsageCharacteristics } from "../../api/client";
import type { UsageCharacteristicsResponse } from "../../api/types";
import type { BoundPair } from "../../shell/dateRange";

// "<1%" and ">99%" keep a sliver or a near-total share from rounding to a
// misleading 0% or 100%.
export function formatShare(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  if (share > 0.99 && share < 1) return ">99%";
  return `${Math.round(share * 100)}%`;
}

// The usage-characteristics fetch behind the Explore "Usage drivers" page.
// Keyed by the resolved bounds, so two custom ranges never share an entry.
// Keep the ["usage-characteristics", ...] key prefix: import invalidation
// matches on it.
export function useUsageCharacteristics(
  projectId: number | null,
  bounds: BoundPair,
): UseQueryResult<UsageCharacteristicsResponse> {
  return useQuery({
    queryKey: ["usage-characteristics", projectId, bounds.dateFrom, bounds.dateTo],
    queryFn: () => getUsageCharacteristics({
      projectId, dateFrom: bounds.dateFrom, dateTo: bounds.dateTo,
    }),
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
}
