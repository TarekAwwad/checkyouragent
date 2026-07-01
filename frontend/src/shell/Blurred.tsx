import type { ReactNode } from "react";
import { usePrivacyMode } from "./PrivacyModeContext";
import styles from "./Blurred.module.css";

interface Props {
  children: ReactNode;
  /** Element used when blurring. Use "div" to wrap block-level regions. */
  as?: "span" | "div";
}

export function Blurred({ children, as = "span" }: Props) {
  const privacyMode = usePrivacyMode();
  if (!privacyMode) return <>{children}</>;
  const Tag = as;
  return <Tag className={styles.blurred}>{children}</Tag>;
}
