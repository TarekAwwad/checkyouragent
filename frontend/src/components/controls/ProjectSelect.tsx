import React from "react";
import type { ProjectOption } from "../../shell/analysisScope";

interface Props {
  value: number | null;
  options: ProjectOption[];
  /** Projects with activity in the current range; omit while unknown. */
  activeIds?: number[];
  onChange: (projectId: number | null) => void;
}

const INACTIVE = " (no activity in range)";

export default function ProjectSelect({ value, options, activeIds, onChange }: Props) {
  // Names seen so far, so a selection that drops out of a range-dependent
  // list (Team Cost) still shows its name.
  const names = React.useRef(new Map<number, string>());
  for (const option of options) names.current.set(option.id, option.name);
  const listed = value !== null && options.some((option) => option.id === value);
  const inactive = value !== null && activeIds !== undefined && !activeIds.includes(value);
  const selectedName = value !== null ? names.current.get(value) ?? `Project ${value}` : "";

  return (
    <select className="chip-select project-select" aria-label="Project" value={value ?? ""}
            onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}>
      <option value="">All projects</option>
      {value !== null && !listed && (
        <option value={value}>{selectedName}{inactive ? INACTIVE : ""}</option>
      )}
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}{option.id === value && inactive ? INACTIVE : ""}
        </option>
      ))}
    </select>
  );
}
