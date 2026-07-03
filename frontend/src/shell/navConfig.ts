import type { LucideIcon } from "lucide-react";
import { DollarSign, Download, LayoutDashboard, Sparkles, Upload } from "lucide-react";
import type { DataScope } from "./useDataScope";

export type View = "import" | "export" | "map" | "session" | "cost" | "discover";

export interface NavItem {
  key: View;
  label: string;
  icon: LucideIcon;
  // Which data scopes expose this view. Team scope only surfaces the aggregate
  // views; per-session drilldowns have no team equivalent by design.
  scopes: DataScope[];
}

// Order matters: this is the visible top-to-bottom order in the sidebar.
// "Import" is scope-aware in content: local imports source projects, team imports
// shared bundles. "Export" (share a local bundle) is local-only — a team user has
// nothing of their own to export from aggregated bundles.
export const NAV_ITEMS: NavItem[] = [
  { key: "import", label: "Import", icon: Upload, scopes: ["local", "team"] },
  { key: "export", label: "Export", icon: Download, scopes: ["local"] },
  { key: "map", label: "Overview", icon: LayoutDashboard, scopes: ["local", "team"] },
  { key: "cost", label: "Cost", icon: DollarSign, scopes: ["local", "team"] },
  { key: "discover", label: "Explore", icon: Sparkles, scopes: ["local"] },
];
