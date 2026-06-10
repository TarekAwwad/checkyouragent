// Shared glossary of domain terms used across the dashboards. Keeping the
// content here (rather than inline in the dialog) makes it the single place to
// edit definitions and lets tests assert against the data directly.

export type GlossaryCategory =
  | "Structure"
  | "Activity"
  | "Risk"
  | "Discovery"
  | "Cost";

export interface GlossaryTerm {
  category: GlossaryCategory;
  term: string;
  definition: string;
  // Optional "how it's computed" lines, rendered as a monospace block beneath
  // the definition. Used for the scores where the exact mechanics help a dev
  // reconcile what they see on screen with how it was produced.
  detail?: string[];
}

export const CATEGORY_ORDER: GlossaryCategory[] = [
  "Structure",
  "Activity",
  "Risk",
  "Discovery",
  "Cost",
];

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
  {
    category: "Structure",
    term: "Memory",
    definition:
      "A fact Claude Code persisted during a session so it carries across runs (for example a note written to a memory file). The Import page's \"Memory\" stat counts how many were captured across all sessions.",
  },
  {
    category: "Structure",
    term: "Large output",
    definition:
      "A tool output big enough that it was stored on its own rather than inline with the event — typically a heavy file read or verbose command output. The Import page's \"Large outputs\" stat counts these.",
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
  {
    category: "Activity",
    term: "Loop span",
    definition:
      "The highlighted stretch drawn on the timeline that marks a detected loop — the visual span covering the repeated events.",
  },
  {
    category: "Activity",
    term: "Lane",
    definition:
      "Each horizontal row in the Session timeline. The top lane is the main thread; each lane below is one subagent, labelled with its agent ID (the short hex string).",
  },
  {
    category: "Activity",
    term: "Collapsed run (×N)",
    definition:
      "On the timeline, a run of N near-identical consecutive events folded into a single marker labelled ×N (e.g. ×50) to keep dense stretches readable. Toggle it with \"Group dense\".",
  },
  {
    category: "Activity",
    term: "Group dense",
    definition:
      "The timeline toggle that collapses dense runs of similar events into ×N markers. Turn it off to see every event individually.",
  },
  {
    category: "Activity",
    term: "Timeline spacing",
    definition:
      "How the timeline spaces events along the x-axis. Raw time uses real wall-clock gaps; Compressed gaps shortens long idle stretches so activity isn't squished; Event order ignores time and spaces events evenly.",
  },

  // Risk — the Triage rank and the findings/patterns behind it.
  {
    category: "Risk",
    term: "Risk score",
    definition:
      "The Triage \"Risk\" number — a single rank for how much a session is worth reviewing. Higher means more (errors, stuck loops, heavy fan-out, size, or risky patterns). It's a relative sort key, not a probability.",
    detail: [
      "Weighted sum of 5 signals, each squashed to 0–1",
      "via  value / (value + scale):",
      "",
      "  Alerts    ×3     errors + system events",
      "  Loops     ×2     loop count × longest repeat",
      "  Fanout    ×1.5   subagents + agent events",
      "  Size      ×1     max of events / time / tokens",
      "  Patterns  ×2     risky-pattern findings score",
    ],
  },
  {
    category: "Risk",
    term: "Risk tiers (color)",
    definition:
      "The color of the Risk score reflects its tier. The thin segmented underline shows which signals are driving that score.",
    detail: ["High    score ≥ 6", "Medium  score ≥ 3", "Low     score < 3"],
  },
  {
    category: "Risk",
    term: "Finding",
    definition:
      "A risky pattern detected in a session's sequence of tool calls. The top finding shows in Triage's \"Findings\" column, and findings feed the Patterns signal of the Risk score.",
  },
  {
    category: "Risk",
    term: "Finding types",
    definition:
      "Every finding is sorted into one of these categories, based on the tool-call sequence that triggered it.",
    detail: [
      "Unsafe write attempt   edit/write hit a safety error",
      "Permission friction    tool denied or user-rejected",
      "Environment mismatch   missing dep, timeout, validation",
      "Subagent failure       error inside a delegated agent",
      "Failed verification    test/lint failed, then a repair",
      "Rare risky workflow    uncommon vs the local baseline",
    ],
  },

  // Discovery — the Subgroup view that explains outcomes.
  {
    category: "Discovery",
    term: "Subgroup (driver)",
    definition:
      "A set of conditions that, when they co-occur, line up with an outcome far more often than the average session does. Discovery surfaces the subgroups that most \"drive\" each outcome.",
  },
  {
    category: "Discovery",
    term: "Outcome",
    definition:
      "The thing a subgroup is being measured against — the tabs at the top of Discover: high Cost, high-cost Fanout, Tool errors, and Rejections.",
  },
  {
    category: "Discovery",
    term: "Selector / condition",
    definition:
      "One of the chips that defines a subgroup, e.g. \"uses claude-sonnet-4-6\" or \">10 subagents\". A subgroup is the sessions matching all of its selectors.",
  },
  {
    category: "Discovery",
    term: "Lift",
    definition:
      "How many times more often the subgroup hits the outcome than the average session. A 5.83× lift means sessions matching the conditions hit it 5.83 times as often as the baseline rate.",
    detail: [
      "lift =  (matches hitting outcome ÷ matches)",
      "        ─────────────────────────────────",
      "        (all hitting outcome ÷ all sessions)",
    ],
  },
  {
    category: "Discovery",
    term: "Support / Min support",
    definition:
      "Support is how many sessions match the subgroup's conditions. The a/b figure (e.g. 70/79) is how many of those matches hit the outcome. \"Min support\" is the threshold a subgroup must clear to be reported — raise it to drop tiny, noisy subgroups.",
  },
  {
    category: "Discovery",
    term: "Subgroup vs baseline rate",
    definition:
      "The two comparison bars: how often the subgroup hits the outcome versus how often all sessions do. The gap between them is what the lift summarizes.",
  },
  {
    category: "Discovery",
    term: "95% confidence lower bound",
    definition:
      "The \"stays at or above X%\" figure. Even on a pessimistic reading of a small sample, the subgroup's rate is still expected to beat the baseline — a guard against being fooled by a handful of sessions.",
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
    term: "Total spend",
    definition:
      "The headline dollar figure on the Cost page: the summed cost across the sessions in the current time range and project filter.",
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
    term: "Cache saved / penalty",
    definition:
      "Net effect of caching versus paying full price for the same input: a saving when cache reads outweigh the write surcharge, a penalty when prefixes were cached but rarely reused.",
  },
  {
    category: "Cost",
    term: "Spend spike",
    definition:
      "A point in time where cost jumped sharply above the surrounding baseline. The Cost page's \"Largest spike\" names the date bucket and how much it jumped.",
  },
  {
    category: "Cost",
    term: "Outside target",
    definition:
      "From the turn-distribution chart: the count of sessions whose number of turns falls outside the healthy band — unusually short or unusually long — and may be worth a look.",
  },
];
