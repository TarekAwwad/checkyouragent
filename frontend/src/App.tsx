import React from "react";
import { useQuery } from "@tanstack/react-query";
import { listImports, listProjects, listSessions } from "./api/client";
import type { SessionCard } from "./api/types";
import ImportPage from "./pages/ImportPage";
import TriageBoard from "./triage/TriageBoard";
import SessionWorkspace from "./pages/SessionWorkspace";
import CostAnalyticsPage from "./analytics/CostAnalyticsPage";
import DiscoverPage from "./discover/DiscoverPage";
import TeamOverview from "./team/TeamOverview";
import TeamBundleExport from "./team/TeamBundleExport";
import TeamBundleImport from "./team/TeamBundleImport";
import GlossaryDialog from "./glossary/GlossaryDialog";
import Sidebar from "./shell/Sidebar";
import type { View } from "./shell/navConfig";
import { useDataScope } from "./shell/useDataScope";
import { DEFAULT_TECHNIQUE } from "./discover/techniques";
import { useCollapsed } from "./shell/useCollapsed";
import { useGlossaryHint } from "./shell/useGlossaryHint";
import { useSettings } from "./shell/useSettings";
import { PrivacyModeProvider } from "./shell/PrivacyModeContext";
import { useTheme } from "./theme/useTheme";

type SessionOrigin = Extract<View, "map" | "cost" | "discover">;

const SESSION_ORIGIN_LABELS: Record<SessionOrigin, string> = {
  map: "Overview",
  cost: "Cost",
  discover: "Explore",
};

function App() {
  const imports = useQuery({ queryKey: ["imports"], queryFn: listImports });
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const sessions = useQuery({ queryKey: ["sessions", {}], queryFn: () => listSessions() });
  const [view, setView] = React.useState<View>("import");
  const { scope, setScope } = useDataScope();
  const [discoverTechnique, setDiscoverTechnique] = React.useState<string>(DEFAULT_TECHNIQUE);
  const [selectedSession, setSelectedSession] = React.useState<SessionCard | null>(null);
  const [sessionOrigin, setSessionOrigin] = React.useState<SessionOrigin | null>(null);
  // Event to land on when a view deep-links into the session workspace.
  const [focusEventId, setFocusEventId] = React.useState<number | null>(null);
  const { theme, toggle } = useTheme();
  const { collapsed, toggle: toggleCollapsed } = useCollapsed();
  const { historicalPricing, setHistoricalPricing, privacyMode, setPrivacyMode } = useSettings();
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

  // Team scope only exposes the aggregate views (Import, Overview, Cost). If the
  // user flips to team while on a local-only view (Export, Explore, a session),
  // fall back to Overview rather than showing a view with no team equivalent.
  React.useEffect(() => {
    if (scope === "team" && view !== "import" && view !== "map" && view !== "cost") {
      setView("map");
    }
  }, [scope, view]);

  const openSession = (session: SessionCard, origin: SessionOrigin) => {
    setFocusEventId(null);
    setSessionOrigin(origin);
    setSelectedSession(session);
    setView("session");
  };

  const openSessionById = (sessionId: number, eventId: number | null, origin: SessionOrigin) => {
    const card = sessions.data?.find((s) => s.id === sessionId);
    if (!card) return;
    setFocusEventId(eventId ?? null);
    setSessionOrigin(origin);
    setSelectedSession(card);
    setView("session");
  };

  const backToSessionOrigin = () => {
    if (sessionOrigin) {
      setView(sessionOrigin);
    }
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
    <PrivacyModeProvider value={privacyMode}>
    <div className="app-shell">
      <Sidebar
        view={view}
        scope={scope}
        discoverTechnique={discoverTechnique}
        collapsed={collapsed}
        theme={theme}
        onSelectView={setView}
        onSelectScope={setScope}
        onSelectTechnique={selectTechnique}
        onToggleCollapsed={toggleCollapsed}
        onToggleTheme={toggle}
        onOpenGlossary={openGlossary}
        historicalPricing={historicalPricing}
        onToggleHistoricalPricing={() => setHistoricalPricing(!historicalPricing)}
        privacyMode={privacyMode}
        onTogglePrivacyMode={() => setPrivacyMode(!privacyMode)}
        glossaryHint={!glossaryHintSeen}
        onDismissGlossaryHint={dismissGlossaryHint}
      />

      <main className="app-main">
        <GlossaryDialog open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />

        {view === "import" && scope === "local" && <ImportPage />}
        {view === "import" && scope === "team" && <TeamBundleImport />}
        {view === "export" && <TeamBundleExport />}
        {view === "map" && scope === "team" && <TeamOverview onGoToImport={() => setView("import")} />}
        {view === "map" && scope === "local" && (
          <TriageBoard
            projects={projects.data ?? []}
            sessions={sessions.data ?? []}
            loading={projects.isLoading || sessions.isLoading}
            onOpenSession={(session) => openSession(session, "map")}
          />
        )}
        {view === "cost" && (
          <CostAnalyticsPage
            scope={scope}
            onOpenSession={scope === "team" ? () => {} : (sessionId) => openSessionById(sessionId, null, "cost")}
            historical={historicalPricing}
          />
        )}
        {view === "discover" && scope === "local" && (
          <DiscoverPage
            projects={projects.data ?? []}
            onOpenSession={(sessionId, eventId = null) => openSessionById(sessionId, eventId, "discover")}
            technique={discoverTechnique}
          />
        )}
        {view === "session" && scope === "local" && selectedSession && (
          <SessionWorkspace
            session={selectedSession}
            initialEventId={focusEventId}
            backLabel={sessionOrigin ? `Back to ${SESSION_ORIGIN_LABELS[sessionOrigin]}` : undefined}
            onBack={sessionOrigin ? backToSessionOrigin : undefined}
          />
        )}
      </main>
    </div>
    </PrivacyModeProvider>
  );
}

export default App;
