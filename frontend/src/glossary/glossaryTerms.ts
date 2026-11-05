// Shared glossary of domain terms used across the dashboards. Keeping the
// content here (rather than inline in the dialog) makes it the single place to
// edit definitions and lets tests assert against the data directly.

export type GlossaryCategory =
  | "Structure"
  | "Activity"
  | "Workflow"
  | "Evidence"
  | "Discovery"
  | "Cost";

export interface GlossaryTerm {
  category: GlossaryCategory;
  term: string;
  definition: string;
  // Optional "how it's computed" lines, rendered as a monospace block beneath
  // the definition. Used where exact mechanics help reconcile a displayed
  // result with how it was produced.
  detail?: string[];
}

export const CATEGORY_ORDER: GlossaryCategory[] = [
  "Structure",
  "Activity",
  "Workflow",
  "Evidence",
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
      "A local sync from the read-only source export into the rebuildable analytics cache. Syncing again updates new or changed projects from the files currently on disk; skipped records remain listed in Diagnostics.",
  },
  {
    category: "Structure",
    term: "Large output",
    definition:
      "A tool output big enough that it was stored on its own rather than inline with the event — typically a heavy file read or verbose command output. The Sources & sync page's \"Large outputs\" stat counts these.",
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
    term: "Same-tool streak",
    definition:
      "A neutral visual grouping for at least three consecutive calls to the same tool on one trace lane. It does not imply failure, wasted work, or risk.",
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

  // Workflow — the Usage Mindmap's phases and habits.
  {
    category: "Workflow",
    term: "Usage Mindmap",
    definition:
      "The experimental activity map on Explore. It groups observed tool calls and text-only assistant steps into workflow phases, tools, and recurring habits. It describes recorded activity, not cost attribution. Click a node to inspect its rule and supporting sessions.",
  },
  {
    category: "Workflow",
    term: "Workflow phase",
    definition:
      "The kind of work an observed activity represents, classified from its tool or step type. Every counted activity lands in exactly one of seven phases, so phase shares partition the observed activity sample and sum to 100%.",
    detail: [
      "Explore     reading & searching (Read, Grep, web)",
      "Plan        planning (TodoWrite, plan mode, ask)",
      "Implement   edits & writes (Edit, Write)",
      "Verify      test / build / lint commands",
      "Operate     other shell commands",
      "Delegate    work handed to subagents (Task)",
      "Synthesize  text-only turns; anything else",
    ],
  },
  {
    category: "Workflow",
    term: "Habit (good / anti)",
    definition:
      "A recurring behavior detected across session turns — for example planning before a burst of edits, or retrying a failing command unchanged. Each habit hangs off its home phase as a leaf and is labelled good or anti by its explicit rule. Its size is observed activity involved in the habit, not a cost or saving claim.",
  },
  {
    category: "Workflow",
    term: "Phase vs. habit",
    definition:
      "Phases and habits answer different questions. Phases partition the observed activity sample, so they sum to 100%. Habits overlay that partition: one habit can span several phases, so habit shares can overlap and do not sum to 100%. Read a phase as \"what kind of activity was recorded\" and a habit as \"which recurring rule matched that activity.\"",
  },

  // Evidence — how claims in the UI relate to the imported records.
  {
    category: "Evidence",
    term: "Observed",
    definition:
      "Directly present in the imported records or obtained by counting those records. Observed describes what was recorded; it does not by itself say whether the result is good, bad, or causal.",
  },
  {
    category: "Evidence",
    term: "Estimated",
    definition:
      "Calculated from observed inputs using a stated model or assumption, such as a pricing table or token-size approximation. Estimated values are useful approximations, not directly recorded facts.",
  },
  {
    category: "Evidence",
    term: "Inferred",
    definition:
      "Reconstructed from indirect evidence because the source export does not record the value directly. The UI states the reconstruction basis and sample wherever an inferred result is shown.",
  },
  {
    category: "Evidence",
    term: "Associated",
    definition:
      "A measured relationship between an attribute and an observed outcome in the current sample. Associated is not a causal conclusion and should be treated as a lead to investigate.",
  },
  {
    category: "Evidence",
    term: "Finding",
    definition:
      "A specific condition detected by a named rule. Each finding states whether its basis is observed or estimated and links to supporting events when the imported data provides them.",
  },
  {
    category: "Evidence",
    term: "Supported finding types",
    definition:
      "The current session detectors cover a small explicit set of conditions. Absence of a finding means none of these supported rules matched; it is not a general quality verdict.",
    detail: [
      "Repeated identical tool failure",
      "Tool call timeout",
      "Missing dependency or command",
      "Permission rejection",
      "Large persisted tool result (estimated size threshold)",
    ],
  },

  // Discovery — the Subgroup view that explains outcomes.
  {
    category: "Discovery",
    term: "Subgroup",
    definition:
      "Sessions or tool calls that match the same set of conditions. Experimental subgroup analysis reports groups whose observed outcome rate differs from the comparison sample; it does not claim those conditions caused the outcome.",
  },
  {
    category: "Discovery",
    term: "Outcome",
    definition:
      "The measured result a subgroup is compared against, such as membership in the high estimated-cost band or an observed tool-error result.",
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
    term: "Significance gate (Wilson lower bound)",
    definition:
      "The \"stays at or above X%\" figure. Even on a pessimistic reading of a small sample, the subgroup's rate must still beat the baseline — and the bar rises with the number of conditions tested (a Bonferroni adjustment), so a long screen doesn't manufacture false positives. The gate is conservative: weak real effects can be hidden. Treat results as leads to investigate, not proof of cause.",
  },
  {
    category: "Discovery",
    term: "Observed hit-level percentile",
    definition:
      "Where a recorded limit hit's token volume or estimated API-equivalent cost falls within the reconstructed usage windows for the same plan era. For example, p50 is the median observed hit level. The windows are inferred; the percentile does not measure unused plan capacity.",
  },
  {
    category: "Discovery",
    term: "Context tax",
    definition:
      "The recurring cost of re-sending content that is already in the context: every token kept in the context is re-paid (at the cache-read rate) on every subsequent API call until compaction or session end.",
    detail: ["tax(contributor) = est_tokens × Σ cache_read_price(model_t) for each later call t in its epoch"],
  },
  {
    category: "Discovery",
    term: "Ballast",
    definition:
      "Content that entered the context and keeps being carried (and paid for) on every turn — large tool results, pasted logs, repeated file reads.",
  },
  {
    category: "Discovery",
    term: "Epoch",
    definition:
      "A stretch of a session between compactions. Contributor lifetimes never cross epoch boundaries: compaction drops the carried content.",
    detail: ["A new epoch starts when a call's context drops below 60% of the previous call's."],
  },
  {
    category: "Discovery",
    term: "Estimated context opportunity",
    definition:
      "The modeled carry-cost reduction from repeated same-range reads and unusually large tool results under each finding's stated counterfactual. It is an estimate, not proven waste.",
  },
  {
    category: "Discovery",
    term: "Calibration",
    definition:
      "Contributor sizes are estimated from stored content (~4 chars/token) and then scaled so they sum exactly to the observed context growth of that turn. Growth that nothing explains is shown as 'unattributed' and never counted as an opportunity.",
  },

  // Cost — token usage and spend.
  {
    category: "Cost",
    term: "Token",
    definition:
      "The unit models read and write text in, roughly a few characters each. Recorded token counts are observed usage and provide the input to API-equivalent cost estimates.",
  },
  {
    category: "Cost",
    term: "Estimated API-equivalent cost",
    definition:
      "A dollar estimate computed from recorded token counts and the configured model price table. It is an API-equivalent comparison, not an invoice. Historical mode uses the price in effect on each session date; incomplete model coverage is shown as partial or unavailable.",
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
    term: "Estimated API-equivalent cache savings / penalty",
    definition:
      "Estimated API-equivalent difference between observed cache pricing and paying the corresponding input at the uncached rate: savings when cache reads outweigh write surcharges, otherwise a penalty.",
  },
  {
    category: "Cost",
    term: "Spend spike",
    definition:
      "A complete day or week whose estimated cost rose enough above recent typical spend to qualify for investigation. The Cost chart labels the largest daily or weekly increase with its date, dollar increase, total, baseline, and comparison window.",
    detail: [
      "Baseline: median of the usable complete periods among the preceding 7 days or weeks; at least 3 are required.",
      "Qualification: at least 2 fully priced sessions, an increase of at least $5, and at least 50% above a positive baseline. A zero baseline can qualify without a percentage.",
      "History before the visible range can inform the baseline without adding to the displayed totals. Incomplete periods and unpriced periods do not contribute to the baseline; periods before imported history begins do not create invented zero-spend history.",
      "Spike comparisons require complete pricing for the selected range. Percentages are omitted for zero or very small baselines.",
    ],
  },
];
