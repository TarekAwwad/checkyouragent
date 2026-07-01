import React from "react";

const PrivacyModeContext = React.createContext(false);

export function PrivacyModeProvider({ value, children }: { value: boolean; children: React.ReactNode }) {
  return <PrivacyModeContext.Provider value={value}>{children}</PrivacyModeContext.Provider>;
}

export function usePrivacyMode(): boolean {
  return React.useContext(PrivacyModeContext);
}
