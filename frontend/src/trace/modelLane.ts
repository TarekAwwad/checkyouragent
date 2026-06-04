import { MODEL_PALETTE } from "../analytics/chartGeometry";

export interface ModelInput {
  anchorCoord: number;
  model: string | null;
}

/** Distinct non-null models in first-appearance (ascending coordinate) order. */
export function distinctModels(spans: ModelInput[]): string[] {
  const ordered = spans
    .filter((span): span is ModelInput & { model: string } => Boolean(span.model))
    .slice()
    .sort((a, b) => a.anchorCoord - b.anchorCoord);
  const seen: string[] = [];
  for (const span of ordered) {
    if (!seen.includes(span.model)) seen.push(span.model);
  }
  return seen;
}

/** Display label: drop the `claude-` prefix and any trailing date. */
export function shortModelName(model: string): string {
  const stripped = model.startsWith("claude-") ? model.slice("claude-".length) : model;
  return stripped.replace(/-\d{8,}$/, "");
}

/** Stable categorical color by the model's position in `ordered` (wraps). */
export function modelColor(model: string, ordered: string[]): string {
  const index = ordered.indexOf(model);
  const slot = index < 0 ? 0 : index % MODEL_PALETTE.length;
  return MODEL_PALETTE[slot];
}
