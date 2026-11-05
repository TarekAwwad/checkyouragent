import React from "react";
import { useQuery } from "@tanstack/react-query";
import { getRuntimeConfig, listProjects, listSessions, listTeamImports } from "./api/client";
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
import { initialHashView, isAnalyticalView, useLandingPage } from "./shell/useLandingPage";
import { DEFAULT_TECHNIQUE } from "./discover/techniques";
import { useCollapsed } from "./shell/useCollapsed";
import { useGlossaryHint } from "./shell/useGlossaryHint";
import { useSettings } from "./shell/useSettings";
import { PrivacyModeProvider } from "./shell/PrivacyModeContext";
import { useTheme } from "./theme/useTheme";
import LoadingBar from "./components/LoadingBar";
import { initialCostViewState, initialSessionsViewState } from "./shell/investigationState";

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
  cya?: SessionHistoryRoute | { view: "import" | "export" };
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
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const sessions = useQuery({ queryKey: ["sessions", {}], queryFn: () => listSessions() });
  const { scope, setScope } = useDataScope();
  const teamImports = useQuery({ queryKey: ["team-import-list"], queryFn: listTeamImports, enabled: scope === "team" });
  const activeDataset = scope === "team" ? teamImports : sessions;
  // A failed availability check is not evidence of an empty dataset. Open the
  // remembered analytical page; its own request can display the actual error.
  const hasData = activeDataset.isPending ? undefined
    : activeDataset.isError || (activeDataset.data?.length ?? 0) > 0;
  const { view, setView } = useLandingPage(scope, hasData);
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
  // Investigation state stays in this app visit, separate from the persisted
  // landing-page preference and from the other data scope's identifiers.
  const costMemory = React.useRef({
    local: { current: initialCostViewState() },
    team: { current: initialCostViewState() },
  });
  const sessionsMemory = React.useRef(initialSessionsViewState());
  const [contextEpoch, setContextEpoch] = React.useState({ local: 0, team: 0 });
  const hadLocalData = React.useRef(false);
  const teamDataset = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!sessions.isSuccess) return;
    const populated = sessions.data.length > 0;
    if (hadLocalData.current && !populated) {
      costMemory.current.local.current = initialCostViewState();
      sessionsMemory.current = initialSessionsViewState();
      setContextEpoch((current) => ({ ...current, local: current.local + 1 }));
    }
    hadLocalData.current = populated;
  }, [sessions.isSuccess, sessions.data]);

  React.useEffect(() => {
    if (!teamImports.isSuccess) return;
    const dataset = teamImports.data.map((record) => `${record.id}:${record.bundle_id}:${record.imported_at}`).sort().join("|");
    if (teamDataset.current !== null && teamDataset.current !== dataset) {
      // Team project ids are synthetic and can be reassigned after bundles
      // change. Discard their old context instead of selecting another project.
      costMemory.current.team.current = initialCostViewState();
      setContextEpoch((current) => ({ ...current, team: current.team + 1 }));
    }
    teamDataset.current = dataset;
  }, [teamImports.isSuccess, teamImports.data]);

  // Keep analytical and data-management pages addressable. Session navigation
  // retains its origin entry so browser Back returns to the investigation.
  React.useEffect(() => {
    if (view === null || view === "session") return;
    const hash = view === "map" ? (scope === "team" ? "#overview" : "#sessions")
      : view === "discover" ? "#explore"
      : view === "import" ? (scope === "team" ? "#bundles" : "#sources")
      : view === "export" ? "#share" : "#cost";
    window.history.replaceState({ cya: { view } }, "", hash);
  }, [scope, view]);

  // A directly opened session URL waits for the local index before resolving.
  React.useEffect(() => {
    if (view !== "session" || selectedSession || sessions.isPending) return;
    const id = Number(window.location.hash.match(/^#session\/(\d+)$/)?.[1]);
    const card = sessions.data?.find((session) => session.id === id);
    if (!card) {
      setView("cost");
      return;
    }
    const saved = (window.history.state as AppHistoryState | null)?.cya;
    const savedSession = saved?.view === "session" && saved.sessionId === id ? saved : null;
    const origin = savedSession && isAnalyticalView(savedSession.origin, scope) ? savedSession.origin : "cost";
    setFocusEventId(savedSession?.eventId ?? null);
    setSessionOrigin(origin);
    setSelectedSession(card);
  }, [view, selectedSession, sessions.isPending, sessions.data, scope, setView]);

  React.useEffect(() => {
    const restoreHashRoute = () => {
      const target = initialHashView(scope);
      if (target === null) return;
      setFocusEventId(null);
      setSessionOrigin(null);
      setSelectedSession(null);
      setView(target);
    };
    const restoreHistoryRoute = (event: PopStateEvent) => {
      const route = (event.state as AppHistoryState | null)?.cya;
      if (!route) {
        restoreHashRoute();
        return;
      }
      if (scope === "team" && (route.view === "session" || route.view === "discover" || route.view === "export")) return;
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
    window.addEventListener("hashchange", restoreHashRoute);
    return () => {
      window.removeEventListener("popstate", restoreHistoryRoute);
      window.removeEventListener("hashchange", restoreHashRoute);
    };
  }, [sessions.data, scope, setView]);

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

        {view === null && <div className="empty-state"><LoadingBar caption="Opening your workspace…" /></div>}
        {view === "import" && scope === "local" && <ImportPage onViewCosts={() => setView("cost")} />}
        {view === "import" && scope === "team" && <TeamBundleImport onViewCosts={() => setView("cost")} />}
        {view === "export" && <TeamBundleExport />}
        {view === "map" && scope === "team" && <TeamOverview onGoToImport={() => setView("import")} />}
        {view === "map" && scope === "local" && (
          <TriageBoard
            key={contextEpoch.local}
            memory={sessionsMemory}
            projects={projects.data ?? []}
            sessions={sessions.data ?? []}
            loading={projects.isLoading || sessions.isLoading}
            onOpenSession={(session) => openSession(session, "map")}
          />
        )}
        {view === "cost" && (
          <CostAnalyticsPage
            key={`${scope}:${contextEpoch[scope]}`}
            memory={costMemory.current[scope]}
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
