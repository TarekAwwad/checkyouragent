import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../api/client";

export function useSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: getSettings });

  const mutation = useMutation({
    mutationFn: (historical: boolean) => updateSettings({ historical_pricing: historical }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["settings"], saved);
      // Pricing affects nearly every cost-bearing query; refetch them all except
      // the settings query itself (it was just set above via setQueryData).
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== "settings",
      });
    },
  });

  return {
    historicalPricing: query.data?.historical_pricing ?? true,
    setHistoricalPricing: (value: boolean) => mutation.mutate(value),
    isPending: mutation.isPending,
  };
}
