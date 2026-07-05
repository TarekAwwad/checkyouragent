import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import TaxMeterHero from "./TaxMeterHero";
import type { ContextArchetype, ContextEconomicsMeta } from "../../api/types";

const archetypes: ContextArchetype[] = [
  {
    key: "oversized", title: "Oversized tool results", description: "", recommendation: "",
    meets_support: true, findings_count: 3, savings_usd: 12, savings_tokens: 1_000_000,
    thresholds: [], exemplar: null, findings: [],
  },
];

function meta(overrides: Partial<ContextEconomicsMeta> = {}): ContextEconomicsMeta {
  return {
    project_id: null, min_support: 3, total_usd: 100, necessary_usd: 88, avoidable_usd: 12,
    unattributed_tokens: 0, cost_available: true, sessions_analyzed: 10, sessions_skipped: 0,
    trend: [], total_tokens: 4_000_000, avoidable_tokens: 1_000_000, avoidable_token_share: 0.25,
    ...overrides,
  };
}

describe("TaxMeterHero dual currency", () => {
  it("shows a token equivalent and usage share beneath the dollar headline when priced", () => {
    render(<TaxMeterHero meta={meta()} archetypes={archetypes} />);
    // dollar primary is unchanged (also appears in the legend, hence getAllByText)
    expect(screen.getAllByText(/\$12\.00/).length).toBeGreaterThan(0);
    // secondary line pairs absolute tokens with the honest "of your usage" share
    expect(screen.getByText(/1\.0M tok · 25% of your usage/)).toBeInTheDocument();
    // never the forbidden rate-limit framing
    expect(screen.queryByText(/of your limit/i)).not.toBeInTheDocument();
  });

  it("uses the same token numbers as the primary when pricing is unavailable", () => {
    render(<TaxMeterHero meta={meta({ cost_available: false })} archetypes={archetypes} />);
    expect(screen.getByText("Avoidable context")).toBeInTheDocument();
    expect(screen.getAllByText(/1\.0M tok/).length).toBeGreaterThan(0);
    expect(screen.getByText(/25% of your usage/)).toBeInTheDocument();
  });
});
