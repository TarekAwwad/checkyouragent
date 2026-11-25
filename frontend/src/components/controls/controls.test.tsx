import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_TIME, presetRange, resolveRange, type DateRange } from "../../shell/dateRange";
import DateRangeControl, { DATE_INPUT_DEBOUNCE_MS } from "./DateRangeControl";
import ProjectSelect from "./ProjectSelect";
import SegmentedControl from "./SegmentedControl";
import ToggleChip from "./ToggleChip";
import ExportMenu from "./ExportMenu";
import FixedChip from "./FixedChip";

afterEach(() => vi.useRealTimers());

function RangeHarness({ initial = ALL_TIME, onChange }: { initial?: DateRange; onChange?: (r: DateRange) => void }) {
  const [range, setRange] = React.useState(initial);
  return (
    <DateRangeControl
      range={range}
      resolved={resolveRange(range, "2026-11-24")}
      onChange={(next) => { setRange(next); onChange?.(next); }}
    />
  );
}

describe("DateRangeControl", () => {
  it("offers the presets and shows date inputs only for Custom", () => {
    const onChange = vi.fn();
    render(<RangeHarness onChange={onChange} />);
    const select = screen.getByLabelText("Date range");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(
      ["Today", "Last 7 days", "Last 30 days", "Last 90 days", "All time", "Custom range"]);
    expect(select).toHaveValue("all");
    expect(screen.queryByLabelText("Start date")).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: "7d" } });
    expect(onChange).toHaveBeenLastCalledWith(presetRange("7d"));
  });

  it("starts Custom from the window on screen", () => {
    const onChange = vi.fn();
    render(<RangeHarness initial={presetRange("7d")} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Date range"), { target: { value: "custom" } });
    expect(onChange).toHaveBeenLastCalledWith({ preset: "custom", from: "2026-11-18", to: "2026-11-24" });
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-11-18");
    expect(screen.getByLabelText("End date")).toHaveValue("2026-11-24");
  });

  it("commits date edits once typing pauses", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<RangeHarness initial={{ preset: "custom", from: "2026-06-01", to: "2026-06-10" }} onChange={onChange} />);
    const start = screen.getByLabelText("Start date");
    for (const day of ["02", "03", "04"]) {
      fireEvent.change(start, { target: { value: `2026-06-${day}` } });
      expect(start).toHaveValue(`2026-06-${day}`);
      act(() => { vi.advanceTimersByTime(DATE_INPUT_DEBOUNCE_MS - 100); });
    }
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(100); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ preset: "custom", from: "2026-06-04", to: "2026-06-10" });
  });

  it("commits a pending edit when it unmounts", () => {
    const onChange = vi.fn();
    const view = render(
      <DateRangeControl range={{ preset: "custom", from: "2026-06-01", to: "2026-06-10" }}
                        resolved={{ from: "2026-06-01", to: "2026-06-10" }} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-06-05" } });
    view.unmount();
    expect(onChange).toHaveBeenCalledWith({ preset: "custom", from: "2026-06-05", to: "2026-06-10" });
  });
});

describe("ProjectSelect", () => {
  const options = [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }];

  it("lists all projects first and reports the selected id", () => {
    const onChange = vi.fn();
    render(<ProjectSelect value={null} options={options} onChange={onChange} />);
    const select = screen.getByLabelText("Project");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["All projects", "alpha", "beta"]);
    fireEvent.change(select, { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith(2);
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("marks a selected project without activity once activity is known", () => {
    const { rerender } = render(<ProjectSelect value={2} options={options} onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "beta" })).toBeInTheDocument();
    rerender(<ProjectSelect value={2} options={options} activeIds={[1]} onChange={vi.fn()} />);
    expect(screen.getByRole("option", { name: "beta (no activity in range)" })).toBeInTheDocument();
  });

  it("keeps a selection's name after it leaves a range-dependent list", () => {
    const { rerender } = render(<ProjectSelect value={2} options={options} activeIds={[1, 2]} onChange={vi.fn()} />);
    rerender(<ProjectSelect value={2} options={[options[0]]} activeIds={[1]} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Project")).toHaveValue("2");
    expect(screen.getByRole("option", { name: "beta (no activity in range)" })).toBeInTheDocument();
  });
});

describe("SegmentedControl", () => {
  const options = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta", disabled: true }];

  it("marks the pressed button", () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Pick" options={options} value="a" onChange={onChange} />);
    expect(screen.getByRole("group", { name: "Pick" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Beta" })).toBeDisabled();
  });

  it("renders radios", () => {
    render(<SegmentedControl variant="radio" label="Pick" options={options} value="a" onChange={vi.fn()} />);
    expect(screen.getByRole("radiogroup", { name: "Pick" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Alpha" })).toHaveAttribute("aria-checked", "true");
  });

  it("renders tabs that control a panel", () => {
    const onChange = vi.fn();
    render(<SegmentedControl variant="tabs" label="Pick" idPrefix="t" controls="panel"
                             options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]}
                             value="a" onChange={onChange} />);
    const tab = screen.getByRole("tab", { name: "Beta" });
    expect(tab).toHaveAttribute("id", "t-b");
    expect(tab).toHaveAttribute("aria-controls", "panel");
    expect(tab).toHaveAttribute("aria-selected", "false");
    fireEvent.click(tab);
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("ToggleChip, ExportMenu, FixedChip", () => {
  it("toggles a labelled checkbox", () => {
    const onChange = vi.fn();
    render(<ToggleChip label="vs previous period" ariaLabel="Compare with previous period" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Compare with previous period"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("opens a menu of export actions and closes after one runs", () => {
    const onJson = vi.fn();
    render(<ExportMenu items={[{ label: "Export JSON", onSelect: onJson }, { label: "Export PNG", onSelect: vi.fn() }]} />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export JSON" }));
    expect(onJson).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes the export menu on Escape", () => {
    render(<ExportMenu items={[{ label: "Export JSON", onSelect: vi.fn() }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows a fixed scope value", () => {
    render(<FixedChip label="All projects" />);
    expect(screen.getByText("All projects")).toBeInTheDocument();
  });
});
