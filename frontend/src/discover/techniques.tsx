import type { ComponentType } from "react";
import type { Project } from "../api/types";
import SubgroupDiscovery from "./SubgroupDiscovery";
import ContextEconomics from "./context/ContextEconomics";
import UsageMindmap from "./mindmap/UsageMindmap";
import UsageDrivers from "./drivers/UsageDrivers";
import LimitHits from "./limits/LimitHits";

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

// Attach a component here when a technique becomes ready. The "soon" status is
// intentionally kept in the type so a future technique can register as a
// not-yet-ready stub; DiscoverPage renders those through its ComingSoon fallback.
// Listed in priority order; the sidebar renders this order verbatim and the
// first entry is what Explore opens to.
export const TECHNIQUES: Technique[] = [
  { key: "limits", label: "Limit hits", status: "ready", component: LimitHits },
  { key: "context", label: "Context economics", status: "ready", component: ContextEconomics },
  { key: "drivers", label: "Usage drivers", status: "ready", component: UsageDrivers },
  { key: "mindmap", label: "Usage Mindmap", status: "ready", component: UsageMindmap },
  { key: "subgroup", label: "Subgroups", status: "ready", component: SubgroupDiscovery },
];

export const DEFAULT_TECHNIQUE = "limits";
