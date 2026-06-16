/** Categorical palette for multi-series charts. Tuned for the warm inky dark theme. */
export const palette = [
  "oklch(0.74 0.14 155)",
  "oklch(0.68 0.13 250)",
  "oklch(0.74 0.15 350)",
  "oklch(0.79 0.14 110)",
  "oklch(0.67 0.16 25)",
  "oklch(0.72 0.1 205)",
  "oklch(0.7 0.13 300)",
  "oklch(0.78 0.13 60)",
];

/** Colors for a chart, leading with the module accent then cycling the palette. */
export function seriesColors(accent: string, n: number): string[] {
  const base = [accent, ...palette];
  return Array.from({ length: n }, (_, i) => base[i % base.length]);
}

/** Fill opacity bucket for a calendar heat cell, given the value and the max. */
export function heatOpacity(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const t = value / max;
  if (t < 0.2) return 0.22;
  if (t < 0.4) return 0.4;
  if (t < 0.6) return 0.58;
  if (t < 0.8) return 0.76;
  return 0.96;
}
