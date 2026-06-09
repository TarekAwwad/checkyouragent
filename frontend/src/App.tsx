import React from "react";
import { useQuery } from "@tanstack/react-query";
import { listImports, listProjects, listSessions } from "./api/client";
import type { SessionCard } from "./api/types";
import ImportPage from "./pages/ImportPage";
import TriageBoard from "./triage/TriageBoard";
import SessionWorkspace from "./pages/SessionWorkspace";
import CostAnalyticsPage from "./analytics/CostAnalyticsPage";
import DiscoverPage from "./discover/DiscoverPage";
import GlossaryDialog from "./glossary/GlossaryDialog";
import Sidebar from "./shell/Sidebar";
import type { View } from "./shell/navConfig";
import { DEFAULT_TECHNIQUE } from "./discover/techniques";
import { useCollapsed } from "./shell/useCollapsed";
import { useTheme } from "./theme/useTheme";

function App() {
  const imports = useQuery({ queryKey: ["imports"], queryFn: listImports });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const sessions = useQuery({ queryKey: ["sessions", {}], queryFn: () => listSessions() });
  const [view, setView] = React.useState<View>("import");
  const [discoverTechnique, setDiscoverTechnique] = React.useState<string>(DEFAULT_TECHNIQUE);
  const [selectedSession, setSelectedSession] = React.useState<SessionCard | null>(null);
  const { theme, toggle } = useTheme();
  const { collapsed, toggle: toggleCollapsed } = useCollapsed();
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

  const selectTechnique = (key: string) => {
    setDiscoverTechnique(key);
    setView("discover");
  };

  const openGlossary = () => setGlossaryOpen(true);

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        discoverTechnique={discoverTechnique}
        collapsed={collapsed}
        sessionEnabled={!!selectedSession}
        theme={theme}
        onSelectView={setView}
        onSelectTechnique={selectTechnique}
        onToggleCollapsed={toggleCollapsed}
        onToggleTheme={toggle}
        onOpenGlossary={openGlossary}
      />

      <main className="app-main">
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
        {view === "discover" && (
          <DiscoverPage
            projects={projects.data ?? []}
            onOpenSession={openSessionById}
            technique={discoverTechnique}
          />
        )}
        {view === "session" && selectedSession && <SessionWorkspace session={selectedSession} />}
      </main>
    </div>
  );
}

export default App;
