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
    bundle: { schema_version: 1, sessions: [{ sid: "abc", models: ["claude-opus-4-8"] }] },
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

  it("renders the manifest counts and excluded-content statement", async () => {
    renderPage();
    expect(await screen.findByText(/2 sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/Prompts and your messages/i)).toBeInTheDocument();
    expect(screen.getByText(/File contents/i)).toBeInTheDocument();
    expect(screen.getByText(/structural fingerprint/i)).toBeInTheDocument();
  });

  it("exports when the button is clicked", async () => {
    renderPage();
    await screen.findByText(/2 sessions/i);
    fireEvent.click(screen.getByRole("button", { name: /export/i }));
    await waitFor(() => expect(exportContribution).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/contribution-x\.json/)).toBeInTheDocument();
  });
});
