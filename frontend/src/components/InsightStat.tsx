import type { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

/**
 * One small stat card. Shares the `.cost-insight` chrome used by the cost
 * analytics insight strip so stat cards read identically across pages.
 */
export default function InsightStat({ label, value, hint }: Props) {
  return (
    <div className="cost-insight">
      <span>{label}</span>
      <b>{value}</b>
      <small>{hint}</small>
    </div>
  );
}
