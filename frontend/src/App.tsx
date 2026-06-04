import React from "react";
import { useQuery } from "@tanstack/react-query";
import { HelpCircle, Moon, Sun } from "lucide-react";
import { listImports, listProjects, listSessions } from "./api/client";
import type { SessionCard } from "./api/types";
import ImportPage from "./pages/ImportPage";
import TriageBoard from "./triage/TriageBoard";
import SessionWorkspace from "./pages/SessionWorkspace";
import CostAnalyticsPage from "./analytics/CostAnalyticsPage";
import GlossaryDialog from "./glossary/GlossaryDialog";
import { useTheme } from "./theme/useTheme";

type View = "import" | "map" | "session" | "cost";

function App() {
  const imports = useQuery({ queryKey: ["imports"], queryFn: listImports });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const sessions = useQuery({ queryKey: ["sessions", {}], queryFn: () => listSessions() });
  const [view, setView] = React.useState<View>("import");
  const [selectedSession, setSelectedSession] = React.useState<SessionCard | null>(null);
  const { theme, toggle } = useTheme();
  const [glossaryOpen, setGlossaryOpen] = React.useState(false);
  const autoRouted = React.useRef(false);

  // On first load only, if imports already exist, jump past the empty import
  // screen to Triage. After that the user is free to navigate back to Import.
  React.useEffect(() => {
    if (!autoRouted.current && (imports.data?.length ?? 0) > 0) {
      autoRouted.current = true;
      setView((current) => (current === "import" ? "map" : current));
    }
  }, [imports.data?.length]);

  const openSession = (session: SessionCard) => {
    setSelectedSession(session);
    setView("session");
  };

  const openSessionById = (sessionId: number) => {
    const card = sessions.data?.find((s) => s.id === sessionId);
    if (card) openSession(card);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <strong>Claude Analytics</strong>
        </div>
        <nav className="topnav" aria-label="Primary">
          <button className={view === "import" ? "active" : ""} onClick={() => setView("import")}>Import</button>
          <button className={view === "map" ? "active" : ""} onClick={() => setView("map")}>Triage</button>
          <button className={view === "cost" ? "active" : ""} onClick={() => setView("cost")}>Cost</button>
          <button className={view === "session" ? "active" : ""} disabled={!selectedSession} onClick={() => setView("session")}>Session</button>
        </nav>
        <div className="topbar-actions">
          <button
            className="theme-toggle"
            onClick={() => setGlossaryOpen(true)}
            aria-label="Open glossary"
            title="Glossary of terms"
          >
            <HelpCircle size={16} />
          </button>
          <button
            className="theme-toggle"
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
      </header>

      <GlossaryDialog open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />

      {view === "import" && <ImportPage />}
      {view === "map" && (
        <TriageBoard
          projects={projects.data ?? []}
          sessions={sessions.data ?? []}
          loading={projects.isLoading || sessions.isLoading}
          onOpenSession={openSession}
        />
      )}
      {view === "cost" && <CostAnalyticsPage onOpenSession={openSessionById} />}
      {view === "session" && selectedSession && <SessionWorkspace session={selectedSession} />}
    </div>
  );
}

export default App;
