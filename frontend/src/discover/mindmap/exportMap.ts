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
  URL.revokeObjectURL(url);
}

/** Rasterize the live SVG at 2x for crisp sharing. */
export function exportPng(svg: SVGSVGElement, width: number, height: number): void {
  const xml = new XMLSerializer().serializeToString(svg);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Dark theme background (--bg in styles.css) so light SVG labels remain readable.
    ctx.fillStyle = "#0b0f17";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    download(canvas.toDataURL("image/png"), "usage-map.png");
  };
  image.src = svgUrl;
}
