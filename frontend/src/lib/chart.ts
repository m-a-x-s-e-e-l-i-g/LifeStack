/** Round a max value up to a clean axis bound (1, 2, 2.5, 5, 10 x 10^n). */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow;
  let nice: number;
  if (n <= 1) nice = 1;
  else if (n <= 2) nice = 2;
  else if (n <= 2.5) nice = 2.5;
  else if (n <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

/** Evenly spaced tick values from 0..niceMax(max). */
export function ticks(max: number, count = 4): number[] {
  const m = niceMax(max);
  return Array.from({ length: count + 1 }, (_, i) => (m / count) * i);
}

/** Build a smooth-ish polyline path through points using straight segments. */
export function linePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

/** Pick label indices so at most `keep` x-axis labels render without crowding. */
export function labelStride(count: number, keep = 12): number {
  return Math.max(1, Math.ceil(count / keep));
}
