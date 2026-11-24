import React from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Target, TrendingUp } from "lucide-react";
import { getDiscoveryAnalytics } from "../api/client";
import InsightStat from "../components/InsightStat";
import LoadingBar from "../components/LoadingBar";
import type { DiscoveryDriver, DiscoveryExample, DiscoverySection } from "../api/types";
import { Blurred } from "../shell/Blurred";
import PageHeader from "../shell/PageHeader";
import FilterSelect from "../components/controls/FilterSelect";
import SegmentedControl from "../components/controls/SegmentedControl";
import { useAnalysisScope } from "../shell/analysisScope";

interface Props {
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
}

const SECTION_TABS: Array<{ key: string; label: string }> = [
  { key: "cost_associations", label: "Cost" },
  { key: "tool_error_associations", label: "Tool errors" },
];

const SUPPORT_OPTIONS = [3, 5, 10, 20];

const OUTCOME_HEADLINES: Record<string, string> = {
  cost_associations: "Observed cost association",
  tool_error_associations: "Observed tool-error association",
};

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
}

function formatEffect(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pts`;
}

function formatBarWidth(value: number): string {
  return `${Math.min(value * 100, 100).toFixed(2)}%`;
}

function formatOutcome(label: string): string {
  return label ? label.charAt(0).toLowerCase() + label.slice(1) : "this outcome";
}

function unitLabel(section: DiscoverySection, count = 2): string {
  const singular = section.observation_unit === "session" ? "session" : "tool call";
  return count === 1 ? singular : `${singular}s`;
}

function exampleTitle(example: DiscoveryExample): string {
  return example.title || example.session_id || "Untitled session";
}

function ExampleList({
  examples,
  onOpenSession,
}: {
  examples: DiscoveryExample[];
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
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
            <button type="button"
                    onClick={() => onOpenSession(example.id as number, example.event_id)}>
              <ExternalLink size={13} />
              Open receipt
            </button>
          )}
        </li>
        );
      })}
    </ul>
  );
}

function ComparisonBar({
  driver,
  section,
}: {
  driver: DiscoveryDriver;
  section: DiscoverySection;
}) {
  const units = unitLabel(section);
  return (
    <div className="driver-bars"
         aria-label={`${formatPct(driver.subgroup_rate)} matching ${units} versus ${formatPct(driver.complement_rate)} other ${units}`}>
      <div className="driver-bar-row">
        <span>Other {units}</span>
        <i><b style={{ width: formatBarWidth(driver.complement_rate) }} /></i>
        <em>{formatPct(driver.complement_rate)}</em>
      </div>
      <div className="driver-bar-row strong">
        <span>Matching {units}</span>
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
  const units = unitLabel(section);

  return (
    <article className="driver-spotlight">
      <div className="driver-spotlight-copy">
        <span className="driver-outcome-pill">
          <Target size={13} />
          {section.target_label}
        </span>
        <span className="driver-unit-pill">
          Unit: {section.observation_unit === "session" ? "session" : "tool call"}
        </span>
        <h3>{headline}</h3>
        <strong className="driver-finding-title">{driver.title}</strong>
        <p>
          Matching {units} had {outcome} {formatPct(driver.subgroup_rate)} of the time,
          compared with {formatPct(driver.complement_rate)} among other {units}.
        </p>
        <p className="driver-confidence">
          Observed association, not a causal result. The Bonferroni-adjusted
          lower bound is {formatPct(driver.subgroup_rate_low)}. Overall baseline {formatPct(driver.baseline_rate)}.
        </p>
        <SelectorChips selectors={driver.selectors} />
      </div>

      <div className="driver-spotlight-visual">
        <div className="driver-effect-card">
          <span>Observed difference</span>
          <strong>{formatEffect(driver.effect_size)}</strong>
          <em>matching vs other {units}</em>
        </div>
        <ComparisonBar driver={driver} section={section} />
        <div className="driver-evidence-grid">
          <div>
            <h3>Matching {units}</h3>
            <p>{driver.positive_support} of {driver.support} matching {units} had this outcome.</p>
          </div>
          <div>
            <h3>Other {units}</h3>
            <p>{driver.complement_positive_count} of {driver.complement_count} other {units} had this outcome.</p>
          </div>
        </div>
      </div>
    </article>
  );
}

function DriverExamplesCard({
  driver,
  section,
  onOpenSession,
}: {
  driver: DiscoveryDriver;
  section: DiscoverySection;
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
}) {
  return (
    <article className="driver-examples-card">
      <div className="driver-card-head">
        <h3>Evidence receipts</h3>
        <span>{formatCount(driver.support)} matching {unitLabel(section, driver.support)}</span>
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
        <span><TrendingUp size={13} /> {formatEffect(driver.effect_size)} associated</span>
        <b>{driver.positive_support}/{driver.support}</b>
      </span>
      <strong>{driver.title}</strong>
      <span className="driver-card-note">
        {formatPct(driver.subgroup_rate)} observed {outcome}
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
  unpricedModels,
}: {
  section: DiscoverySection | undefined;
  isRefetching: boolean;
  onOpenSession: (sessionId: number, eventId?: number | null) => void;
  unpricedModels: string[];
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
        {unpricedModels.length > 0 && (
          <span>Unpriced models: {unpricedModels.join(", ")}.</span>
        )}
      </div>
    );
  }
  if (section.results.length === 0) {
    return <div className="empty-state">No associations meet the current support threshold.</div>;
  }

  const selectedDriver = section.results.find((driver) => driver.id === selectedId) ?? section.results[0];

  return (
    <div className={`driver-list ${isRefetching ? "is-refetching" : ""}`}>
      <div className="driver-board">
        <div className="driver-main-column">
          <DriverSpotlight driver={selectedDriver} section={section} />
          <DriverExamplesCard driver={selectedDriver} section={section}
                              onOpenSession={onOpenSession} />
        </div>
        <aside className="driver-list-card">
          <div className="driver-card-head">
            <h3>Associations</h3>
            <span>{section.results.length}</span>
          </div>
          <div className="driver-card-grid" aria-label="Associations">
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

export default function SubgroupDiscovery({ onOpenSession }: Props) {
  const { projectId } = useAnalysisScope();
  const [minSupport, setMinSupport] = React.useState(5);
  const [activeSection, setActiveSection] = React.useState("cost_associations");
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

  const topEffect =
    section && section.results.length
      ? Math.max(...section.results.map((result) => result.effect_size))
      : null;
  const scopeCount = payload
    ? activeSection === "cost_associations"
      ? payload.meta.total_sessions
      : payload.meta.total_tool_calls
    : null;
  const scopeHint = activeSection === "cost_associations" ? "sessions" : "tool calls";

  const header = (
    <PageHeader
      section="Explore"
      title="Subgroups"
      experimental
      subtitle="Observed associations, not causes."
      status={isRefetching ? "Updating…" : null}
      scope={{ date: "fixed", project: "filter" }}
      filters={(
        <FilterSelect label="Minimum support" value={String(minSupport)}
                      onChange={(value) => setMinSupport(Number(value))}>
          {SUPPORT_OPTIONS.map((value) => (
            <option value={value} key={value}>Min support: {value}</option>
          ))}
        </FilterSelect>
      )}
      view={(
        <SegmentedControl
          variant="tabs"
          label="Association category"
          idPrefix="discover-tab"
          controls="discover-tabpanel"
          options={SECTION_TABS.map((tab) => ({ value: tab.key, label: tab.label }))}
          value={activeSection}
          onChange={setActiveSection}
        />
      )}
    />
  );

  if (query.isPending) {
    return (
      <main className="discover-page">
        <div className="discover-page-inner">
          {header}
          <div className="loading-view"><LoadingBar caption="Loading discovery results…" /></div>
        </div>
      </main>
    );
  }

  return (
    <main className={`discover-page discover-section-${activeSection}`}>
      <div className="discover-page-inner">
        {header}
        <section className="discover-overview" aria-label="Discovery summary">
          <InsightStat
            label="Scope"
            value={scopeCount !== null ? formatCount(scopeCount) : "-"}
            hint={scopeHint}
          />
          <InsightStat
            label="Associations"
            value={payload ? formatCount(totalResults) : "-"}
            hint="matching current support"
          />
          <InsightStat
            label="Largest difference"
            value={topEffect !== null ? formatEffect(topEffect) : "—"}
            hint="matching vs complement"
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
              <SectionResults section={section} isRefetching={isRefetching}
                              onOpenSession={onOpenSession}
                              unpricedModels={payload?.meta.unpriced_models ?? []} />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
