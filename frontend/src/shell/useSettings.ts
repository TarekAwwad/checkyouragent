import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../api/client";

const PRIVACY_KEY = "ccfr_privacy_mode";

export function useSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: getSettings });

  const mutation = useMutation({
    mutationFn: (historical: boolean) => updateSettings({ historical_pricing: historical, privacy_mode: false }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["settings"], saved);
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== "settings",
      });
    },
  });

  const [privacyMode, setPrivacyModeState] = React.useState<boolean>(
    () => localStorage.getItem(PRIVACY_KEY) === "true"
  );

  const setPrivacyMode = React.useCallback((value: boolean) => {
    setPrivacyModeState(value);
    localStorage.setItem(PRIVACY_KEY, String(value));
  }, []);

  return {
    historicalPricing: query.data?.historical_pricing ?? true,
    setHistoricalPricing: (value: boolean) => mutation.mutate(value),
    privacyMode,
    setPrivacyMode,
    isPending: mutation.isPending,
  };
}
