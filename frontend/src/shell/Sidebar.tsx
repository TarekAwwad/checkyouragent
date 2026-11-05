// frontend/src/shell/Sidebar.tsx
import { Eye, EyeOff, HelpCircle, Monitor, Moon, PanelLeft, PanelLeftClose, Sun, Users } from "lucide-react";
import { NAV_ITEMS, navItemLabel, type View } from "./navConfig";
import type { DataScope } from "./useDataScope";
import { TECHNIQUES } from "../discover/techniques";

const SCOPE_OPTIONS: { key: DataScope; label: string }[] = [
  { key: "local", label: "This machine" },
  { key: "team", label: "Team" },
];

interface Props {
  appVersion?: string;
  view: View | null;
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
  privacyMode: boolean;
  onTogglePrivacyMode: () => void;
  // First-run hint that surfaces the glossary. When true, the help button
  // pulses and a dismissable coachmark is shown.
  glossaryHint?: boolean;
  onDismissGlossaryHint?: () => void;
}

export default function Sidebar({
  appVersion,
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
  privacyMode,
  onTogglePrivacyMode,
}: Props) {
  const readyTechniques = TECHNIQUES.filter((tech) => tech.status === "ready");
  const mainTechniques = readyTechniques.filter((tech) => tech.section === "main");
  const experimentalTechniques = readyTechniques.filter((tech) => tech.section === "experimental");
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

      <nav className="sb-nav" aria-label="Analysis">
        {navItems.filter((item) => item.group === "analysis").map((item) => {
          const Icon = item.icon;
          const active = view === item.key;
          const label = navItemLabel(item, scope);
          return (
            <div key={item.key}>
              <button
                className={`sb-item ${active ? "active" : ""}`}
                onClick={() => onSelectView(item.key)}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                title={label}
              >
                <Icon className="sb-ic" size={16} aria-hidden="true" />
                <span className="sb-label">{label}</span>
              </button>

              {item.key === "discover" && view === "discover" && !collapsed && (
                <div className="sb-subnav" role="group" aria-label="Explore techniques">
                  {mainTechniques.map((tech) => (
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
                  {experimentalTechniques.length > 0 && (
                    <div className="sb-subsection" role="group" aria-label="Experimental techniques">
                      <span className="sb-subsection-label">Experimental</span>
                      {experimentalTechniques.map((tech) => (
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
              )}
            </div>
          );
        })}
      </nav>

      <div className="sb-bottom">
        <nav className="sb-data-nav" aria-label="Data management">
          <span className="sb-data-label" aria-hidden="true">Data</span>
          {navItems.filter((item) => item.group === "data").map((item) => {
            const Icon = item.icon;
            const label = navItemLabel(item, scope);
            const active = view === item.key;
            return (
              <button
                key={item.key}
                type="button"
                className={`sb-item sb-data-item ${active ? "active" : ""}`}
                onClick={() => onSelectView(item.key)}
                aria-label={label}
                aria-current={active ? "page" : undefined}
                title={label}
              >
                <Icon className="sb-ic" size={16} aria-hidden="true" />
                <span className="sb-label">{label}</span>
              </button>
            );
          })}
        </nav>
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
                <p>Open the glossary any time for plain-English definitions — including how evidence and estimates are derived.</p>
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
        {appVersion && (
          <div className="sb-version" title={`Check Your Agent v${appVersion}`} aria-label={`Check Your Agent version ${appVersion}`}>
            v{appVersion}
          </div>
        )}
      </div>
    </aside>
  );
}
