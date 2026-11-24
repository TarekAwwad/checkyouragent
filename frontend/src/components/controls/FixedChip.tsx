import { Lock } from "lucide-react";

export default function FixedChip({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`fixed-chip${className ? ` ${className}` : ""}`} title="Fixed on this page">
      <Lock size={11} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
