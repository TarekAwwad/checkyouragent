import type { LucideIcon } from "lucide-react";
import { DollarSign, LayoutDashboard, Share2, Sparkles, Upload } from "lucide-react";
import type { DataScope } from "./useDataScope";

export type View = "import" | "export" | "map" | "session" | "cost" | "discover";

export interface NavItem {
  key: View;
  label: string;
  scopeLabels?: Partial<Record<DataScope, string>>;
  icon: LucideIcon;
  group: "analysis" | "data";
  // Which data scopes expose this view. Team scope only surfaces the aggregate
  // views; per-session drilldowns have no team equivalent by design.
  scopes: DataScope[];
}

// Analysis is the primary navigation. Data management stays visible below it.
export const NAV_ITEMS: NavItem[] = [
  { key: "cost", label: "Cost", icon: DollarSign, group: "analysis", scopes: ["local", "team"] },
  {
    key: "map",
    label: "Sessions",
    scopeLabels: { team: "Overview" },
    icon: LayoutDashboard,
    group: "analysis",
    scopes: ["local", "team"],
  },
  { key: "discover", label: "Explore", icon: Sparkles, group: "analysis", scopes: ["local"] },
  { key: "import", label: "Sources & sync", scopeLabels: { team: "Manage bundles" }, icon: Upload, group: "data", scopes: ["local", "team"] },
  { key: "export", label: "Share team bundle", icon: Share2, group: "data", scopes: ["local"] },
];

export function navItemLabel(item: NavItem, scope: DataScope): string {
  return item.scopeLabels?.[scope] ?? item.label;
}
