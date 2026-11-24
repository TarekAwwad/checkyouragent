import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UsageCharacteristicsResponse } from "../../api/types";
import { getUsageCharacteristics } from "../../api/client";
import UsageDrivers from "./UsageDrivers";
import { formatShare } from "./driverData";
import { TestScopeProvider } from "../../shell/TestScopeProvider";
import { instantBounds, presetRange, type DateRange } from "../../shell/dateRange";
import { DATE_INPUT_DEBOUNCE_MS } from "../../components/controls/DateRangeControl";

vi.mock("../../api/client", () => ({ getUsageCharacteristics: vi.fn() }));

const fetchDrivers = vi.mocked(getUsageCharacteristics);

function payload(
  meta: Partial<UsageCharacteristicsResponse["meta"]> = {},
  characteristics: UsageCharacteristicsResponse["characteristics"] = [
    { key: "subagent_sessions", label: "Sessions with subagents", share: 0.76,
      cost_usd: 2929.4, tokens: 2_480_000_000, kind: "session" },
    { key: "duration_gte_8h", label: "Sessions active 8h+", share: 0.66,
      cost_usd: 2535, tokens: 2_100_000_000, kind: "session" },
    { key: "subagent_usage", label: "Subagent turns", share: 0.0006,
      cost_usd: 2.3, tokens: 1_200_000, kind: "subagent" },
  ],
): UsageCharacteristicsResponse {
  return {
    meta: {
      project_id: null, window: { date_from: null, date_to: null },
      total_usd: 3842.1, total_tokens: 3_270_000_000, cost_available: true,
      costs_partial: false, sessions_analyzed: 222, share_basis: "cost",
      ...meta,
    },
    characteristics,
  };
}

function renderPage(range: DateRange = presetRange("7d")) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TestScopeProvider projects={[{ id: 7, name: "alpha" }]} range={range} today="2026-11-24">
        <UsageDrivers />
      </TestScopeProvider>
    </QueryClientProvider>,
  );
}

function rowFor(label: string): HTMLElement {
  return screen.getByText(label).closest("[role='listitem']") as HTMLElement;
}

beforeEach(() => {
  fetchDrivers.mockReset();
  fetchDrivers.mockResolvedValue(payload());
});

describe("UsageDrivers", () => {
  it("renders each driver as label, share and cost in a Share of usage card", async () => {
    renderPage();
    const card = await screen.findByRole("region", { name: "Share of usage" });
    expect(within(card).getByRole("heading", { name: "Share of usage" })).toBeInTheDocument();
    expect(card.querySelector(".card-count")).toHaveTextContent("3 drivers");

    const subagents = rowFor("Sessions with subagents");
    expect(within(subagents).getByText("76%")).toBeInTheDocument();
    expect(within(subagents).getByText("$2,929.40")).toBeInTheDocument();
    // The track is 100% of usage, not scaled to the largest row.
    expect(subagents.querySelector(".cbm-track i")).toHaveStyle({ width: "76%" });

    // A sliver of usage reads "<1%", never a misleading "0%".
    const turns = rowFor("Subagent turns");
    expect(within(turns).getByText("<1%")).toBeInTheDocument();
    expect(within(turns).queryByText("0%")).not.toBeInTheDocument();
  });

  it("shows cost, sessions and tokens in the stat strip", async () => {
    renderPage();
    const strip = await screen.findByLabelText("Usage totals");
    expect(within(strip).getByText("Cost")).toBeInTheDocument();
    expect(within(strip).getByText("$3,842.10")).toBeInTheDocument();
    expect(within(strip).getByText("Sessions")).toBeInTheDocument();
    expect(within(strip).getByText("222")).toBeInTheDocument();
    expect(within(strip).getByText("Tokens")).toBeInTheDocument();
    expect(within(strip).getByText("3.3B")).toBeInTheDocument();
  });

  it("keeps the page to numbers and labels: no sentences, advice or footnotes", async () => {
    renderPage();
    await screen.findByText("Sessions with subagents");
    expect(screen.getByText("Share of cost, all projects.")).toBeInTheDocument();
    expect(screen.queryByText(/came from/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/weighted by/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not a breakdown/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector(".tile-note")).toBeNull();
  });

  it("names the selected project in the subtitle and refetches for it", async () => {
    renderPage();
    await screen.findByText("Sessions with subagents");
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "7" } });
    expect(await screen.findByText("Share of cost, alpha.")).toBeInTheDocument();
    await waitFor(() => expect(fetchDrivers).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 7 })));
  });

  it("switches to tokens when there is no price table", async () => {
    fetchDrivers.mockResolvedValue(payload({
      cost_available: false, share_basis: "tokens", total_usd: 0,
    }));
    renderPage();
    expect(await screen.findByText("No price table: tokens only.")).toBeInTheDocument();
    expect(screen.getByText("Share of tokens, all projects.")).toBeInTheDocument();
    expect(within(screen.getByLabelText("Usage totals")).getByText("—")).toBeInTheDocument();
    expect(within(rowFor("Sessions with subagents")).getByText("2.5B tok")).toBeInTheDocument();
    expect(within(rowFor("Subagent turns")).getByText("1.2M tok")).toBeInTheDocument();
    expect(screen.queryByText("$2,929.40")).not.toBeInTheDocument();
  });

  it("flags partial pricing with a tile note and keeps dollars", async () => {
    fetchDrivers.mockResolvedValue(payload({ costs_partial: true }));
    renderPage();
    expect(await screen.findByText("Some models are unpriced: costs are a lower bound."))
      .toBeInTheDocument();
    expect(within(rowFor("Sessions with subagents")).getByText("$2,929.40")).toBeInTheDocument();
  });

  it("shows the shared empty state for a window without usage", async () => {
    fetchDrivers.mockResolvedValue(payload(
      { sessions_analyzed: 0, total_usd: 0, total_tokens: 0 },
      [{ key: "subagent_usage", label: "Subagent turns", share: 0, cost_usd: 0,
         tokens: 0, kind: "subagent" }],
    ));
    renderPage();
    const empty = await screen.findByText("No usage in this window.");
    expect(empty).toHaveClass("empty-state");
    expect(screen.queryByText("Subagent turns")).not.toBeInTheDocument();
    expect(document.querySelector(".card-count")).toBeNull();
  });

  it("shows the shared error state when the request fails", async () => {
    fetchDrivers.mockRejectedValue(new Error("boom"));
    renderPage();
    expect(await screen.findByText("Failed to load")).toBeInTheDocument();
    expect(screen.getByText("Usage drivers could not be loaded.").parentElement)
      .toHaveClass("empty-state", "panel-error");
  });

  it("requests the shared range as local-day instants", async () => {
    renderPage(presetRange("today"));
    await screen.findByText("Sessions with subagents");
    expect(fetchDrivers).toHaveBeenLastCalledWith(
      { projectId: null, ...instantBounds({ from: "2026-11-24", to: "2026-11-24" }) });
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "all" } });
    await waitFor(() => expect(fetchDrivers).toHaveBeenLastCalledWith(
      { projectId: null, dateFrom: null, dateTo: null }));
  });

  it("keeps two custom ranges apart in the cache", async () => {
    renderPage({ preset: "custom", from: "2026-06-01", to: "2026-06-10" });
    await screen.findByText("Sessions with subagents");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-06-05" } });
    await waitFor(() => expect(fetchDrivers).toHaveBeenLastCalledWith(
      { projectId: null, ...instantBounds({ from: "2026-06-05", to: "2026-06-10" }) }));
    expect(fetchDrivers).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-06-01" } });
    await new Promise((resolve) => setTimeout(resolve, DATE_INPUT_DEBOUNCE_MS + 50));
    // The first range is still fresh in its own cache entry: no third request.
    expect(fetchDrivers).toHaveBeenCalledTimes(2);
  });
});

describe("formatShare", () => {
  it("rounds to whole percents without hiding slivers or near-totals", () => {
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.0006)).toBe("<1%");
    expect(formatShare(0.01)).toBe("1%");
    expect(formatShare(0.756)).toBe("76%");
    expect(formatShare(0.996)).toBe(">99%");
    expect(formatShare(1)).toBe("100%");
  });
});
