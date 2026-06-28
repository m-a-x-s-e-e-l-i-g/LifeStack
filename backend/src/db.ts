import { createHash } from "node:crypto";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { env } from "./env";
import { logger } from "./logger";

/**
 * ClickHouse data layer. ClickHouse has no UPSERT, so mutable state tables use
 * ReplacingMergeTree (read with FINAL to collapse to the latest row) and the
 * sync log is an append only event stream.
 */

const settings = {
  // Return 64 bit integers as JSON numbers, not strings.
  output_format_json_quote_64bit_integers: 0 as const,
  // Accept ISO 8601 timestamps on insert.
  date_time_input_format: "best_effort" as const,
};

export const client: ClickHouseClient = createClient({
  url: env.CLICKHOUSE_URL,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
  database: env.CLICKHOUSE_DB,
  clickhouse_settings: settings,
  request_timeout: 60_000,
});

/** Run a SELECT/WITH query and return rows as objects. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const rs = await client.query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });
  return rs.json<T>();
}

/** Run a DDL/utility statement that returns no rows. */
export async function command(sql: string): Promise<void> {
  await client.command({ query: sql, clickhouse_settings: settings });
}

/** Append rows to a table (JSONEachRow). No-op for an empty batch. */
export async function insert(
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.insert({ table, values: rows, format: "JSONEachRow" });
}

export async function waitForDb(retries = 60, delayMs = 1000): Promise<void> {
  // Bootstrap the database (the official image creates it from CLICKHOUSE_DB,
  // but this also covers a bare ClickHouse instance).
  const bootstrap = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    clickhouse_settings: settings,
  });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await bootstrap.command({
        query: `CREATE DATABASE IF NOT EXISTS ${env.CLICKHOUSE_DB}`,
      });
      await bootstrap.close();
      await query("SELECT 1");
      logger.info("clickhouse ready");
      return;
    } catch {
      logger.warn(`clickhouse not ready (attempt ${attempt}/${retries})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("clickhouse did not become ready in time");
}

export async function runCoreMigrations(): Promise<void> {
  await command(`CREATE TABLE IF NOT EXISTS meta (
      key String,
      value String,
      updated_at DateTime64(3) DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY key`);

  await command(`CREATE TABLE IF NOT EXISTS module_state (
      id String,
      enabled UInt8 DEFAULT 1,
      updated_at DateTime64(3) DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY id`);

  await command(`CREATE TABLE IF NOT EXISTS connector_state (
      module_id String,
      connector_id String,
      enabled UInt8 DEFAULT 0,
      config String DEFAULT '{}',
      updated_at DateTime64(3) DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (module_id, connector_id)`);

  await command(`CREATE TABLE IF NOT EXISTS schema_migrations (
      hash String,
      module_id String,
      applied_at DateTime DEFAULT now()
    ) ENGINE = MergeTree ORDER BY hash`);

  await command(`CREATE TABLE IF NOT EXISTS sync_log (
      module_id String,
      connector_id String,
      status String,
      started_at DateTime,
      finished_at DateTime,
      inserted Int64,
      message String
    ) ENGINE = MergeTree ORDER BY (module_id, finished_at)`);

  // AI-assisted ingestion dedupe ledger. Each normalized row hash is recorded
  // per target table so repeated screenshot uploads do not create duplicates.
  await command(`CREATE TABLE IF NOT EXISTS ai_ingest_dedupe (
      target String,
      hash String,
      payload String,
      created_at DateTime DEFAULT now()
    ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (target, hash)`);

  // Immutable audit trail for rows inserted through explicit AI approval.
  await command(`CREATE TABLE IF NOT EXISTS ai_assistant_record_log (
      event_id String,
      change_id String,
      target String,
      hash String,
      payload String,
      created_at DateTime64(3) DEFAULT now64(3)
    ) ENGINE = MergeTree ORDER BY (target, created_at, event_id)`);
}

/** Apply a module's DDL statements idempotently, tracked by content hash. */
export async function applyModuleMigrations(
  moduleId: string,
  statements: string[],
): Promise<number> {
  let applied = 0;
  for (let i = 0; i < statements.length; i++) {
    const sql = statements[i];
    const hash = createHash("sha1").update(`${moduleId}:${i}:${sql}`).digest("hex");
    const seen = await query<{ c: number }>(
      "SELECT count() AS c FROM schema_migrations WHERE hash = {hash:String}",
      { hash },
    );
    if (seen[0]?.c > 0) continue;
    await command(sql);
    await insert("schema_migrations", [{ hash, module_id: moduleId }]);
    applied++;
  }
  return applied;
}

export async function getMeta(key: string): Promise<string | null> {
  const rows = await query<{ value: string }>(
    "SELECT value FROM meta FINAL WHERE key = {key:String} LIMIT 1",
    { key },
  );
  return rows[0]?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await insert("meta", [{ key, value, updated_at: new Date().toISOString() }]);
}
