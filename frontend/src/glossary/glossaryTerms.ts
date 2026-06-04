// Shared glossary of domain terms used across the dashboards. Keeping the
// content here (rather than inline in the dialog) makes it the single place to
// edit definitions and lets tests assert against the data directly.

export type GlossaryCategory = "Structure" | "Activity" | "Cost";

export interface GlossaryTerm {
  category: GlossaryCategory;
  term: string;
  definition: string;
}

export const CATEGORY_ORDER: GlossaryCategory[] = ["Structure", "Activity", "Cost"];

export const GLOSSARY_TERMS: GlossaryTerm[] = [
  // Structure — how a body of work is organized.
  {
    category: "Structure",
    term: "Project",
    definition:
      "A working directory that Claude Code operated in. Each project groups all the sessions recorded for that codebase.",
  },
  {
    category: "Structure",
    term: "Session",
    definition:
      "A single continuous run of Claude Code, from the first prompt to the last event. The unit you open in the Session view.",
  },
  {
    category: "Structure",
    term: "Main thread (agent)",
    definition:
      "The primary Claude agent driving the session — the one that talks to you directly and decides which tools to call. Also called the agent.",
  },
  {
    category: "Structure",
    term: "Subagent",
    definition:
      "A secondary agent the main thread spawns (via the Task tool) to handle an isolated piece of work. It runs its own turns and reports a result back to the main thread.",
  },
  {
    category: "Structure",
    term: "Import",
    definition:
      "One ingestion of session logs from a source folder into the database. Re-importing the same source updates existing sessions.",
  },

  // Activity — what happens inside a session.
  {
    category: "Activity",
    term: "Turn",
    definition:
      "One round of the conversation: a user message followed by the assistant's response, including any tool calls made before the assistant replies.",
  },
  {
    category: "Activity",
    term: "Event",
    definition:
      "A single recorded entry in the session log — a user message, an assistant message, a tool call, or a tool result. Events are the atoms the timeline is built from.",
  },
  {
    category: "Activity",
    term: "Tool call",
    definition:
      "A single use of a tool by an agent (reading a file, running a command, searching, etc.). Also called a tool use.",
  },
  {
    category: "Activity",
    term: "Loop",
    definition:
      "A stretch where the agent repeats a similar action without making progress. Flagged on the timeline as a possible stuck pattern worth reviewing.",
  },

  // Cost — token usage and spend.
  {
    category: "Cost",
    term: "Token",
    definition:
      "The unit models read and write text in. Cost and usage are measured in tokens; roughly a few characters each.",
  },
  {
    category: "Cost",
    term: "Cache write",
    definition:
      "Tokens billed to store a prompt prefix in the model's cache so later turns can reuse it. Costs more than normal input, paid once.",
  },
  {
    category: "Cost",
    term: "Cache read",
    definition:
      "Tokens served from a previously written cache instead of being reprocessed. Much cheaper than base input and the main source of cost savings.",
  },
  {
    category: "Cost",
    term: "Spend spike",
    definition:
      "A point in time where cost jumped sharply above the surrounding baseline. Highlighted on the cost charts so unusually expensive moments stand out.",
  },
];
