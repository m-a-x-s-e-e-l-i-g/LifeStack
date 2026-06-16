import pg from "pg";
import { createHash } from "node:crypto";
import { env } from "./env";
import { logger } from "./logger";

const { Pool } = pg;

// Keep bigint and numeric as JS numbers (safe for our magnitudes).
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => parseFloat(v));

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export function query<T extends pg.QueryResultRow = any>(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(sql, params as any[]);
}

export async function waitForDb(retries = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query("SELECT 1");
      logger.info("database ready");
      return;
    } catch {
      logger.warn(`database not ready (attempt ${attempt}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("database did not become ready in time");
}

export async function runCoreMigrations(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS meta (
      key text PRIMARY KEY,
      value text NOT NULL
    )`);
  await query(`CREATE TABLE IF NOT EXISTS module_state (
      id text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      installed_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE TABLE IF NOT EXISTS connector_state (
      module_id text NOT NULL,
      connector_id text NOT NULL,
      enabled boolean NOT NULL DEFAULT false,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      installed_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (module_id, connector_id)
    )`);
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id serial PRIMARY KEY,
      module_id text NOT NULL,
      hash text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE TABLE IF NOT EXISTS sync_log (
      id serial PRIMARY KEY,
      module_id text NOT NULL,
      connector_id text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      status text NOT NULL DEFAULT 'running',
      inserted integer NOT NULL DEFAULT 0,
      message text
    )`);
}

/** Apply a module's migration statements idempotently, tracked by content hash. */
export async function applyModuleMigrations(
  moduleId: string,
  statements: string[],
): Promise<number> {
  let applied = 0;
  for (let i = 0; i < statements.length; i++) {
    const sql = statements[i];
    const hash = createHash("sha1").update(`${moduleId}:${i}:${sql}`).digest("hex");
    const seen = await query("SELECT 1 FROM schema_migrations WHERE hash = $1", [hash]);
    if (seen.rowCount) continue;
    await query(sql);
    await query(
      "INSERT INTO schema_migrations (module_id, hash) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [moduleId, hash],
    );
    applied++;
  }
  return applied;
}

export async function getMeta(key: string): Promise<string | null> {
  const { rows } = await query<{ value: string }>(
    "SELECT value FROM meta WHERE key = $1",
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}
