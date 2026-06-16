import type { ModuleContext } from "../core/types";

export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function weightedPick<T>(entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** A date `n` days before today, fixed at local noon to avoid timezone drift. */
export function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Seasonal multiplier, peaking in winter and dipping in summer (N hemisphere). */
export function seasonal(d: Date): number {
  return 1 + 0.35 * Math.cos((d.getMonth() / 12) * 2 * Math.PI);
}

/** Skip seeding if a table already has rows, so seeds are idempotent. */
export async function alreadySeeded(
  ctx: ModuleContext,
  table: string,
): Promise<boolean> {
  const { rows } = await ctx.db.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM ${table}`,
  );
  return rows[0].c > 0;
}

/** Parameterized bulk insert, chunked to stay under parameter limits. */
export async function insertMany(
  ctx: ModuleContext,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params: unknown[] = [];
    const values = chunk
      .map((row) => {
        const placeholders = row.map((_, ci) => `$${params.length + ci + 1}`);
        params.push(...row);
        return `(${placeholders.join(", ")})`;
      })
      .join(", ");
    await ctx.db.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values} ON CONFLICT DO NOTHING`,
      params,
    );
  }
}
