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
        <div className="empty-state discover-soon">
          <strong>{technique.label}</strong>
          <span>This discovery technique isn't available yet.</span>
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
