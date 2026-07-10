# Check Your Agent

Local, privacy-strict forensics for Claude Code spend. Claude Code writes a
complete record of every session to `~/.claude/projects`. Check Your Agent
turns that record into answers: how much each session cost, how much of that
cost was context waste (re-read files, oversized tool results, late
compaction), and which sessions went off the rails. It runs entirely
locally — no accounts, no telemetry, no uploads — and never modifies the
original logs. Tools like ccusage tell you *what* you spent; Check Your Agent
tells you *why*, and what to change.

## Run

```bash
uvx checkyouragent
```

(or `pipx run checkyouragent`). This serves the app on port 8000, opens your
browser, and defaults the import root to `~/.claude/projects`. `cya` is an
identical, shorter alias.

Flags:

- `--import-root` — export root to scan (default: `~/.claude/projects`).
- `--port` — bind port (default: 8000).
- `--no-browser` — do not open a browser.
- `--demo` — use the bundled synthetic demo dataset instead of a real export.

## What It Shows

- **Overview** — a triage board that ranks sessions by risk, findings,
  errors, loops, subagent fanout, and estimated cost.
- **Session workspace** — timeline, trace, subagent, findings, and raw event
  inspection for a single session.
- **Cost analytics** — spend by project, model, and token category, with
  historical or current pricing.
- **Context Economics** — avoidable vs. necessary spend, so you can see what
  drove your token footprint.
- **Usage mindmap** — a visual map of usage patterns across your exports.
- **Team bundles** — export content-free aggregates for team Overview and
  Cost views.
- **Privacy mode** — blurs sensitive UI text for safe screenshots.

## Links

- Website: <https://checkyouragent.dev>
- Source and full README: <https://github.com/TarekAwwad/checkyouragent>
- Changelog: <https://github.com/TarekAwwad/checkyouragent/blob/main/CHANGELOG.md>

## License

Business Source License 1.1, with an Additional Use Grant: free for personal
use and internal use (including commercial-internal use) by you or your
organization. See the `LICENSE` file for the full text.
