import type { ComponentType } from "react";
import type { Project } from "../api/types";
import SubgroupDiscovery from "./SubgroupDiscovery";
import ContextEconomics from "./context/ContextEconomics";
import UsageMindmap from "./mindmap/UsageMindmap";

export interface TechniqueProps {
  projects: Project[];
  /** Open the session workspace, optionally landing on a specific event. */
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
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
  { key: "mindmap", label: "Usage Mindmap", status: "ready", component: UsageMindmap },
  { key: "sequence", label: "Sequence mining", status: "soon" },
  { key: "anomalies", label: "Anomalies", status: "soon" },
];

export const DEFAULT_TECHNIQUE = "subgroup";
