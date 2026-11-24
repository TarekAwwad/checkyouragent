import type React from "react";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface Props<T extends string> {
  label: string;
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  variant?: "pressed" | "radio" | "tabs";
  size?: "md" | "sm";
  caption?: string;
  /** tabs: each tab's id is `${idPrefix}-${value}` and it controls `controls`. */
  idPrefix?: string;
  controls?: string;
}

export default function SegmentedControl<T extends string>({
  label, options, value, onChange, variant = "pressed", size = "md", caption, idPrefix, controls,
}: Props<T>) {
  const role = variant === "tabs" ? "tablist" : variant === "radio" ? "radiogroup" : "group";
  return (
    <div className={`seg seg-${size}`} role={role} aria-label={label}>
      {caption && <span className="seg-caption">{caption}</span>}
      {options.map((option) => {
        const active = option.value === value;
        const state: React.ButtonHTMLAttributes<HTMLButtonElement> =
          variant === "tabs"
            ? {
              role: "tab", "aria-selected": active, "aria-controls": controls,
              id: idPrefix ? `${idPrefix}-${option.value}` : undefined,
            }
            : variant === "radio"
              ? { role: "radio", "aria-checked": active }
              : { "aria-pressed": active };
        return (
          <button key={option.value} type="button" className={active ? "active" : ""}
                  disabled={option.disabled} onClick={() => onChange(option.value)} {...state}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
