import type { ComponentType } from "react";
import type { Project } from "../api/types";

export interface TechniqueProps {
  projects: Project[];
  onOpenSession: (sessionId: number) => void;
}

export interface Technique {
  key: string;
  label: string;
  status: "ready" | "soon";
  component?: ComponentType<TechniqueProps>;
}

// `subgroup.component` is attached in Task 4 once SubgroupDiscovery exists.
export const TECHNIQUES: Technique[] = [
  { key: "subgroup", label: "Subgroup discovery", status: "ready" },
  { key: "sequence", label: "Sequence mining", status: "soon" },
  { key: "anomalies", label: "Anomalies", status: "soon" },
];

export const DEFAULT_TECHNIQUE = "subgroup";
