// frontend/src/shell/Sidebar.tsx
import { Eye, EyeOff, History, HelpCircle, Monitor, Moon, PanelLeft, PanelLeftClose, Sun, Users } from "lucide-react";
import { NAV_ITEMS, type View } from "./navConfig";
import type { DataScope } from "./useDataScope";
import { TECHNIQUES } from "../discover/techniques";

const SCOPE_OPTIONS: { key: DataScope; label: string }[] = [
  { key: "local", label: "This machine" },
  { key: "team", label: "Team" },
];

interface Props {
  view: View;
  scope: DataScope;
  discoverTechnique: string;
  collapsed: boolean;
  theme: "dark" | "light";
  onSelectView: (view: View) => void;
  onSelectScope: (scope: DataScope) => void;
  onSelectTechnique: (key: string) => void;
  onToggleCollapsed: () => void;
  onToggleTheme: () => void;
  onOpenGlossary: () => void;
  historicalPricing: boolean;
  onToggleHistoricalPricing: () => void;
  privacyMode: boolean;
  onTogglePrivacyMode: () => void;
  // First-run hint that surfaces the glossary. When true, the help button
  // pulses and a dismissable coachmark is shown.
  glossaryHint?: boolean;
  onDismissGlossaryHint?: () => void;
}

export default function Sidebar({
  view,
  scope,
  discoverTechnique,
  collapsed,
  theme,
  onSelectView,
  onSelectScope,
  onSelectTechnique,
  onToggleCollapsed,
  onToggleTheme,
  onOpenGlossary,
  glossaryHint = false,
  onDismissGlossaryHint,
  historicalPricing,
  onToggleHistoricalPricing,
  privacyMode,
  onTogglePrivacyMode,
}: Props) {
  const readyTechniques = TECHNIQUES.filter((tech) => tech.status === "ready");
  const navItems = NAV_ITEMS.filter((item) => item.scopes.includes(scope));
  const scopeLabel = scope === "team" ? "Team" : "This machine";
  const ScopeIcon = scope === "team" ? Users : Monitor;
  const nextScope: DataScope = scope === "team" ? "local" : "team";
  const nextScopeLabel = nextScope === "team" ? "Team" : "This machine";

  return (
    <aside className={`app-sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="Primary">
      <div className="sb-brand">
        <div className="sb-brand-text">
          <strong className="sb-wordmark">Check Your Agent</strong>
          <span className="sb-tagline">local, read-only session data</span>
        </div>
        <strong className="sb-monogram" aria-hidden="true">CYA!</strong>
      </div>

      <nav className="sb-nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = view === item.key;
          return (
            <div key={item.key}>
              <button
                className={`sb-item ${active ? "active" : ""}`}
                onClick={() => onSelectView(item.key)}
                aria-label={item.label}
                title={item.label}
              >
                <Icon className="sb-ic" size={16} />
                <span className="sb-label">{item.label}</span>
              </button>

              {item.key === "discover" && view === "discover" && (
                <div className="sb-subnav" role="group" aria-label="Discovery techniques">
                  {readyTechniques.map((tech) => (
                    <button
                      key={tech.key}
                      className={`sb-subitem ${discoverTechnique === tech.key ? "active" : ""}`}
                      onClick={() => onSelectTechnique(tech.key)}
                      title={tech.label}
                    >
                      <span className="sb-dot" aria-hidden="true" />
                      <span className="sb-label">{tech.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="sb-bottom">
        <div className="sb-scope-row">
          <div className="sb-scope segmented-control" role="group" aria-label="Data scope">
            {SCOPE_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={scope === option.key ? "active" : ""}
                aria-pressed={scope === option.key}
                onClick={() => onSelectScope(option.key)}
                title={option.key === "team" ? "Aggregated team bundles" : "This machine's local sessions"}
              >
                <span className="sb-label">{option.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="sb-foot">
          <button
            className={`sb-action sb-scope-action ${scope === "team" ? "is-active" : ""}`}
            type="button"
            aria-pressed={scope === "team"}
            aria-label={`Data scope: ${scopeLabel}. Switch to ${nextScopeLabel}.`}
            title={scope === "team" ? "Aggregated team bundles" : "This machine's local sessions"}
            onClick={() => onSelectScope(nextScope)}
          >
            <ScopeIcon size={16} />
          </button>
          <button
            className={`sb-action ${privacyMode ? "is-active" : ""}`}
            onClick={onTogglePrivacyMode}
            aria-pressed={privacyMode}
            aria-label="Privacy mode"
            title={privacyMode ? "Privacy mode on — sensitive data is blurred" : "Privacy mode off — click to blur sensitive data"}
          >
            {privacyMode ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
          <button
            className={`sb-action ${historicalPricing ? "is-active" : ""}`}
            onClick={onToggleHistoricalPricing}
            aria-pressed={historicalPricing}
            aria-label="Historical pricing"
            title={
              historicalPricing
                ? "Historical pricing on — spend uses rates effective on each session's date"
                : "Historical pricing off — spend uses current rates for all sessions"
            }
          >
            <History size={16} />
          </button>
          <div className="sb-glossary">
            <button
              className={`sb-action ${glossaryHint ? "is-hinted" : ""}`}
              onClick={onOpenGlossary}
              aria-label="Open glossary"
              title="Open glossary"
            >
              <HelpCircle size={16} />
            </button>
            {glossaryHint && (
              <div className="glossary-hint" role="note" aria-labelledby="glossary-hint-title">
                <h4 id="glossary-hint-title">Not sure what a term means?</h4>
                <p>Open the glossary any time for plain-English definitions — and how each score is computed.</p>
                <div className="glossary-hint-actions">
                  <button type="button" className="ghint-primary" onClick={onOpenGlossary}>
                    Browse glossary
                  </button>
                  <button type="button" className="ghint-secondary" onClick={() => onDismissGlossaryHint?.()}>
                    Got it
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            className="sb-action"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            className="sb-action sb-collapse"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
