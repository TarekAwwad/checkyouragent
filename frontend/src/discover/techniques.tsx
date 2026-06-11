import type { ComponentType } from "react";
import type { Project } from "../api/types";
import SubgroupDiscovery from "./SubgroupDiscovery";
import ContextEconomics from "./context/ContextEconomics";

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

// Attach a component here when a technique becomes ready.
export const TECHNIQUES: Technique[] = [
  { key: "subgroup", label: "Subgroups", status: "ready", component: SubgroupDiscovery },
  { key: "context", label: "Context economics", status: "ready", component: ContextEconomics },
  { key: "sequence", label: "Sequence mining", status: "soon" },
  { key: "anomalies", label: "Anomalies", status: "soon" },
];

export const DEFAULT_TECHNIQUE = "subgroup";
