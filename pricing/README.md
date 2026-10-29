# Dated pricing

Keep `../pricing.csv` as the complete, up-to-date price list. When rates change,
preserve the previous rates in dated history, add a `pricing-YYYY-MM-DD.csv`
with the newly effective rates, and update `../pricing.csv` to match. Use the
effective date rather than the day the file was edited. Existing snapshots
should not be rewritten when prices change.

Snapshots can contain just the changed rows: historical mode overlays them
oldest first through each event's date. Models without a historical row fall
back to the current CSV; the history is not a complete model-release inventory.

Historical mode uses the rates on each event's date; current mode uses all
snapshots. The latest snapshot rates and the current CSV must agree. These files
ship in the wheel beside the current table. Installed users
can additionally put snapshots in `~/.checkyouragent/pricing` (or
`CCFR_PRICING_DIR`); a local row wins over a bundled row on the same date.

Verified on 29 October 2026 against [Anthropic's pricing](https://platform.claude.com/docs/en/about-claude/pricing)
and [release notes](https://platform.claude.com/docs/en/release-notes/overview):

| Snapshot | Basis |
| --- | --- |
| 2026-06-30 | Sonnet 5 launched at $2 input / $10 output per million tokens. On 10 August Anthropic cancelled the planned 1 September increase to $3/$15; that increase never took effect. |
| 2026-09-01 | Fable 5.1 and Mythos 5.1 launched at $10/$50, with $0.25 cache reads. |
| 2026-09-22 | Opus 5.5 launched at $4/$20, with $0.20 cache reads. |
| 2026-09-28 | Sonnet 5.5 launched at $2/$10, with $0.20 cache reads. |
| 2026-10-07 | Sonnet 5.5 cache reads dropped to $0.10. Haiku 5.5 launched. |
| 2026-10-29 | Added missing legacy Haiku 3.5 rates from the current pricing page. This is the verification date, not a claimed price-change date; earlier usage falls back to the current table. |

Rates are USD per million tokens for standard global API usage. Fast mode,
regional premiums, and batch discounts are not applied. Haiku 5.5 rows cover
prompts up to 100,000 input tokens (including cache reads and writes); the
higher tier for longer prompts is not implemented.
