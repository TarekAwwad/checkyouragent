import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../api/client";

const PRIVACY_KEY = "ccfr_privacy_mode";

export function useSettings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const initialLocalPrivacy = React.useMemo(() => localStorage.getItem(PRIVACY_KEY), []);
  const didSyncPrivacy = React.useRef(false);

  const [privacyMode, setPrivacyModeState] = React.useState<boolean>(
    () => initialLocalPrivacy === "true"
  );

  const mutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: (saved) => {
      const savedPrivacyMode = saved.privacy_mode ?? false;
      queryClient.setQueryData(["settings"], saved);
      setPrivacyModeState(savedPrivacyMode);
      localStorage.setItem(PRIVACY_KEY, String(savedPrivacyMode));
      void queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] !== "settings",
      });
    },
  });

  const setPrivacyMode = React.useCallback((value: boolean) => {
    setPrivacyModeState(value);
    localStorage.setItem(PRIVACY_KEY, String(value));
    mutation.mutate({
      historical_pricing: query.data?.historical_pricing ?? true,
      privacy_mode: value,
    });
  }, [mutation, query.data?.historical_pricing]);

  React.useEffect(() => {
    if (!query.data || didSyncPrivacy.current) return;
    didSyncPrivacy.current = true;
    const savedPrivacyMode = query.data.privacy_mode ?? false;

    if (initialLocalPrivacy !== null) {
      if (savedPrivacyMode !== privacyMode) {
        mutation.mutate({
          historical_pricing: query.data.historical_pricing,
          privacy_mode: privacyMode,
        });
      }
      return;
    }

    setPrivacyModeState(savedPrivacyMode);
    localStorage.setItem(PRIVACY_KEY, String(savedPrivacyMode));
  }, [initialLocalPrivacy, mutation, privacyMode, query.data]);

  return {
    historicalPricing: query.data?.historical_pricing ?? true,
    setHistoricalPricing: (value: boolean) => mutation.mutate({
      historical_pricing: value,
      privacy_mode: privacyMode,
    }),
    privacyMode,
    setPrivacyMode,
    isPending: mutation.isPending,
  };
}
