import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, Sparkles } from "lucide-react";
import { getDiscoveryAnalytics } from "../api/client";
import InsightStat from "../components/InsightStat";
import type { DiscoveryDriver, DiscoveryExample, DiscoverySection, Project } from "../api/types";

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

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
}

function formatLift(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}x baseline`;
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
            <strong>{exampleTitle(example)}</strong>
            {meta && <span>{meta}</span>}
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
  const baseline = Math.min(driver.baseline_rate * 100, 100);
  const matched = Math.min(driver.subgroup_rate * 100, 100);

  return (
    <div className="driver-bars" aria-label={`${formatPct(driver.subgroup_rate)} matched versus ${formatPct(driver.baseline_rate)} baseline`}>
      <div className="driver-bar-row">
        <span>Baseline</span>
        <i><b style={{ width: `${baseline}%` }} /></i>
        <em>{formatPct(driver.baseline_rate)}</em>
      </div>
      <div className="driver-bar-row strong">
        <span>Matched group</span>
        <i><b style={{ width: `${matched}%` }} /></i>
        <em>{formatPct(driver.subgroup_rate)}</em>
      </div>
    </div>
  );
}

function DriverRow({
  driver,
  expanded,
  onToggle,
  onOpenSession,
}: {
  driver: DiscoveryDriver;
  expanded: boolean;
  onToggle: () => void;
  onOpenSession: (sessionId: number) => void;
}) {
  return (
    <article className={`driver-row ${expanded ? "is-expanded" : ""}`}>
      <button type="button" className="driver-summary" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span className="driver-main">
          <strong>{driver.title}</strong>
          <small>{driver.positive_support} of {driver.support} matched items hit the target</small>
        </span>
        <span className="driver-lift">{formatLift(driver.lift)}</span>
      </button>

      {expanded && (
        <div className="driver-evidence">
          <p>{driver.summary}</p>
          <ComparisonBar driver={driver} />
          <div className="driver-selector-list" aria-label="Matched conditions">
            {driver.selectors.map((selector) => <span key={selector}>{selector}</span>)}
          </div>
          <div className="driver-evidence-grid">
            <div>
              <h3>Matched group</h3>
              <p>{driver.positive_support} of {driver.support} matched items hit this outcome.</p>
            </div>
            <div>
              <h3>Baseline</h3>
              <p>{formatPct(driver.baseline_rate)} across the current scope.</p>
            </div>
          </div>
          <h3>Examples</h3>
          <ExampleList examples={driver.examples} onOpenSession={onOpenSession} />
        </div>
      )}
    </article>
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
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // Auto-expand the first driver when the user switches sections. Depend only on
  // the section identity so a background refetch within the same section does not
  // collapse the row the user currently has open.
  React.useEffect(() => {
    setExpandedId(section?.results[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section?.key]);

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

  return (
    <div className={`driver-list ${isRefetching ? "is-refetching" : ""}`}>
      {section.results.map((driver) => (
        <DriverRow
          key={driver.id}
          driver={driver}
          expanded={expandedId === driver.id}
          onToggle={() => setExpandedId((current) => current === driver.id ? null : driver.id)}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}

export default function DiscoverPage({ projects, onOpenSession }: Props) {
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

  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <section className="discover-head">
          <div>
            <p className="discover-kicker"><Sparkles size={14} /> Drivers</p>
            <h1>Discover</h1>
          </div>
          <div className="discover-controls">
            <label className="selectbox">
              <span>Project</span>
              <select value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value ? Number(event.target.value) : null)}>
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option value={project.id} key={project.id}>{project.display_name}</option>
                ))}
              </select>
            </label>
            <label className="selectbox">
              <span>Minimum support</span>
              <select value={minSupport} onChange={(event) => setMinSupport(Number(event.target.value))}>
                {SUPPORT_OPTIONS.map((value) => <option value={value} key={value}>{value}</option>)}
              </select>
            </label>
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
            label="Support"
            value={formatCount(minSupport)}
            hint="minimum matched items"
          />
          <InsightStat
            label="Cost data"
            value={payload ? (payload.meta.cost_available ? "Available" : "Missing") : "-"}
            hint={payload?.meta.cost_available ? "priced models loaded" : "cost sections may be unavailable"}
          />
        </section>

        <section className="discover-workspace">
          <div className="discover-tabs" role="tablist" aria-label="Driver category">
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

          <div
            id="discover-tabpanel"
            role="tabpanel"
            aria-labelledby={`discover-tab-${activeSection}`}
            className="discover-tabpanel"
          >
            <div className="discover-section-head">
              <div>
                <h2>{section?.title ?? "Drivers"}</h2>
                <p>{section?.description ?? "Conditions that shape this outcome."}</p>
              </div>
              {section && (
                <span className="discover-section-meta">
                  <b>{formatCount(section.positive_count)} of {formatCount(section.baseline_count)}</b>
                  <small>{section.target_label}</small>
                </span>
              )}
            </div>

            {query.isError ? (
              <div className="empty-state panel-error">
                <strong>Discovery failed.</strong>
                <span>{errorMessage}</span>
              </div>
            ) : query.isLoading || !payload ? (
              <div className="empty-state">Loading discovery results...</div>
            ) : (
              <SectionResults section={section} isRefetching={isRefetching} onOpenSession={onOpenSession} />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
