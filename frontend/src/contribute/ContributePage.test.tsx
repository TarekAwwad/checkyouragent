import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ContributePage from "./ContributePage";

vi.mock("../api/client", () => ({
  getContributionPreview: vi.fn(async () => ({
    manifest: {
      session_count: 2,
      sequence_step_count: 7,
      included_fields: ["Token counts + cache breakdown"],
      excluded: ["Prompts and your messages", "File contents"],
      fingerprint_caveat: "This bundle is a structural fingerprint.",
    },
    bundle: {
      schema_version: 1,
      sessions: [
        {
          sid: "abc",
          models: ["claude-opus-4-8"],
          first_date: "2026-06-20",
          duration_s: 300,
          tokens: { input: 1200, output: 3400, base: 0, cache_5m: 0, cache_1h: 0, cache_read: 50000 },
          stats: { turns: 8, tool_calls: 14, subagents: 1, errors: 0, system: 2, loops: 0, max_repeat: 1, persisted_outputs: 0 },
          stop_reasons: { end_turn: 5, tool_use: 9 },
          risk_categories: ["loop"],
          subagents: [{ agent_type: "general-purpose", event_count: 12 }],
          sequence: [
            { sym: "CALL:inspect:Read", fam: "tool_call", dt_s: 0 },
            { sym: "RESULT:ok", fam: "tool_result", dt_s: 1 },
            { sym: "CALL:write:Edit", fam: "tool_call", dt_s: 2, out_tok: 40 },
            { sym: "CALL:Bash:git", fam: "tool_call", dt_s: 1 },
            { sym: "RESULT:error:permission_denied", fam: "tool_result", dt_s: 0 },
          ],
        },
      ],
    },
  })),
  exportContribution: vi.fn(async () => ({ path: "/data/contributions/contribution-x.json", session_count: 2 })),
}));

import { exportContribution } from "../api/client";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ContributePage />
    </QueryClientProvider>,
  );
}

describe("ContributePage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the manifest counts and the kept-vs-never ledger", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /contribute usage structure/i });
    // Counts surface as preview metrics.
    expect(screen.getByText("Sessions").closest(".contribute-metric")).toHaveTextContent("2");
    expect(screen.getByText("Sequence steps").closest(".contribute-metric")).toHaveTextContent("7");
    // Kept-vs-never ledger + honest caveat.
    expect(screen.getByText(/Prompts and your messages/i)).toBeInTheDocument();
    expect(screen.getByText(/File contents/i)).toBeInTheDocument();
    expect(screen.getByText(/structural fingerprint/i).closest(".privacy-note")).toHaveClass("privacy-warning");
  });

  it("opens the specimen modal, shows it annotated, then toggles to raw JSON and back", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /contribute usage structure/i });
    // The specimen lives behind a quiet trigger in the privacy ledger.
    fireEvent.click(screen.getByRole("button", { name: /inspect specimen/i }));
    // Annotated: friendly model name and a faithful sequence chip.
    expect(screen.getByText("Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    // Raw: the literal salted sid is shown verbatim.
    fireEvent.click(screen.getByRole("button", { name: /raw json/i }));
    expect(screen.getByText(/"sid": "abc"/)).toBeInTheDocument();
    // Back to annotated.
    fireEvent.click(screen.getByRole("button", { name: /annotated/i }));
    expect(screen.getByText("Opus 4.8")).toBeInTheDocument();
  });

  it("exports when the button is clicked", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /contribute usage structure/i });
    fireEvent.click(screen.getByRole("button", { name: /export bundle/i }));
    await waitFor(() => expect(exportContribution).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/contribution-x\.json/)).toBeInTheDocument();
  });
});
