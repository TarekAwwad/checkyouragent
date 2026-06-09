import type { LucideIcon } from "lucide-react";
import { DollarSign, FileText, LayoutGrid, Sparkles, Upload } from "lucide-react";

export type View = "import" | "map" | "session" | "cost" | "discover";

export interface NavItem {
  key: View;
  label: string;
  icon: LucideIcon;
}

// Order matters: this is the visible top-to-bottom order in the sidebar.
export const NAV_ITEMS: NavItem[] = [
  { key: "import", label: "Import", icon: Upload },
  { key: "map", label: "Triage", icon: LayoutGrid },
  { key: "cost", label: "Cost", icon: DollarSign },
  { key: "discover", label: "Discover", icon: Sparkles },
  { key: "session", label: "Session", icon: FileText },
];
