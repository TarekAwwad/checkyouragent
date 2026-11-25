import type React from "react";

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}

export default function FilterSelect({ label, value, onChange, children }: Props) {
  return (
    <select className="chip-select" aria-label={label} value={value}
            onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  );
}
