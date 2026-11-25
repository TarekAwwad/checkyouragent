interface Props {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name when the visible label is shorter than the meaning. */
  ariaLabel?: string;
  title?: string;
}

export default function ToggleChip({ label, checked, onChange, disabled, ariaLabel, title }: Props) {
  return (
    <label className={`toggle-chip${disabled ? " is-disabled" : ""}`} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel}
             onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
