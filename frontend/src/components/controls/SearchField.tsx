import { Search } from "lucide-react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export default function SearchField({ value, onChange, placeholder }: Props) {
  return (
    <label className="search-field">
      <Search size={14} aria-hidden="true" />
      <input value={value} placeholder={placeholder} aria-label={placeholder}
             onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
