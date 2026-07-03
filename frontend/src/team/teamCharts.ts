// Minimal hand-rolled area-chart geometry for the team activity strip. Kept
// separate from the cost chartGeometry (which is spend/model-specific) and
// deliberately dependency-free, matching the app's no-charting-library rule.

export interface AreaPoint {
  label: string;
  value: number;
}

export interface AreaChartPoint {
  x: number;
  y: number;
  label: string;
  value: number;
}

export interface AreaChart {
  areaPath: string;
  linePath: string;
  points: AreaChartPoint[];
  yMax: number;
}

function coord(n: number): string {
  return String(Number(n.toFixed(2)));
}

export function buildAreaChart(data: AreaPoint[], width: number, height: number): AreaChart {
  if (data.length === 0) {
    return { areaPath: "", linePath: "", points: [], yMax: 0 };
  }

  const yMax = data.reduce((max, point) => Math.max(max, point.value), 0);
  const denom = yMax > 0 ? yMax : 1;
  const lastIndex = data.length - 1;

  const points: AreaChartPoint[] = data.map((point, index) => ({
    x: lastIndex === 0 ? 0 : (index / lastIndex) * width,
    y: height - (point.value / denom) * height,
    label: point.label,
    value: point.value,
  }));

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${coord(point.x)},${coord(point.y)}`)
    .join(" ");

  const first = points[0];
  const last = points[lastIndex];
  const areaPath =
    lastIndex === 0
      ? `${linePath} L${coord(first.x)},${coord(height)} Z`
      : `${linePath} L${coord(last.x)},${coord(height)} L${coord(first.x)},${coord(height)} Z`;

  return { areaPath, linePath, points, yMax };
}
