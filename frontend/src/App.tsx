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
import { useGlossaryHint } from "./shell/useGlossaryHint";
import { useTheme } from "./theme/useTheme";

function App() {
  const imports = useQuery({ queryKey: ["imports"], queryFn: listImports });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const sessions = useQuery({ queryKey: ["sessions", {}], queryFn: () => listSessions() });
  const [view, setView] = React.useState<View>("import");
  const [discoverTechnique, setDiscoverTechnique] = React.useState<string>(DEFAULT_TECHNIQUE);
  const [selectedSession, setSelectedSession] = React.useState<SessionCard | null>(null);
  // Event to land on when a view deep-links into the session workspace.
  const [focusEventId, setFocusEventId] = React.useState<number | null>(null);
  const { theme, toggle } = useTheme();
  const { collapsed, toggle: toggleCollapsed } = useCollapsed();
  const { seen: glossaryHintSeen, dismiss: dismissGlossaryHint } = useGlossaryHint();
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
    setFocusEventId(null);
    setSelectedSession(session);
    setView("session");
  };

  const openSessionById = (sessionId: number, eventId?: number | null) => {
    const card = sessions.data?.find((s) => s.id === sessionId);
    if (!card) return;
    setFocusEventId(eventId ?? null);
    setSelectedSession(card);
    setView("session");
  };

  const selectTechnique = (key: string) => {
    setDiscoverTechnique(key);
    setView("discover");
  };

  // Opening the glossary (from the button or the hint's CTA) counts as
  // discovery, so retire the first-run hint at the same time.
  const openGlossary = () => {
    setGlossaryOpen(true);
    dismissGlossaryHint();
  };

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
        glossaryHint={!glossaryHintSeen}
        onDismissGlossaryHint={dismissGlossaryHint}
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
        {view === "session" && selectedSession && (
          <SessionWorkspace session={selectedSession} initialEventId={focusEventId} />
        )}
      </main>
    </div>
  );
}

export default App;
