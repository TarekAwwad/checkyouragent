// frontend/src/shell/Sidebar.tsx
import { Activity, HelpCircle, Moon, PanelLeft, PanelLeftClose, Sun } from "lucide-react";
import { NAV_ITEMS, type View } from "./navConfig";
import { TECHNIQUES } from "../discover/techniques";

interface Props {
  view: View;
  discoverTechnique: string;
  collapsed: boolean;
  sessionEnabled: boolean;
  theme: "dark" | "light";
  onSelectView: (view: View) => void;
  onSelectTechnique: (key: string) => void;
  onToggleCollapsed: () => void;
  onToggleTheme: () => void;
  onOpenGlossary: () => void;
  // First-run hint that surfaces the glossary. When true, the help button
  // pulses and a dismissable coachmark is shown.
  glossaryHint?: boolean;
  onDismissGlossaryHint?: () => void;
}

export default function Sidebar({
  view,
  discoverTechnique,
  collapsed,
  sessionEnabled,
  theme,
  onSelectView,
  onSelectTechnique,
  onToggleCollapsed,
  onToggleTheme,
  onOpenGlossary,
  glossaryHint = false,
  onDismissGlossaryHint,
}: Props) {
  return (
    <aside className={`app-sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="Primary">
      <div className="sb-brand">
        <span className="sb-logo" aria-hidden="true">
          <Activity size={15} strokeWidth={2.4} />
        </span>
        <strong>Claude Analytics</strong>
      </div>

      <nav className="sb-nav">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.key;
          const disabled = item.key === "session" && !sessionEnabled;
          return (
            <div key={item.key}>
              <button
                className={`sb-item ${active ? "active" : ""}`}
                onClick={() => onSelectView(item.key)}
                disabled={disabled}
                aria-label={item.label}
                title={item.label}
              >
                <Icon className="sb-ic" size={16} />
                <span className="sb-label">{item.label}</span>
              </button>

              {item.key === "discover" && view === "discover" && (
                <div className="sb-subnav" role="group" aria-label="Discovery techniques">
                  {TECHNIQUES.map((tech) => (
                    <button
                      key={tech.key}
                      className={`sb-subitem ${discoverTechnique === tech.key ? "active" : ""}`}
                      disabled={tech.status === "soon"}
                      onClick={() => onSelectTechnique(tech.key)}
                      title={tech.label}
                    >
                      <span className="sb-dot" aria-hidden="true" />
                      <span className="sb-label">{tech.label}</span>
                      {tech.status === "soon" && <em className="sb-tag">SOON</em>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="sb-foot">
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
    </aside>
  );
}
