export type TokenMetric = "input" | "output" | "total";

export function metricValue(
  span: { input_tokens: number; output_tokens: number },
  metric: TokenMetric,
): number {
  if (metric === "input") return span.input_tokens;
  if (metric === "output") return span.output_tokens;
  return span.input_tokens + span.output_tokens;
}
