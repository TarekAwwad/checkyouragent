# Check Your Agent

Local, evidence-backed forensics for Claude Code sessions. Claude Code writes a
detailed record of every session to `~/.claude/projects`. Check Your Agent
turns that record into estimated API-equivalent cost, observed activity, and
supported findings linked to evidence receipts. It runs entirely locally — no
accounts, no telemetry, no uploads — and never modifies the original logs.
Tools like ccusage tell you *what* you used; Check Your Agent helps you
investigate *why* a session was expensive or unusual.

API-equivalent costs are estimates from recorded token counts and bundled
pricing tables, not invoice amounts. Findings and experimental associations
are leads to investigate, not causal conclusions.

## Run

```bash
uvx checkyouragent
```

(or `pipx run checkyouragent`). This serves the app on port 8000, opens your
browser, and uses `~/.claude/projects` as the import root when it exists,
otherwise `./Data`. `cya` is an identical, shorter alias.

Flags:

- `--import-root` — export root to scan (default: `~/.claude/projects` when
  present, otherwise `./Data`).
- `--port` — bind port (default: 8000).
- `--no-browser` — do not open a browser.
- `--demo` — use the bundled synthetic demo dataset instead of a real export.

On first use, **Sources & sync** offers **Sync new and updated**, followed by
**View costs**. Cost initially shows **All time** so older imported history is
included. Returning visits restore the last analytical page for the active data
scope, defaulting to Cost.

The main local pages are **Cost**, **Sessions**, and **Explore**. **Sources &
sync** and **Share team bundle** sit in the lower **Data** group. Team scope has
**Cost** and **Overview**, plus **Manage bundles** under Data. Returning from a
session preserves the Cost filters or Sessions search, filters, and sorting for
the current workspace visit.

## What It Shows

- **Sessions** — an investigation board with supported findings, observed
  errors, subagent fanout, event volume, duration, estimated API-equivalent
  cost, search, filters, and sorting.
- **Session workspace** — timeline, trace, subagent, findings, and raw event
  inspection for a single session, with receipt links from each supported
  finding back to the recorded events.
- **Cost** — estimated API-equivalent cost by project, model, and token
  category; cost over time, spike detection, turn distribution, and session
  outliers, with optional date-aware historical pricing. Spend increases show
  their baseline and comparison window; model legends wrap and the model list
  scrolls within its panel.
- **Limit hits** — recorded limit notices and reconstructed five-hour windows,
  viewed by recorded token volume or estimated API-equivalent cost.
- **Context Economics** — explicitly defined opportunity signals with receipts
  and session drilldown; estimated and unattributed values remain distinct.
- **Usage drivers** — overlapping, cost- or token-weighted characteristics such
  as subagent activity, large input contexts, and long-running sessions. These
  shares are independent characteristics, not a breakdown.
- **Experimental analysis** — an observed-activity Usage Mindmap and subgroup
  associations with declared samples, uncertainty, and receipts. Neither view
  claims causal attribution.
- **Team bundles** — export allowlisted aggregates designed to omit raw
  conversation content at structural or team privacy levels for team Overview
  and Cost views. New exports use schema v3; sanitized v1 and v2 imports remain
  supported.
- **Privacy mode** — reduces visible sensitive text; screenshots still require
  review before sharing.

## Links

- Website: <https://checkyouragent.dev>
- Source and full README: <https://github.com/TarekAwwad/checkyouragent>
- Changelog: <https://github.com/TarekAwwad/checkyouragent/blob/main/CHANGELOG.md>

## License

Business Source License 1.1, with an Additional Use Grant: free for personal
use and internal use (including commercial-internal use) by you or your
organization. See the `LICENSE` file for the full text.
