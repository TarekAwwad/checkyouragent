import { DEFAULT_TECHNIQUE, TECHNIQUES, type Technique } from "./techniques";
import type { Project } from "../api/types";

interface Props {
  projects: Project[];
  onOpenSession: (sessionId: number) => void;
  technique: string;
}

function ComingSoon({ technique }: { technique: Technique }) {
  return (
    <main className="discover-page">
      <div className="discover-page-inner">
        <section className="discover-head">
          <div>
            <p className="discover-kicker">{technique.label}</p>
            <h1>{technique.label}</h1>
            <p className="discover-subtitle">This discovery technique is not yet available.</p>
          </div>
        </section>
        <div className="empty-state discover-soon">
          <strong>Coming soon</strong>
          <span>{technique.label} isn't available yet.</span>
        </div>
      </div>
    </main>
  );
}

export default function DiscoverPage({ projects, onOpenSession, technique }: Props) {
  const active =
    TECHNIQUES.find((t) => t.key === technique) ??
    // DEFAULT_TECHNIQUE is always present in TECHNIQUES (same module), so this is safe.
    TECHNIQUES.find((t) => t.key === DEFAULT_TECHNIQUE)!;

  if (active.status !== "ready" || !active.component) {
    return <ComingSoon technique={active} />;
  }

  const Component = active.component;
  return <Component projects={projects} onOpenSession={onOpenSession} />;
}
