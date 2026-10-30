import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getRuntimeConfig, listImports, listProjects, listSessions } from "./api/client";
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
  map: "Sessions",
  cost: "Cost",
  discover: "Explore",
};

type SessionHistoryRoute =
  | { view: SessionOrigin }
  | {
      view: "session";
      sessionId: number;
      origin: SessionOrigin;
      eventId: number | null;
    };

interface AppHistoryState {
  cya?: SessionHistoryRoute;
}

function historyUrl(route: SessionHistoryRoute): string {
  if (route.view === "session") return `#session/${route.sessionId}`;
  if (route.view === "map") return "#sessions";
  if (route.view === "discover") return "#explore";
  return "#cost";
}

function replaceOriginHistory(origin: SessionOrigin) {
  const route: SessionHistoryRoute = { view: origin };
  window.history.replaceState({ cya: route }, "", historyUrl(route));
}

function pushSessionHistory(
  sessionId: number,
  origin: SessionOrigin,
  eventId: number | null,
) {
  replaceOriginHistory(origin);
  const route: SessionHistoryRoute = { view: "session", sessionId, origin, eventId };
  window.history.pushState({ cya: route }, "", historyUrl(route));
}

function App() {
  const config = useQuery({ queryKey: ["config"], queryFn: getRuntimeConfig });
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
  // screen to Sessions. After that the user is free to navigate back to Import.
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

  React.useEffect(() => {
    const restoreHistoryRoute = (event: PopStateEvent) => {
      const route = (event.state as AppHistoryState | null)?.cya;
      if (!route) return;
      if (route.view === "session") {
        const card = sessions.data?.find((session) => session.id === route.sessionId);
        if (!card) return;
        setFocusEventId(route.eventId);
        setSessionOrigin(route.origin);
        setSelectedSession(card);
        setView("session");
        return;
      }
      setFocusEventId(null);
      setSessionOrigin(null);
      setSelectedSession(null);
      setView(route.view);
    };
    window.addEventListener("popstate", restoreHistoryRoute);
    return () => window.removeEventListener("popstate", restoreHistoryRoute);
  }, [sessions.data]);

  React.useEffect(() => {
    if (view !== "session") return;
    const navigateBackOnBackspace = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const editable = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
        if (editable) return;
      }
      event.preventDefault();
      window.history.back();
    };
    window.addEventListener("keydown", navigateBackOnBackspace);
    return () => window.removeEventListener("keydown", navigateBackOnBackspace);
  }, [view]);

  const openSession = (session: SessionCard, origin: SessionOrigin) => {
    pushSessionHistory(session.id, origin, null);
    setFocusEventId(null);
    setSessionOrigin(origin);
    setSelectedSession(session);
    setView("session");
  };

  const openSessionById = (sessionId: number, eventId: number | null, origin: SessionOrigin) => {
    const card = sessions.data?.find((s) => s.id === sessionId);
    if (!card) return;
    pushSessionHistory(sessionId, origin, eventId);
    setFocusEventId(eventId ?? null);
    setSessionOrigin(origin);
    setSelectedSession(card);
    setView("session");
  };

  const backToSessionOrigin = () => {
    if (sessionOrigin) {
      const route = (window.history.state as AppHistoryState | null)?.cya;
      if (route?.view === "session") {
        window.history.back();
        return;
      }
      setFocusEventId(null);
      setSelectedSession(null);
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
        appVersion={config.data?.app_version}
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
            onHistoricalChange={setHistoricalPricing}
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
            historical={historicalPricing}
          />
        )}
      </main>
    </div>
    </PrivacyModeProvider>
  );
}

export default App;
