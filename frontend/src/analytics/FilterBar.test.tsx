import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CostAnalyticsFilters, CostAnalyticsMeta } from "../api/types";
import type { DataScope } from "../shell/useDataScope";
import FilterBar from "./FilterBar";

const meta: CostAnalyticsMeta = {
  available: true,
  unpriced_models: [],
  costs_partial: false,
  costs_are_lower_bound: false,
  total_usd: 48,
  total_tokens: 1_000,
  available_projects: [{ id: 1, name: "alpha" }],
  available_models: ["claude-opus-4-8"],
  bucket: "day",
};
const emptyMeta: CostAnalyticsMeta = {
  ...meta,
  total_usd: 0,
  total_tokens: 0,
  available_projects: [],
  available_models: [],
};
const selectedFilters: CostAnalyticsFilters = { projectId: 1, model: "claude-opus-4-8" };

function bar(overrides: Partial<React.ComponentProps<typeof FilterBar>> = {}) {
  return (
    <FilterBar
      filters={selectedFilters}
      meta={meta}
      historical
      onChange={() => {}}
      onHistoricalChange={() => {}}
      {...overrides}
    />
  );
}

describe("FilterBar", () => {
  it("keeps zero-activity filters visible after a date change and lets users clear them", () => {
    const changed = vi.fn();
    function Harness({ response }: { response: CostAnalyticsMeta }) {
      const [filters, setFilters] = React.useState(selectedFilters);
      return bar({
        filters,
        meta: response,
        onChange: (next) => { changed(next); setFilters(next); },
      });
    }
    const view = render(<Harness response={meta} />);

    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "7" } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining(selectedFilters));
    view.rerender(<Harness response={emptyMeta} />);

    const project = screen.getByLabelText("Project");
    const model = screen.getByLabelText("Model");
    expect(project).toHaveValue("1");
    expect(model).toHaveValue("claude-opus-4-8");
    expect(within(project).getByRole("option", { selected: true })).toHaveTextContent("alpha (no activity in range)");
    expect(within(model).getByRole("option", { selected: true })).toHaveTextContent("opus-4-8 (no activity in range)");
    expect(within(project).getByRole("option", { selected: true })).toBeEnabled();
    expect(within(model).getByRole("option", { selected: true })).toBeEnabled();

    fireEvent.change(project, { target: { value: "" } });
    expect(project).toHaveValue("");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: null, model: "claude-opus-4-8" }));
    fireEvent.change(model, { target: { value: "" } });
    expect(model).toHaveValue("");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: null, model: null }));
    expect(screen.queryByRole("option", { name: /no activity in range/ })).not.toBeInTheDocument();
  });

  it("keeps known selection labels while metadata loads without claiming zero activity", () => {
    const view = render(bar());
    view.rerender(bar({ meta: undefined }));

    expect(screen.getByLabelText("Project")).toHaveValue("1");
    expect(screen.getByRole("option", { name: "alpha" })).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("claude-opus-4-8");
    expect(screen.getByRole("option", { name: "opus-4-8" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /no activity in range/ })).not.toBeInTheDocument();

    view.rerender(bar({ meta: emptyMeta }));
    expect(screen.getByRole("option", { name: "alpha (no activity in range)" })).toBeInTheDocument();
  });

  it("uses a truthful project fallback when restored state has no known label", () => {
    render(bar({ filters: { projectId: 42, model: "claude-sonnet-4-6" }, meta: emptyMeta }));

    expect(screen.getByLabelText("Project")).toHaveValue("42");
    expect(screen.getByRole("option", { name: "Project 42 (no activity in range)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toHaveValue("claude-sonnet-4-6");
    expect(screen.getByRole("option", { name: "sonnet-4-6 (no activity in range)" })).toBeInTheDocument();
  });

  it("replaces an absent option when activity returns and remembers its updated project name", () => {
    const view = render(bar());
    view.rerender(bar({ meta: emptyMeta }));
    view.rerender(bar({ meta: { ...meta, available_projects: [{ id: 1, name: "renamed alpha" }] } }));

    expect(within(screen.getByLabelText("Project")).getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option", { name: "renamed alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /no activity in range/ })).not.toBeInTheDocument();

    view.rerender(bar({ meta: emptyMeta }));
    expect(screen.getByRole("option", { name: "renamed alpha (no activity in range)" })).toBeInTheDocument();
  });

  it("does not reuse project names between local and team identifiers", () => {
    const view = render(bar({ scope: "local" }));
    view.rerender(bar({ scope: "team", meta: emptyMeta }));
    expect(screen.getByRole("option", { name: "Project 1 (no activity in range)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /alpha/ })).not.toBeInTheDocument();

    view.rerender(bar({ scope: "team", meta: { ...meta, available_projects: [{ id: 1, name: "team project" }] } }));
    view.rerender(bar({ scope: "team", meta: emptyMeta }));
    expect(screen.getByRole("option", { name: "team project (no activity in range)" })).toBeInTheDocument();

    view.rerender(bar({ scope: "local" as DataScope, meta: emptyMeta }));
    expect(screen.getByRole("option", { name: "Project 1 (no activity in range)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /team project/ })).not.toBeInTheDocument();
  });

  it("keeps controlled presets and custom date edits in sync with the page state", () => {
    const changed = vi.fn();
    const rangeChanged = vi.fn();
    const view = render(bar({ rangeKey: "30", onRangeKeyChange: rangeChanged, onChange: changed }));
    expect(screen.getByLabelText("Date range")).toHaveValue("30");

    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "90" } });
    expect(rangeChanged).toHaveBeenLastCalledWith("90");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ ...selectedFilters, dateFrom: expect.any(String), dateTo: null }));

    view.rerender(bar({ rangeKey: "90", onRangeKeyChange: rangeChanged, onChange: changed }));
    expect(screen.getByLabelText("Date range")).toHaveValue("90");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-05-01" } });
    expect(rangeChanged).toHaveBeenLastCalledWith("custom");
    expect(changed).toHaveBeenLastCalledWith({ ...selectedFilters, dateFrom: "2026-05-01T00:00:00.000Z" });

    view.rerender(bar({ rangeKey: "custom", onRangeKeyChange: rangeChanged, onChange: changed }));
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-05-31" } });
    expect(rangeChanged).toHaveBeenLastCalledWith("custom");
    expect(changed).toHaveBeenLastCalledWith({ ...selectedFilters, dateTo: "2026-05-31T23:59:59.999Z" });
  });

  it("keeps historical pricing independent of the active filter options", () => {
    const historicalChanged = vi.fn();
    render(bar({ meta: emptyMeta, onHistoricalChange: historicalChanged }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Historical pricing" }));
    expect(historicalChanged).toHaveBeenCalledWith(false);
  });
});
