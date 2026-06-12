// Client-side exports: no backend involvement, nothing leaves the machine.
import type { UsageMapResponse } from "../../api/types";

function download(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
}

export function exportJson(payload: UsageMapResponse): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  download(url, "usage-map.json");
  setTimeout(() => URL.revokeObjectURL(url), 0);
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
    download(canvas.toDataURL("image/png"), "usage-map.png");
  };
  image.src = svgUrl;
}
