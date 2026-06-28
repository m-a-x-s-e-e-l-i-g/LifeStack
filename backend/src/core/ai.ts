import { createHash, randomUUID } from "node:crypto";
import { client, command, getMeta, insert, query, setMeta } from "../db";
import { env } from "../env";
import { logger } from "../logger";
import { modules } from "../modules";

/**
 * Chat-first assistant. Provider agnostic: talks to any OpenAI-compatible
 * /chat/completions endpoint (OpenAI, Ollama /v1, LM Studio, vLLM, ...).
 *
 * It can read data via SQL and, when explicitly requested by the user, ingest
 * structured records into local tables (for example from receipts or CSV files).
 */

const log = logger.child("ai");

const CORE_TABLES = new Set([
  "meta",
  "module_state",
  "connector_state",
  "schema_migrations",
  "sync_log",
  "ai_ingest_dedupe",
  "ai_assistant_record_log",
]);

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Runtime config (Settings) overrides environment defaults. */
export async function aiConfig(): Promise<AiConfig> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getMeta("ai_base_url"),
    getMeta("ai_api_key"),
    getMeta("ai_model"),
  ]);
  return {
    baseUrl: (baseUrl ?? env.AI_BASE_URL).replace(/\/+$/, ""),
    apiKey: apiKey ?? env.AI_API_KEY,
    model: model ?? env.AI_MODEL,
  };
}

export async function setAiConfig(patch: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<void> {
  if (patch.baseUrl !== undefined) await setMeta("ai_base_url", patch.baseUrl.trim());
  if (patch.model !== undefined) await setMeta("ai_model", patch.model.trim());
  if (patch.apiKey !== undefined && patch.apiKey !== "")
    await setMeta("ai_api_key", patch.apiKey.trim());
}

export async function aiStatus(): Promise<{
  configured: boolean;
  model: string;
  baseUrl: string;
  hasKey: boolean;
}> {
  const cfg = await aiConfig();
  let host = "";
  try {
    host = cfg.baseUrl ? new URL(cfg.baseUrl).host : "";
  } catch {
    host = cfg.baseUrl;
  }
  return {
    configured: !!cfg.baseUrl && !!cfg.model,
    model: cfg.model,
    baseUrl: host,
    hasKey: !!cfg.apiKey,
  };
}

/** Compact description of the user's data tables for the system prompt. */
export async function schemaSummary(): Promise<string> {
  const rs = await client.query({
    query: `SELECT table, name, type FROM system.columns
            WHERE database = {db:String}
            ORDER BY table, position`,
    query_params: { db: env.CLICKHOUSE_DB },
    format: "JSONEachRow",
  });
  const cols = await rs.json<{ table: string; name: string; type: string }>();
  const byTable = new Map<string, string[]>();
  for (const c of cols) {
    if (CORE_TABLES.has(c.table)) continue;
    if (!byTable.has(c.table)) byTable.set(c.table, []);
    byTable.get(c.table)!.push(`${c.name} ${c.type}`);
  }
  if (byTable.size === 0) {
    return "There are no data tables with content yet. The user must connect a source (for example Trakt) and sync, or import data, before there is anything to query.";
  }
  const tableNames = [...byTable.keys()].sort();
  const moduleTableHints = (() => {
    const remaining = new Set(tableNames);
    const lines = modules.map((m) => {
      const prefixes = new Set<string>([`${m.id}_`]);
      if (m.id.endsWith("s")) prefixes.add(`${m.id.slice(0, -1)}_`);
      if (m.id.endsWith("ies")) prefixes.add(`${m.id.slice(0, -3)}y_`);
      if (m.id.endsWith("ing")) prefixes.add(`${m.id.slice(0, -3)}_`);

      const matched = tableNames.filter((t) => [...prefixes].some((p) => t.startsWith(p)));
      for (const table of matched) remaining.delete(table);

      return `- ${m.name} (${m.id}): ${matched.length ? matched.join(", ") : "none yet"}`;
    });

    const leftovers = [...remaining].sort();
    if (leftovers.length > 0) lines.push(`- Other readable tables: ${leftovers.join(", ")}`);
    return lines.join("\n");
  })();

  const schema = [...byTable.entries()]
    .map(([t, c]) => `${t}(${c.join(", ")})`)
    .join("\n");

  return `Module read access tables:\n${moduleTableHints}\n\nData tables (with columns):\n${schema}`;
}

const FORBIDDEN =
  /\b(insert|update|delete|alter|drop|create|rename|truncate|attach|detach|optimize|grant|revoke|set|system|kill|use|into)\b/i;
const TABLE_FUNCS =
  /\b(file|url|remote|remotesecure|s3|s3cluster|hdfs|mysql|postgresql|jdbc|odbc|input|cluster|clusterallreplicas)\s*\(/i;

/** Validate and normalize a model-supplied query so it can only read data. */
export function sanitizeSql(raw: string): string {
  let sql = (raw ?? "").trim().replace(/;\s*$/, "").trim();
  if (!sql) throw new Error("Empty query");
  if (sql.includes(";")) throw new Error("Only a single statement is allowed");
  if (!/^(select|with)\b/i.test(sql))
    throw new Error("Only SELECT / WITH queries are allowed");
  if (FORBIDDEN.test(sql))
    throw new Error("Only read-only SELECT queries are allowed");
  if (TABLE_FUNCS.test(sql)) throw new Error("Table functions are not allowed");
  if (/\bsystem\s*\./i.test(sql))
    throw new Error("Access to system tables is not allowed");
  if (!/\blimit\s+\d+/i.test(sql)) sql += "\nLIMIT 200";
  return sql;
}

export async function runReadonlySql(
  raw: string,
): Promise<{ rows: Record<string, unknown>[] }> {
  const sql = sanitizeSql(raw);
  const rs = await client.query({
    query: sql,
    format: "JSONEachRow",
    clickhouse_settings: {
      max_result_rows: "1000",
      result_overflow_mode: "break",
      max_execution_time: 20,
      readonly: "1",
    },
  });
  const rows = await rs.json<Record<string, unknown>>();
  return { rows };
}

export interface ChatAttachment {
  name?: string | null;
  mime: string;
  dataUrl: string;
  text?: string | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  attachments?: ChatAttachment[];
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface ChatStep {
  sql: string;
  rows: Record<string, unknown>[] | null;
  error: string | null;
}

export interface PendingChange {
  id: string;
  kind: "write_records" | "delete_records" | "update_records";
  target: WriteTarget;
  rows?: unknown[];
  where?: unknown;
  updates?: Record<string, unknown>;
  summary: string;
}

interface ModelMessage {
  role: string;
  content: unknown;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

async function callModel(
  cfg: AiConfig,
  model: string,
  messages: unknown[],
  tools: unknown[],
): Promise<ModelMessage> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: 0.2,
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed (${res.status}): ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: ModelMessage }>;
  };
  const msg = json.choices?.[0]?.message;
  if (!msg) throw new Error("LLM returned no message");
  return msg;
}

type WriteTarget =
  | "mobility_ride"
  | "mobility_lime_pass"
  | "finance_tx"
  | "fuel_fillup"
  | "energy_reading"
  | "food_order";

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value: unknown, fallback = 0): number {
  return Math.round(num(value, fallback));
}

function day(value: unknown): string {
  const s = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function normalizeProviderName(value: unknown): string {
  const raw = String(value ?? "").trim();
  const v = raw.toLowerCase();
  if (!v) return "Unknown";
  if (v.includes("uber")) return "Uber";
  if (v.includes("bolt")) return "Bolt";
  if (v.includes("lime")) return "Lime";
  if (v.includes("tier")) return "Tier";
  if (v.includes("bird")) return "Bird";
  if (v.includes("lyft")) return "Lyft";
  return raw;
}

function normalizeCurrencyCode(value: unknown, fallback = "EUR"): string {
  const raw = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!raw) return fallback;
  if (raw === "CZECH KORUNA" || raw === "CZECH KORUNAS" || raw === "CZECH CROWN" || raw === "CZECH CROWNS")
    return "CZK";
  if (raw === "KČ" || raw === "KC" || raw === "CZK") return "CZK";
  if (raw === "€" || raw === "EUR") return "EUR";
  if (raw === "$" || raw === "USD") return "USD";
  if (raw === "£" || raw === "GBP") return "GBP";
  if (raw === "ZŁ" || raw === "PLN") return "PLN";
  return /^[A-Z]{3}$/.test(raw) ? raw : fallback;
}

const EUR_PER_UNIT: Record<string, number> = {
  EUR: 1,
  CZK: 0.0402,
  USD: 0.93,
  GBP: 1.18,
  PLN: 0.235,
  CHF: 1.04,
  SEK: 0.086,
  NOK: 0.086,
  DKK: 0.134,
  HUF: 0.0025,
};

function toEur(amount: number, currency: string): number {
  const rate = EUR_PER_UNIT[currency] ?? 1;
  return Math.round(amount * rate * 100) / 100;
}

function normalizeRideType(rawType: unknown, provider: string): string {
  const t = String(rawType ?? "").trim().toLowerCase();
  const p = provider.toLowerCase();
  if (t.includes("bike") || t.includes("bicycle") || t.includes("cycle")) return "bike";
  if (p.includes("lime") || p.includes("tier") || p.includes("bird") || t.includes("scooter"))
    return "scooter";
  if (p.includes("uber") || p.includes("bolt") || p.includes("lyft")) return "taxi";
  if (t.includes("taxi") || t.includes("cab") || t.includes("car") || t.includes("ride"))
    return "taxi";
  return t || "ride";
}

function asObjectRows(rowsInput: unknown[]): { rows: Record<string, unknown>[]; rejected: number } {
  const rows: Record<string, unknown>[] = [];
  let rejected = 0;
  for (const raw of rowsInput) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejected++;
      continue;
    }
    rows.push(raw as Record<string, unknown>);
  }
  return { rows, rejected };
}

function isLikelyLimePassRow(raw: Record<string, unknown>): boolean {
  const provider = normalizeProviderName(raw.provider ?? raw.app ?? raw.service).toLowerCase();
  const text = Object.values(raw)
    .map((v) => String(v ?? ""))
    .join(" ")
    .toLowerCase();
  const mentionsLime = provider.includes("lime") || text.includes("lime");
  const hasPassSignal = /\blime\s*pass\b|\bpass(?:es)?\b|\bsubscription\b|\bbundle\b|\bpackage\b|\bunlimited\b|\bunlock\b/.test(
    text,
  );

  if (mentionsLime && hasPassSignal) return true;

  const distance = Number(raw.distance_km ?? raw.distance ?? raw.km);
  const duration = Number(raw.duration_min ?? raw.duration ?? raw.minutes);
  const hasRideMetrics = (Number.isFinite(distance) && distance > 0) || (Number.isFinite(duration) && duration > 0);
  const hasStartedAt = String(raw.started_at ?? raw.startedAt ?? raw.timestamp ?? raw.time ?? "").trim().length > 0;
  const rideType = String(raw.type ?? raw.vehicle ?? "").trim().toLowerCase();
  const vagueLimeRide =
    provider.includes("lime") &&
    !hasRideMetrics &&
    !hasStartedAt &&
    (!rideType || rideType.includes("bike") || rideType.includes("scooter") || rideType.includes("ride"));

  return vagueLimeRide;
}

function resolveWriteTarget(target: WriteTarget, rows: Record<string, unknown>[]): WriteTarget {
  if (target !== "mobility_ride" || rows.length === 0) return target;
  return rows.every((row) => isLikelyLimePassRow(row)) ? "mobility_lime_pass" : target;
}

function stableHash(target: WriteTarget, row: Record<string, unknown>): string {
  const ordered = Object.keys(row)
    .sort()
    .map((k) => [k, row[k]]);
  return createHash("sha1")
    .update(`${target}:${JSON.stringify(ordered)}`)
    .digest("hex");
}

function normalizeRow(target: WriteTarget, raw: Record<string, unknown>): Record<string, unknown> {
  if (target === "mobility_lime_pass") {
    const originalCost = num(raw.cost ?? raw.amount ?? raw.price ?? raw.total);
    const costCurrency = normalizeCurrencyCode(raw.cost_currency ?? raw.currency ?? raw.currency_code);
    const description = String(raw.description ?? raw.plan ?? raw.product ?? raw.title ?? "Lime pass").trim();
    return {
      day: day(raw.day ?? raw.date),
      cost: originalCost,
      cost_currency: costCurrency,
      cost_eur: toEur(originalCost, costCurrency),
      description: description || "Lime pass",
      notes: String(raw.notes ?? raw.note ?? ""),
    };
  }
  if (target === "mobility_ride") {
    const provider = normalizeProviderName(raw.provider ?? raw.app ?? raw.service);
    const startedAt = raw.started_at ?? raw.startedAt ?? raw.timestamp ?? raw.time;
    const originalCost = num(raw.cost ?? raw.amount ?? raw.price);
    const costCurrency = normalizeCurrencyCode(raw.cost_currency ?? raw.currency ?? raw.currency_code);
    const row: Record<string, unknown> = {
      day: day(raw.day ?? raw.date),
      provider,
      type: normalizeRideType(raw.type ?? raw.vehicle, provider),
      distance_km: num(raw.distance_km ?? raw.distance ?? raw.km),
      duration_min: int(raw.duration_min ?? raw.duration ?? raw.minutes),
      cost: originalCost,
      cost_currency: costCurrency,
      cost_eur: toEur(originalCost, costCurrency),
    };
    if (startedAt !== undefined && startedAt !== null && String(startedAt).trim()) {
      row.started_at = String(startedAt);
    }
    return row;
  }
  if (target === "finance_tx") {
    return {
      day: day(raw.day ?? raw.date),
      description: String(raw.description ?? raw.note ?? "AI import"),
      category: String(raw.category ?? raw.type ?? "Uncategorized"),
      amount: num(raw.amount ?? raw.cost ?? raw.value),
    };
  }
  if (target === "fuel_fillup") {
    const liters = num(raw.liters ?? raw.volume);
    const ppl = num(raw.price_per_liter ?? raw.pricePerLiter ?? raw.unit_price);
    return {
      day: day(raw.day ?? raw.date),
      liters,
      price_per_liter: ppl,
      cost: num(raw.cost ?? liters * ppl),
      odometer: int(raw.odometer ?? raw.km_total ?? 0),
    };
  }
  if (target === "food_order") {
    return {
      day: day(raw.day ?? raw.date),
      provider: String(raw.provider ?? raw.app ?? "Takeaway"),
      merchant: String(raw.merchant ?? raw.restaurant ?? raw.store ?? "Unknown"),
      total: num(raw.total ?? raw.cost ?? raw.amount),
      currency: String(raw.currency ?? "EUR"),
      items: int(raw.items ?? raw.item_count ?? raw.count ?? 0),
      delivery_fee: num(raw.delivery_fee ?? raw.deliveryFee ?? 0),
      service_fee: num(raw.service_fee ?? raw.serviceFee ?? 0),
      tip: num(raw.tip ?? 0),
      notes: String(raw.notes ?? raw.note ?? ""),
      source: "assistant",
    };
  }
  return {
    day: day(raw.day ?? raw.date),
    day_kwh: num(raw.day_kwh ?? raw.dayKwh ?? raw.kwh ?? 0),
    night_kwh: num(raw.night_kwh ?? raw.nightKwh ?? 0),
    cost: num(raw.cost ?? raw.amount ?? 0),
  };
}

async function writeRecords(
  target: WriteTarget,
  rowsInput: unknown[],
  changeId?: string,
): Promise<Record<string, unknown>> {
  if (!Array.isArray(rowsInput)) throw new Error("rows must be an array");
  const { rows: objectRows, rejected } = asObjectRows(rowsInput);
  const effectiveTarget = resolveWriteTarget(target, objectRows);
  const reroutedTarget = effectiveTarget !== target;
  const normalized = objectRows.map((raw) => normalizeRow(effectiveTarget, raw));

  if (normalized.length === 0) {
    return {
      target: effectiveTarget,
      inserted: 0,
      skippedDuplicates: 0,
      rejected,
      message: "No valid rows were provided.",
    };
  }

  const hashes = normalized.map((r) => stableHash(effectiveTarget, r));
  const seenRows = await query<{ hash: string }>(
    `SELECT hash FROM ai_ingest_dedupe FINAL
     WHERE target = {target:String} AND hash IN {hashes:Array(String)}`,
    { target: effectiveTarget, hashes },
  );
  const seen = new Set(seenRows.map((r) => r.hash));

  const toInsert: Record<string, unknown>[] = [];
  const dedupeRows: Record<string, unknown>[] = [];
  const auditRows: Record<string, unknown>[] = [];
  let skippedDuplicates = 0;

  for (let i = 0; i < normalized.length; i++) {
    const row = normalized[i];
    const hash = hashes[i];
    if (seen.has(hash)) {
      skippedDuplicates++;
      continue;
    }
    seen.add(hash);
    toInsert.push(row);
    dedupeRows.push({
      target: effectiveTarget,
      hash,
      payload: JSON.stringify(row),
      created_at: new Date().toISOString(),
    });
    auditRows.push({
      event_id: randomUUID(),
      change_id: String(changeId ?? ""),
      target: effectiveTarget,
      hash,
      payload: JSON.stringify(row),
      created_at: new Date().toISOString(),
    });
  }

  if (toInsert.length > 0) {
    await insert(effectiveTarget, toInsert);
    await insert("ai_ingest_dedupe", dedupeRows);
    await insert("ai_assistant_record_log", auditRows);
  }

  return {
    target: effectiveTarget,
    inserted: toInsert.length,
    skippedDuplicates,
    rejected,
    message: reroutedTarget
      ? `Saved ${toInsert.length} row(s) to ${effectiveTarget} (auto-routed from ${target}); skipped ${skippedDuplicates} duplicate(s).`
      : `Saved ${toInsert.length} row(s) to ${effectiveTarget}; skipped ${skippedDuplicates} duplicate(s).`,
  };
}

const DELETE_COLUMNS: Record<WriteTarget, string[]> = {
  mobility_ride: [
    "day",
    "started_at",
    "provider",
    "type",
    "distance_km",
    "duration_min",
    "cost",
    "cost_currency",
    "cost_eur",
  ],
  mobility_lime_pass: [
    "day",
    "created_at",
    "cost",
    "cost_currency",
    "cost_eur",
    "description",
    "notes",
  ],
  finance_tx: ["day", "description", "category", "amount"],
  fuel_fillup: ["day", "liters", "price_per_liter", "cost", "odometer"],
  energy_reading: ["day", "day_kwh", "night_kwh", "cost"],
  food_order: [
    "day",
    "provider",
    "merchant",
    "total",
    "currency",
    "items",
    "delivery_fee",
    "service_fee",
    "tip",
    "notes",
    "source",
  ],
};

function lit(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = String(v ?? "").replace(/'/g, "''");
  return `'${s}'`;
}

function whereSqlForTarget(target: WriteTarget, whereRaw: unknown): string {
  if (!whereRaw || typeof whereRaw !== "object" || Array.isArray(whereRaw)) {
    throw new Error("where must be an object");
  }
  const allowed = new Set(DELETE_COLUMNS[target]);
  const where = whereRaw as Record<string, unknown>;
  const clauses: string[] = [];

  for (const [k, v] of Object.entries(where)) {
    if (!allowed.has(k)) throw new Error(`Unsupported filter column: ${k}`);
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      clauses.push(`${k} IN (${v.map((x) => lit(x)).join(", ")})`);
      continue;
    }
    if (v === null || v === undefined || v === "") continue;
    clauses.push(`${k} = ${lit(v)}`);
  }

  if (clauses.length === 0) {
    throw new Error("At least one filter is required for delete_records");
  }
  return clauses.join(" AND ");
}

async function deleteRecords(
  target: WriteTarget,
  whereRaw: unknown,
): Promise<Record<string, unknown>> {
  const where = whereSqlForTarget(target, whereRaw);

  const toDelete = await query<Record<string, unknown>>(
    `SELECT * FROM ${target} WHERE ${where} LIMIT 5000`,
  );
  const matchedRows = await query<{ c: number }>(
    `SELECT count() AS c FROM ${target} WHERE ${where}`,
  );
  const matched = matchedRows[0]?.c ?? 0;
  if (matched === 0) {
    return {
      target,
      matched: 0,
      deletionScheduled: false,
      message: "No rows matched the delete filter.",
    };
  }

  await command(`ALTER TABLE ${target} DELETE WHERE ${where}`);

  // Remove matching hashes from the dedupe ledger so equivalent rows can be
  // imported again later if needed.
  const hashes = new Set<string>();
  for (const row of toDelete) hashes.add(stableHash(target, row));
  if (hashes.size > 0) {
    const hashList = [...hashes].map((h) => lit(h)).join(", ");
    await command(
      `ALTER TABLE ai_ingest_dedupe DELETE WHERE target = ${lit(target)} AND hash IN (${hashList})`,
    );
  }

  return {
    target,
    matched,
    deletionScheduled: true,
    message: `Scheduled deletion for ${matched} row(s) from ${target}.`,
  };
}

async function updateRecords(
  target: WriteTarget,
  whereRaw: unknown,
  updatesRaw: unknown,
): Promise<Record<string, unknown>> {
  const where = whereSqlForTarget(target, whereRaw);

  // Validate and normalize updates
  if (!updatesRaw || typeof updatesRaw !== "object" || Array.isArray(updatesRaw)) {
    throw new Error("updates must be an object");
  }
  const allowed = new Set(DELETE_COLUMNS[target]);
  const updates = updatesRaw as Record<string, unknown>;
  const setClauses: string[] = [];

  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.has(k)) throw new Error(`Unsupported update column: ${k}`);
    setClauses.push(`${k} = ${lit(v)}`);
  }

  if (setClauses.length === 0) {
    return {
      target,
      matched: 0,
      updateScheduled: false,
      message: "No valid columns to update.",
    };
  }

  // Find matching rows before update
  const matched = await query<{ c: number }>(
    `SELECT count() AS c FROM ${target} WHERE ${where}`,
  );
  const matchedCount = matched[0]?.c ?? 0;
  if (matchedCount === 0) {
    return {
      target,
      matched: 0,
      updateScheduled: false,
      message: "No rows matched the update filter.",
    };
  }

  // Execute the update
  const setClause = setClauses.join(", ");
  await command(`ALTER TABLE ${target} UPDATE ${setClause} WHERE ${where}`);

  return {
    target,
    matched: matchedCount,
    updateScheduled: true,
    message: `Scheduled update for ${matchedCount} row(s) in ${target}.`,
  };
}

export async function applyPendingChange(
  change: PendingChange,
): Promise<Record<string, unknown>> {
  if (change.kind === "write_records") {
    return writeRecords(change.target, Array.isArray(change.rows) ? change.rows : [], change.id);
  }
  if (change.kind === "update_records") {
    return updateRecords(change.target, change.where, change.updates);
  }
  return deleteRecords(change.target, change.where);
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_sql",
      description:
        "Run a single read-only ClickHouse SELECT (or WITH) query against the user's personal data and return matching rows as JSON. Use this to answer any question about the user's statistics.",
      parameters: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description:
              "A single ClickHouse SELECT or WITH statement. No semicolons, no DDL/DML.",
          },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_records",
      description:
        "Insert structured records into a local LifeStack table. Use this only when the user explicitly asks to save/import data (for example from receipts, screenshots, or CSV files).",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [
              "mobility_ride",
              "mobility_lime_pass",
              "finance_tx",
              "fuel_fillup",
              "energy_reading",
              "food_order",
            ],
            description: "Target local table for the new records.",
          },
          rows: {
            type: "array",
            description: "Array of row objects extracted from user-provided input.",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["target", "rows"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_records",
      description:
        "Delete matching records from a local LifeStack table. Use only when the user explicitly asks to remove data.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [
              "mobility_ride",
              "mobility_lime_pass",
              "finance_tx",
              "fuel_fillup",
              "energy_reading",
              "food_order",
            ],
            description: "Target local table.",
          },
          where: {
            type: "object",
            description:
              "Equality filters. Keys must be columns of the target table. At least one filter is required.",
            additionalProperties: true,
          },
        },
        required: ["target", "where"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_records",
      description:
        "Update existing records in a local LifeStack table. Use when the user asks to change field values on existing entries.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [
              "mobility_ride",
              "mobility_lime_pass",
              "finance_tx",
              "fuel_fillup",
              "energy_reading",
              "food_order",
            ],
            description: "Target local table.",
          },
          where: {
            type: "object",
            description:
              "Equality filters to identify which records to update. Keys must be columns of the target table. At least one filter is required.",
            additionalProperties: true,
          },
          updates: {
            type: "object",
            description:
              "Field updates to apply. Keys must be columns of the target table, values are the new values.",
            additionalProperties: true,
          },
        },
        required: ["target", "where", "updates"],
      },
    },
  },
];

const MAX_ATTACHMENTS_PER_BATCH = 5;
const MAX_ATTACHMENT_TEXT_CHARS = 24000;

function systemPrompt(schema: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the analyst inside LifeStack, a self-hosted personal statistics app. You can answer questions and, when the user asks to import data, save structured records.

Today is ${today} (UTC).

Data tables (ClickHouse):
${schema}

Rules:
- To get any number, call run_sql. Never invent values; if a query returns no rows, say the data is not there yet.
- You have read access to every table listed above under "Module read access tables", including Nature observations tables.
- For file imports (screenshots, receipts, CSV, or text), extract structured entries and call write_records with the correct target table and rows.
- Food delivery receipts/screenshots (Uber Eats, takeaway.com, thuisbezorgd) should be written to food_order.
- Mobility receipts/screenshots should normalize provider names (Uber, Bolt, Lime, Tier, Bird, Lyft) and set type to taxi, scooter, or bike. If the source indicates bike/e-bike/cycle, keep it as bike even for Lime/Tier/Bird.
- Lime pass purchases (for example day passes or subscriptions) are not rides; write them to mobility_lime_pass with day, cost, cost_currency, cost_eur, description, and optional notes.
- Never write Lime passes or subscriptions into mobility_ride, even if a screenshot mentions bike or scooter.
- If a mobility source includes an explicit ride time, store it as started_at.
- Mobility cost must preserve the original amount in cost and original ISO currency in cost_currency (for example CZK, EUR, USD). Never assume EUR when a non-EUR currency is shown.
- Only modify data when the user explicitly asks. Use write_records to add new rows, update_records to change specific field values on existing entries (e.g., if user says "this should be Uber instead"), and delete_records to remove rows entirely. For updates, use the most specific identifying fields in the WHERE clause (e.g., day + started_at for mobility_ride) to target exactly the record the user refers to.
- ClickHouse dialect: use today(), now(), toStartOfMonth(x), toYYYYMM(x), formatDateTime(x, '%b'), countIf(cond), sumIf(x, cond), uniqExact(x), arrayJoin(arr). Date math uses INTERVAL, e.g. today() - INTERVAL 12 MONTH.
- Tables holding deduplicated entities use ReplacingMergeTree; add FINAL after the table name (e.g. FROM watch_history FINAL) so re-synced rows are not double counted.
- Keep queries focused and always include a LIMIT for row listings.
- Reply in concise prose. Lead with the answer and the key number. Do not show SQL unless asked; the app already displays the queries you ran.`;
}

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content
    .map((p) => {
      if (!p || typeof p !== "object") return "";
      const t = (p as { type?: string }).type;
      if (t === "text" || t === "input_text") return String((p as { text?: string }).text ?? "");
      return "";
    })
    .filter(Boolean);
  return parts.join("\n").trim();
}

function summarizeSteps(steps: ChatStep[]): {
  inserted: number;
  skippedDuplicates: number;
  rejected: number;
} {
  let inserted = 0;
  let skippedDuplicates = 0;
  let rejected = 0;
  for (const step of steps) {
    const row = step.rows?.[0];
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    inserted += Number(r.inserted ?? 0);
    skippedDuplicates += Number(r.skippedDuplicates ?? 0);
    rejected += Number(r.rejected ?? 0);
  }
  return { inserted, skippedDuplicates, rejected };
}

function isBatchableImageError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /image_parse_error|unsupported image|payload too large|request too large|token limit|context length|too many images|bad gateway|internal server error|500/i.test(
    message,
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function findAttachmentUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && (messages[i].attachments?.length ?? 0) > 0) return i;
  }
  return -1;
}

function withAttachments(messages: ChatMessage[], index: number, attachments: ChatAttachment[]): ChatMessage[] {
  return messages.map((m, i) => (i === index ? { ...m, attachments } : m));
}

function attachmentName(attachment: ChatAttachment, index: number): string {
  const raw = String(attachment.name ?? "").trim();
  return raw || `attachment-${index + 1}`;
}

function isTextLikeMime(mime: string): boolean {
  const lower = String(mime ?? "").toLowerCase();
  return (
    lower.startsWith("text/") ||
    lower === "application/json" ||
    lower === "application/csv" ||
    lower === "text/csv" ||
    lower === "text/tab-separated-values" ||
    lower === "application/xml" ||
    lower === "text/xml"
  );
}

function isImageAttachment(attachment: ChatAttachment): boolean {
  const mime = String(attachment.mime ?? "").toLowerCase();
  return mime.startsWith("image/") || /^data:image\//i.test(String(attachment.dataUrl ?? ""));
}

function decodeTextDataUrl(dataUrl: string): string | null {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;

  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  const isBase64 = /;base64/i.test(header);

  try {
    if (isBase64) return Buffer.from(payload, "base64").toString("utf8");
    return decodeURIComponent(payload.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
}

function clipAttachmentText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (text.length <= MAX_ATTACHMENT_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n...[truncated]`;
}

function attachmentText(attachment: ChatAttachment): string {
  if (typeof attachment.text === "string" && attachment.text.trim()) {
    return clipAttachmentText(attachment.text);
  }
  if (!isTextLikeMime(attachment.mime)) return "";
  const decoded = decodeTextDataUrl(attachment.dataUrl);
  return decoded ? clipAttachmentText(decoded) : "";
}

function toUserContent(m: ChatMessage): unknown {
  const attachments = m.attachments ?? [];
  if (attachments.length === 0) return m.content ?? "";

  const includesImage = attachments.some((attachment) => isImageAttachment(attachment));
  const parts: Array<Record<string, unknown>> = [];
  const textBlocks: string[] = [];

  if (m.content?.trim()) {
    if (includesImage) parts.push({ type: "text", text: m.content.trim() });
    else textBlocks.push(m.content.trim());
  }

  for (let index = 0; index < attachments.length; index++) {
    const attachment = attachments[index];
    const mime = String(attachment.mime ?? "application/octet-stream").trim() || "application/octet-stream";
    const name = attachmentName(attachment, index);

    if (includesImage && isImageAttachment(attachment)) {
      parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } });
      continue;
    }

    const text = attachmentText(attachment);
    const block = text
      ? `Attachment \"${name}\" (${mime}):\n${text}`
      : `Attachment \"${name}\" (${mime}) was uploaded as binary data. Ask the user for a text, CSV, or image version if extraction is required.`;

    if (text) {
      if (includesImage) {
        parts.push({ type: "text", text: block });
      } else {
        textBlocks.push(block);
      }
    } else {
      if (includesImage) {
        parts.push({ type: "text", text: block });
      } else {
        textBlocks.push(block);
      }
    }
  }

  if (includesImage) {
    if (parts.length === 0) parts.push({ type: "text", text: "Analyze the attached files." });
    return parts;
  }

  if (textBlocks.length === 0) return m.content ?? "";
  return textBlocks.join("\n\n");
}

export async function chat(
  incoming: ChatMessage[],
): Promise<{
  reply: string;
  steps: ChatStep[];
  configured: boolean;
  pendingActions?: PendingChange[];
}> {
  const cfg = await aiConfig();
  if (!cfg.baseUrl || !cfg.model) {
    return {
      configured: false,
      steps: [],
      reply:
        "The assistant is not configured yet. Open Settings and set an AI base URL (any OpenAI-compatible endpoint, for example a local Ollama at http://host.docker.internal:11434/v1) and a model name. For hosted providers add an API key.",
    };
  }

  async function runConversation(
    messages: ChatMessage[],
    allowSplitOnImageError = false,
  ): Promise<{ reply: string; steps: ChatStep[]; pendingActions?: PendingChange[] }> {
    const schema = await schemaSummary();
    const convo: unknown[] = [
      { role: "system", content: systemPrompt(schema) },
      ...messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role,
          content: m.role === "user" ? toUserContent(m) : (m.content ?? ""),
        })),
    ];

    const steps: ChatStep[] = [];
    const pendingActions: PendingChange[] = [];
    const hasImages = messages.some(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.attachments) &&
        m.attachments.some((attachment) => isImageAttachment(attachment)),
    );
    const modelCandidates = (
      hasImages && /api\.openai\.com/i.test(cfg.baseUrl)
        ? [cfg.model, "gpt-4.1-mini", "gpt-4o-mini"]
        : [cfg.model]
    ).filter((m, i, all) => !!m && all.indexOf(m) === i);

    const callModelWithFallback = async (): Promise<ModelMessage> => {
      let lastError: Error | null = null;
      for (const model of modelCandidates) {
        try {
          return await callModel(cfg, model, convo, TOOLS);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const msg = lastError.message.toLowerCase();
          const maybeImageIssue =
            msg.includes("image_parse_error") ||
            msg.includes("unsupported image") ||
            msg.includes("does not support image");
          if (!maybeImageIssue) throw lastError;
        }
      }
      throw lastError ?? new Error("LLM request failed");
    };

    for (let i = 0; i < 8; i++) {
      let msg: ModelMessage;
      try {
        msg = await callModelWithFallback();
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (
          hasImages &&
          /image_parse_error|unsupported image|does not support image/i.test(text) &&
          !(allowSplitOnImageError && attachmentCount > 1)
        ) {
          return {
            reply:
              "Your current model endpoint rejected one or more image attachments. Switch to a vision-capable OpenAI-compatible model in Settings, then upload again.",
            steps,
          };
        }
        throw err;
      }
      convo.push(msg);
      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        return { reply: asText(msg.content), steps };
      }
      for (const call of calls) {
        let content: string;
        let stepSql = "";
        let stepRows: Record<string, unknown>[] | null = null;
        let stepError: string | null = null;
        try {
          const args = JSON.parse(call.function.arguments || "{}") as {
            sql?: string;
            target?: WriteTarget;
            rows?: unknown[];
            where?: unknown;
            updates?: Record<string, unknown>;
          };
          if (call.function.name === "run_sql") {
            stepSql = String(args.sql ?? "");
            const out = await runReadonlySql(stepSql);
            stepRows = out.rows;
            content = JSON.stringify({ rowCount: out.rows.length, rows: out.rows.slice(0, 50) });
          } else if (call.function.name === "write_records") {
            const requestedTarget = String(args.target ?? "") as WriteTarget;
            if (
              ![
                "mobility_ride",
                "mobility_lime_pass",
                "finance_tx",
                "fuel_fillup",
                "energy_reading",
                "food_order",
              ].includes(requestedTarget)
            ) {
              throw new Error("Unsupported write target");
            }
            const rows = Array.isArray(args.rows) ? args.rows : [];
            const { rows: objectRows } = asObjectRows(rows);
            const target = resolveWriteTarget(requestedTarget, objectRows);
            const change: PendingChange = {
              id: randomUUID(),
              kind: "write_records",
              target,
              rows,
              summary:
                target === requestedTarget
                  ? `Import ${rows.length} row${rows.length === 1 ? "" : "s"} into ${target}`
                  : `Import ${rows.length} row${rows.length === 1 ? "" : "s"} into ${target} (auto-routed from ${requestedTarget})`,
            };
            pendingActions.push(change);
            stepSql =
              target === requestedTarget
                ? `pending write_records(${target})`
                : `pending write_records(${target}) auto-routed from ${requestedTarget}`;
            stepRows = [{ pending: true, ...change }];
            content = JSON.stringify(change);
          } else if (call.function.name === "delete_records") {
            const target = String(args.target ?? "") as WriteTarget;
            if (
              ![
                "mobility_ride",
                "mobility_lime_pass",
                "finance_tx",
                "fuel_fillup",
                "energy_reading",
                "food_order",
              ].includes(target)
            ) {
              throw new Error("Unsupported delete target");
            }
            const change: PendingChange = {
              id: randomUUID(),
              kind: "delete_records",
              target,
              where: args.where,
              summary: `Delete matching rows from ${target}`,
            };
            pendingActions.push(change);
            stepSql = `pending delete_records(${target})`;
            stepRows = [{ pending: true, ...change }];
            content = JSON.stringify(change);
          } else if (call.function.name === "update_records") {
            const target = String(args.target ?? "") as WriteTarget;
            if (
              ![
                "mobility_ride",
                "mobility_lime_pass",
                "finance_tx",
                "fuel_fillup",
                "energy_reading",
                "food_order",
              ].includes(target)
            ) {
              throw new Error("Unsupported update target");
            }
            const updates = args.updates ?? {};
            const change: PendingChange = {
              id: randomUUID(),
              kind: "update_records",
              target,
              where: args.where,
              updates,
              summary: `Update matching rows in ${target}`,
            };
            pendingActions.push(change);
            stepSql = `pending update_records(${target})`;
            stepRows = [{ pending: true, ...change }];
            content = JSON.stringify(change);
          } else {
            throw new Error(`Unsupported tool: ${call.function.name}`);
          }
        } catch (err) {
          stepError = err instanceof Error ? err.message : String(err);
          content = JSON.stringify({ error: stepError });
        }
        steps.push({ sql: stepSql, rows: stepRows, error: stepError });
        convo.push({ role: "tool", tool_call_id: call.id, content });
      }

      if (pendingActions.length > 0) {
        return {
          reply: `I prepared ${pendingActions.length} change${pendingActions.length === 1 ? "" : "s"} for approval.`,
          steps,
          pendingActions,
        };
      }
    }

    log.warn("chat hit tool-call limit without a final answer");
    return {
      reply:
        "I ran several queries/actions but could not settle on an answer. Try asking something more specific.",
      steps,
    };
  }

  const attachmentIndex = findAttachmentUserIndex(incoming);
  const attachmentCount = attachmentIndex >= 0 ? incoming[attachmentIndex].attachments?.length ?? 0 : 0;

  if (attachmentIndex < 0 || attachmentCount <= MAX_ATTACHMENTS_PER_BATCH) {
    const result = await runConversation(incoming);
    return { configured: true, ...result };
  }

  const attachments = incoming[attachmentIndex].attachments ?? [];
  const batches = chunk(attachments, MAX_ATTACHMENTS_PER_BATCH);
  interface BatchResult {
    steps: ChatStep[];
    inserted: number;
    skippedDuplicates: number;
    rejected: number;
    failedBatches: number;
    pendingActions: PendingChange[];
  }

  async function processBatch(batchAttachments: ChatAttachment[]): Promise<BatchResult> {
    try {
      const result = await runConversation(
        withAttachments(incoming, attachmentIndex, batchAttachments),
        true,
      );
      const summary = summarizeSteps(result.steps);
      return {
        steps: result.steps,
        inserted: summary.inserted,
        skippedDuplicates: summary.skippedDuplicates,
        rejected: summary.rejected,
        failedBatches: 0,
        pendingActions: result.pendingActions ?? [],
      };
    } catch (err) {
      if (batchAttachments.length > 1 && isBatchableImageError(err)) {
        const splitPoint = Math.ceil(batchAttachments.length / 2);
        const left = await processBatch(batchAttachments.slice(0, splitPoint));
        const right = await processBatch(batchAttachments.slice(splitPoint));
        return {
          steps: [...left.steps, ...right.steps],
          inserted: left.inserted + right.inserted,
          skippedDuplicates: left.skippedDuplicates + right.skippedDuplicates,
          rejected: left.rejected + right.rejected,
          failedBatches: left.failedBatches + right.failedBatches,
          pendingActions: [...left.pendingActions, ...right.pendingActions],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        steps: [{ sql: "batch", rows: null, error: message }],
        inserted: 0,
        skippedDuplicates: 0,
        rejected: 0,
        failedBatches: 1,
        pendingActions: [],
      };
    }
  }

  const results: BatchResult[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(3, batches.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= batches.length) return;
      results[idx] = await processBatch(batches[idx]);
    }
  });
  await Promise.all(workers);

  const allSteps = results.flatMap((r) => r.steps);
  const totalInserted = results.reduce((n, r) => n + r.inserted, 0);
  const totalSkipped = results.reduce((n, r) => n + r.skippedDuplicates, 0);
  const totalRejected = results.reduce((n, r) => n + r.rejected, 0);
  const failedBatches = results.reduce((n, r) => n + r.failedBatches, 0);
  const pendingActions = results.flatMap((r) => r.pendingActions);

  if (pendingActions.length > 0) {
    return {
      configured: true,
      steps: allSteps,
      pendingActions,
      reply: `I prepared ${pendingActions.length} change${pendingActions.length === 1 ? "" : "s"} for approval.`,
    };
  }

  const reply =
    `Processed ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} in ${batches.length} batch${batches.length === 1 ? "" : "es"}. ` +
    `Saved ${totalInserted} row${totalInserted === 1 ? "" : "s"}, skipped ${totalSkipped} duplicate${totalSkipped === 1 ? "" : "s"}` +
    (totalRejected > 0 ? `, rejected ${totalRejected}` : "") +
    (failedBatches > 0 ? `, ${failedBatches} batch${failedBatches === 1 ? "" : "es"} failed` : "") +
    `.`;

  return { configured: true, steps: allSteps, reply };
}
