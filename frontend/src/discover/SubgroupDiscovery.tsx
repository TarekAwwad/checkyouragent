import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Target, TrendingUp } from "lucide-react";
import { getDiscoveryAnalytics } from "../api/client";
import InsightStat from "../components/InsightStat";
import LoadingBar from "../components/LoadingBar";
import type { DiscoveryDriver, DiscoveryExample, DiscoverySection, Project } from "../api/types";
import { Blurred } from "../shell/Blurred";

interface Props {
  projects: Project[];
  onOpenSession: (sessionId: number) => void;
}

const SECTION_TABS: Array<{ key: string; label: string }> = [
  { key: "cost", label: "Cost" },
  { key: "fanout_cost", label: "Fanout" },
  { key: "tool_errors", label: "Tool errors" },
  { key: "rejections", label: "Rejections" },
];

const SUPPORT_OPTIONS = [3, 5, 10, 20];

const OUTCOME_HEADLINES: Record<string, string> = {
  cost: "What drives high-cost sessions?",
  fanout_cost: "What drives high-cost fanout sessions?",
  tool_errors: "What drives tool-call errors?",
  rejections: "What drives rejected slices?",
};

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
}

function formatLift(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}×`;
}

function formatDelta(from: number, to: number): string {
  return `+${((to - from) * 100).toFixed(1)} pts`;
}

function formatBarWidth(value: number): string {
  return `${Math.min(value * 100, 100).toFixed(2)}%`;
}

function formatOutcome(label: string): string {
  return label ? label.charAt(0).toLowerCase() + label.slice(1) : "this outcome";
}

function exampleTitle(example: DiscoveryExample): string {
  return example.title || example.session_id || "Untitled session";
}

function ExampleList({
  examples,
  onOpenSession,
}: {
  examples: DiscoveryExample[];
  onOpenSession: (sessionId: number) => void;
}) {
  if (examples.length === 0) {
    return <p className="discover-muted">No examples available.</p>;
  }

  return (
    <ul className="discover-examples">
      {examples.map((example, index) => {
        const meta = [example.project_name, example.detail].filter(Boolean).join(" - ");
        return (
        <li key={`${example.kind}-${example.id ?? index}-${example.session_id ?? index}`}>
          <div>
            <strong><Blurred>{exampleTitle(example)}</Blurred></strong>
            {meta && <span><Blurred>{meta}</Blurred></span>}
          </div>
          {example.id !== null && (
            <button type="button" onClick={() => onOpenSession(example.id as number)}>
              <ExternalLink size={13} />
              Open session
            </button>
          )}
        </li>
        );
      })}
    </ul>
  );
}

function ComparisonBar({ driver }: { driver: DiscoveryDriver }) {
  return (
    <div className="driver-bars" aria-label={`${formatPct(driver.subgroup_rate)} sessions like this versus ${formatPct(driver.baseline_rate)} all sessions`}>
      <div className="driver-bar-row">
        <span>All sessions</span>
        <i><b style={{ width: formatBarWidth(driver.baseline_rate) }} /></i>
        <em>{formatPct(driver.baseline_rate)}</em>
      </div>
      <div className="driver-bar-row strong">
        <span>Sessions like this</span>
        <i><b style={{ width: formatBarWidth(driver.subgroup_rate) }} /></i>
        <em>{formatPct(driver.subgroup_rate)}</em>
      </div>
    </div>
  );
}

function SelectorChips({ selectors }: { selectors: string[] }) {
  return (
    <div className="driver-selector-list" aria-label="Conditions">
      {selectors.map((selector) => <span key={selector}>{selector}</span>)}
    </div>
  );
}

function DriverSpotlight({
  driver,
  section,
}: {
  driver: DiscoveryDriver;
  section: DiscoverySection;
}) {
  const outcome = formatOutcome(section.target_label);
  const headline = OUTCOME_HEADLINES[section.key] || section.title;

  return (
    <article className="driver-spotlight">
      <div className="driver-spotlight-copy">
        <span className="driver-outcome-pill">
          <Target size={13} />
          {section.target_label}
        </span>
        <h3>{headline}</h3>
        <strong className="driver-finding-title">{driver.title}</strong>
        <p>
          Sessions like this hit {outcome} {formatPct(driver.subgroup_rate)} of the time,
          compared with {formatPct(driver.baseline_rate)} across all sessions.
        </p>
        <p className="driver-confidence">
          Even on a conservative, Bonferroni-adjusted reading the rate stays at or above {formatPct(driver.subgroup_rate_low)},
          still ahead of the {formatPct(driver.baseline_rate)} baseline.
        </p>
        <SelectorChips selectors={driver.selectors} />
      </div>

      <div className="driver-spotlight-visual">
        <div className="driver-lift-card">
          <span>More likely</span>
          <strong>{formatLift(driver.lift)}</strong>
          <em>{formatDelta(driver.baseline_rate, driver.subgroup_rate)} vs all sessions</em>
        </div>
        <ComparisonBar driver={driver} />
        <div className="driver-evidence-grid">
          <div>
            <h3>Sessions like this</h3>
            <p>{driver.positive_support} of {driver.support} matching items hit {outcome}.</p>
          </div>
          <div>
            <h3>All sessions</h3>
            <p>{formatCount(section.positive_count)} of {formatCount(section.baseline_count)} hit {outcome}.</p>
          </div>
        </div>
      </div>
    </article>
  );
}

function DriverExamplesCard({
  driver,
  onOpenSession,
}: {
  driver: DiscoveryDriver;
  onOpenSession: (sessionId: number) => void;
}) {
  return (
    <article className="driver-examples-card">
      <div className="driver-card-head">
        <h3>Example sessions</h3>
        <span>{formatCount(driver.support)} matching total</span>
      </div>
      <ExampleList examples={driver.examples} onOpenSession={onOpenSession} />
    </article>
  );
}

function DriverCard({
  driver,
  section,
  selected,
  onSelect,
}: {
  driver: DiscoveryDriver;
  section: DiscoverySection;
  selected: boolean;
  onSelect: () => void;
}) {
  const outcome = formatOutcome(section.target_label);

  return (
    <button
      type="button"
      className={`driver-card ${selected ? "is-selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <span className="driver-card-topline">
        <span><TrendingUp size={13} /> {formatLift(driver.lift)} more likely</span>
        <b>{driver.positive_support}/{driver.support}</b>
      </span>
      <strong>{driver.title}</strong>
      <span className="driver-card-note">
        {formatPct(driver.subgroup_rate)} hit {outcome}
      </span>
      <span className="driver-card-bars" aria-hidden="true">
        <i><b style={{ width: formatBarWidth(driver.baseline_rate) }} /></i>
        <i><b style={{ width: formatBarWidth(driver.subgroup_rate) }} /></i>
      </span>
      <span className="driver-card-chipline">
        {driver.selectors.map((selector) => <em key={selector}>{selector}</em>)}
      </span>
    </button>
  );
}

function SectionResults({
  section,
  isRefetching,
  onOpenSession,
}: {
  section: DiscoverySection | undefined;
  isRefetching: boolean;
  onOpenSession: (sessionId: number) => void;
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  // Keep a visible insight selected, but preserve the user's choice when a
  // background refresh returns the same driver set.
  React.useEffect(() => {
    if (!section?.results.length) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => (
      current && section.results.some((driver) => driver.id === current)
        ? current
        : section.results[0].id
    ));
  }, [section?.key, section?.results]);

  if (!section) {
    return <div className="empty-state">No discovery section returned.</div>;
  }
  if (section.baseline_count === 0) {
    return <div className="empty-state">No imported sessions available.</div>;
  }
  if (!section.available) {
    return (
      <div className="empty-state">
        <strong>{section.title} unavailable.</strong>
        <span>{section.unavailable_reason || "Required data is unavailable."}</span>
      </div>
    );
  }
  if (section.results.length === 0) {
    return <div className="empty-state">No drivers meet the current support threshold.</div>;
  }

  const selectedDriver = section.results.find((driver) => driver.id === selectedId) ?? section.results[0];

  return (
    <div className={`driver-list ${isRefetching ? "is-refetching" : ""}`}>
      <div className="driver-board">
        <div className="driver-main-column">
          <DriverSpotlight driver={selectedDriver} section={section} />
          <DriverExamplesCard driver={selectedDriver} onOpenSession={onOpenSession} />
        </div>
        <aside className="driver-list-card">
          <div className="driver-card-head">
            <h3>Subgroups</h3>
            <span>{section.results.length}</span>
          </div>
          <div className="driver-card-grid" aria-label="Drivers">
            {section.results.map((driver) => (
              <DriverCard
                key={driver.id}
                driver={driver}
                section={section}
                selected={selectedDriver.id === driver.id}
                onSelect={() => setSelectedId(driver.id)}
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function SubgroupDiscovery({ projects, onOpenSession }: Props) {
  const [projectId, setProjectId] = React.useState<number | null>(null);
  const [minSupport, setMinSupport] = React.useState(5);
  const [activeSection, setActiveSection] = React.useState("cost");
  const query = useQuery({
    queryKey: ["discovery", projectId, minSupport],
    queryFn: () => getDiscoveryAnalytics({ projectId, minSupport }),
    // Keep the current results on screen while a new filter loads so the panel
    // doesn't flash back to the loading state and jump.
    placeholderData: (previous) => previous,
    // This endpoint is expensive: don't silently refetch on window focus and
    // treat results as fresh for a minute.
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  const payload = query.data;
  const isRefetching = query.isFetching && !query.isLoading;
  const section = payload?.sections[activeSection];
  const totalResults = payload
    ? Object.values(payload.sections).reduce((sum, item) => sum + item.results.length, 0)
    : 0;
  const errorMessage = query.error instanceof Error ? query.error.message : "Unable to load discovery results.";

  const topLift =
    section && section.results.length
      ? Math.max(...section.results.map((result) => result.lift))
      : null;

  // Match the other discovery views: on the initial load, show only a centred
  // loader — the toolbar and summary appear once results are ready. `placeholderData`
  // keeps `isPending` false on later filter changes, so this never flashes back.
  if (query.isPending) {
    return (
      <main className="discover-page">
        <div className="discover-page-inner">
          <div className="loading-view"><LoadingBar caption="Loading discovery results…" /></div>
        </div>
      </main>
    );
  }

  return (
    <main className={`discover-page discover-section-${activeSection}`}>
      <div className="discover-page-inner">
        <section className="discover-toolbar" aria-label="Discovery controls">
          <div className="discover-tabs" role="tablist" aria-label="Outcome category">
            {SECTION_TABS.map((tab) => (
              <button
                type="button"
                role="tab"
                key={tab.key}
                id={`discover-tab-${tab.key}`}
                aria-controls="discover-tabpanel"
                className={activeSection === tab.key ? "active" : ""}
                aria-selected={activeSection === tab.key}
                onClick={() => setActiveSection(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="cost-filterbar discover-filterbar">
            <select
              aria-label="Project"
              value={projectId ?? ""}
              onChange={(event) => setProjectId(event.target.value ? Number(event.target.value) : null)}
            >
              <option value="">All projects</option>
              {projects.map((project) => (
                <option value={project.id} key={project.id}>{project.display_name}</option>
              ))}
            </select>
            <select
              aria-label="Minimum support"
              value={minSupport}
              onChange={(event) => setMinSupport(Number(event.target.value))}
            >
              {SUPPORT_OPTIONS.map((value) => (
                <option value={value} key={value}>Min support: {value}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="discover-overview" aria-label="Discovery summary">
          <InsightStat
            label="Scope"
            value={payload ? formatCount(payload.meta.total_sessions) : "-"}
            hint="sessions"
          />
          <InsightStat
            label="Drivers"
            value={payload ? formatCount(totalResults) : "-"}
            hint="matching current support"
          />
          <InsightStat
            label="Top lift"
            value={topLift !== null ? `${topLift.toFixed(topLift >= 10 ? 1 : 2)}×` : "—"}
            hint="vs baseline"
          />
        </section>

        <section className="discover-workspace">
          <div
            id="discover-tabpanel"
            role="tabpanel"
            aria-labelledby={`discover-tab-${activeSection}`}
            className="discover-tabpanel"
          >
            {query.isError ? (
              <div className="empty-state panel-error">
                <strong>Discovery failed.</strong>
                <span>{errorMessage}</span>
              </div>
            ) : (
              <SectionResults section={section} isRefetching={isRefetching} onOpenSession={onOpenSession} />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
