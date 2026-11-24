// Client-side exports: no backend involvement, nothing leaves the machine.
import type { UsageMapResponse } from "../../api/types";

function download(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
}

export function exportJson(payload: UsageMapResponse): void {
  const blob = new Blob(
    [JSON.stringify(buildActivityMapExport(payload), null, 2)],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  download(url, "activity-map.json");
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Activity-only export contract; raw corpus cost is deliberately excluded. */
export function buildActivityMapExport(payload: UsageMapResponse) {
  return {
    export_kind: "observed_activity_map" as const,
    methodology: payload.meta.methodology,
    activity_basis: payload.meta.activity_basis,
    window: payload.meta.window,
    sessions_analyzed: payload.meta.sessions_analyzed,
    total_activity_count: payload.meta.total_activity_count,
    tool_call_count: payload.meta.tool_call_count,
    text_assistant_step_count: payload.meta.text_assistant_step_count,
    phases: payload.phases.map((phase) => ({
      key: phase.key,
      label: phase.label,
      activity_count: phase.activity_count,
      activity_share: phase.activity_share,
      main_activity_count: phase.main_activity_count,
      subagent_activity_count: phase.subagent_activity_count,
      text_assistant_step_count: phase.text_assistant_step_count,
      session_count: phase.session_count,
      patterns: phase.habits.map((pattern) => ({
        key: pattern.key,
        label: pattern.label,
        activity_count: pattern.activity_count,
        session_count: pattern.session_count,
      })),
      tools: phase.tools.map((tool) => ({
        key: tool.key,
        label: tool.label,
        activity_count: tool.activity_count,
        session_count: tool.session_count,
      })),
    })),
  };
}

// Visual styling lives in the app stylesheet; a serialized SVG carries none of
// it. Copy the computed values onto the clone so the raster matches the screen
// (this also resolves CSS custom properties like var(--muted)).
const STYLE_PROPS = [
  "fill", "stroke", "stroke-width", "stroke-linecap", "opacity",
  "font-size", "font-weight", "font-family", "text-anchor",
] as const;

function inlineComputedStyles(source: SVGSVGElement, clone: SVGSVGElement): void {
  const sourceEls = source.querySelectorAll<SVGElement>("*");
  const cloneEls = clone.querySelectorAll<SVGElement>("*");
  sourceEls.forEach((el, i) => {
    const computed = window.getComputedStyle(el);
    const target = cloneEls[i];
    if (!target) return;
    for (const prop of STYLE_PROPS) {
      const value = computed.getPropertyValue(prop);
      if (value) target.style.setProperty(prop, value);
    }
  });
}

/** Rasterize the live SVG at 2x for crisp sharing. */
export function exportPng(svg: SVGSVGElement, width: number, height: number): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(svg, clone);
  const xml = new XMLSerializer().serializeToString(clone);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Match the stage background (--surface) so labels stay readable in either theme.
    const theme = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    ctx.fillStyle = theme || "#0b0f17";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    download(canvas.toDataURL("image/png"), "activity-map.png");
  };
  image.src = svgUrl;
}
