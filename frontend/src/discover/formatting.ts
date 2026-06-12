/** Shared display formatting for discover techniques. */
export function formatUsd(value: number): string {
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tok`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k tok`;
  return `${value} tok`;
}
