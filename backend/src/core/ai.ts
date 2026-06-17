import { createHash } from "node:crypto";
import { client, command, getMeta, insert, query, setMeta } from "../db";
import { env } from "../env";
import { logger } from "../logger";

/**
 * Chat-first assistant. Provider agnostic: talks to any OpenAI-compatible
 * /chat/completions endpoint (OpenAI, Ollama /v1, LM Studio, vLLM, ...).
 *
 * It can read data via SQL and, when explicitly requested by the user, ingest
 * structured records into local tables (for example from screenshots).
 */

const log = logger.child("ai");

const CORE_TABLES = new Set([
  "meta",
  "module_state",
  "connector_state",
  "schema_migrations",
  "sync_log",
  "ai_ingest_dedupe",
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
  return [...byTable.entries()]
    .map(([t, c]) => `${t}(${c.join(", ")})`)
    .join("\n");
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

function normalizeRideType(rawType: unknown, provider: string): string {
  const t = String(rawType ?? "").trim().toLowerCase();
  const p = provider.toLowerCase();
  if (p.includes("lime") || p.includes("tier") || p.includes("bird") || t.includes("scooter"))
    return "scooter";
  if (p.includes("uber") || p.includes("bolt") || p.includes("lyft")) return "taxi";
  if (t.includes("bike") || t.includes("bicycle") || t.includes("cycle")) return "bike";
  if (t.includes("taxi") || t.includes("cab") || t.includes("car") || t.includes("ride"))
    return "taxi";
  return t || "ride";
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
  if (target === "mobility_ride") {
    const provider = normalizeProviderName(raw.provider ?? raw.app ?? raw.service);
    return {
      day: day(raw.day ?? raw.date),
      provider,
      type: normalizeRideType(raw.type ?? raw.vehicle, provider),
      distance_km: num(raw.distance_km ?? raw.distance ?? raw.km),
      duration_min: int(raw.duration_min ?? raw.duration ?? raw.minutes),
      cost: num(raw.cost ?? raw.amount ?? raw.price),
    };
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
): Promise<Record<string, unknown>> {
  if (!Array.isArray(rowsInput)) throw new Error("rows must be an array");
  const normalized: Record<string, unknown>[] = [];
  let rejected = 0;

  for (const raw of rowsInput) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      rejected++;
      continue;
    }
    normalized.push(normalizeRow(target, raw as Record<string, unknown>));
  }

  if (normalized.length === 0) {
    return {
      target,
      inserted: 0,
      skippedDuplicates: 0,
      rejected,
      message: "No valid rows were provided.",
    };
  }

  const hashes = normalized.map((r) => stableHash(target, r));
  const seenRows = await query<{ hash: string }>(
    `SELECT hash FROM ai_ingest_dedupe FINAL
     WHERE target = {target:String} AND hash IN {hashes:Array(String)}`,
    { target, hashes },
  );
  const seen = new Set(seenRows.map((r) => r.hash));

  const toInsert: Record<string, unknown>[] = [];
  const dedupeRows: Record<string, unknown>[] = [];
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
      target,
      hash,
      payload: JSON.stringify(row),
      created_at: new Date().toISOString(),
    });
  }

  if (toInsert.length > 0) {
    await insert(target, toInsert);
    await insert("ai_ingest_dedupe", dedupeRows);
  }

  return {
    target,
    inserted: toInsert.length,
    skippedDuplicates,
    rejected,
    message: `Saved ${toInsert.length} row(s) to ${target}; skipped ${skippedDuplicates} duplicate(s).`,
  };
}

const DELETE_COLUMNS: Record<WriteTarget, string[]> = {
  mobility_ride: ["day", "provider", "type", "distance_km", "duration_min", "cost"],
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
        "Insert structured records into a local LifeStack table. Use this only when the user explicitly asks to save/import data (for example from screenshots).",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: [
              "mobility_ride",
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
];

const MAX_ATTACHMENTS_PER_BATCH = 5;

function systemPrompt(schema: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the analyst inside LifeStack, a self-hosted personal statistics app. You can answer questions and, when the user asks to import data, save structured records.

Today is ${today} (UTC).

Data tables (ClickHouse):
${schema}

Rules:
- To get any number, call run_sql. Never invent values; if a query returns no rows, say the data is not there yet.
- For screenshot imports, extract structured entries and call write_records with the correct target table and rows.
- Food delivery screenshots (Uber Eats, takeaway.com, thuisbezorgd) should be written to food_order.
- Mobility screenshots should normalize provider names (Uber, Bolt, Lime, Tier, Bird, Lyft) and set type to taxi, scooter, or bike.
- Only modify data when the user explicitly asks, use write_records to add rows and delete_records to remove rows.
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

function toUserContent(m: ChatMessage): unknown {
  const images = (m.attachments ?? []).filter(
    (a) => typeof a.dataUrl === "string" && /^data:image\//.test(a.dataUrl),
  );
  if (images.length === 0) return m.content ?? "";
  const parts: Array<Record<string, unknown>> = [];
  if (m.content?.trim()) parts.push({ type: "text", text: m.content.trim() });
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }
  if (parts.length === 0) parts.push({ type: "text", text: "Analyze this screenshot." });
  return parts;
}

export async function chat(
  incoming: ChatMessage[],
): Promise<{ reply: string; steps: ChatStep[]; configured: boolean }> {
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
  ): Promise<{ reply: string; steps: ChatStep[] }> {
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
    const hasImages = messages.some(
      (m) => m.role === "user" && Array.isArray(m.attachments) && m.attachments.length > 0,
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
              "Your current model endpoint rejected the screenshot. Switch to a vision-capable OpenAI-compatible model in Settings, then upload again.",
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
          };
          if (call.function.name === "run_sql") {
            stepSql = String(args.sql ?? "");
            const out = await runReadonlySql(stepSql);
            stepRows = out.rows;
            content = JSON.stringify({ rowCount: out.rows.length, rows: out.rows.slice(0, 50) });
          } else if (call.function.name === "write_records") {
            const target = String(args.target ?? "") as WriteTarget;
            if (
              ![
                "mobility_ride",
                "finance_tx",
                "fuel_fillup",
                "energy_reading",
                "food_order",
              ].includes(target)
            ) {
              throw new Error("Unsupported write target");
            }
            const result = await writeRecords(target, Array.isArray(args.rows) ? args.rows : []);
            stepSql = `write_records(${target})`;
            stepRows = [result];
            content = JSON.stringify(result);
          } else if (call.function.name === "delete_records") {
            const target = String(args.target ?? "") as WriteTarget;
            if (
              ![
                "mobility_ride",
                "finance_tx",
                "fuel_fillup",
                "energy_reading",
                "food_order",
              ].includes(target)
            ) {
              throw new Error("Unsupported delete target");
            }
            const result = await deleteRecords(target, args.where);
            stepSql = `delete_records(${target})`;
            stepRows = [result];
            content = JSON.stringify(result);
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
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        steps: [{ sql: "batch", rows: null, error: message }],
        inserted: 0,
        skippedDuplicates: 0,
        rejected: 0,
        failedBatches: 1,
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

  const reply =
    `Processed ${attachments.length} screenshots in ${batches.length} batch${batches.length === 1 ? "" : "es"}. ` +
    `Saved ${totalInserted} row${totalInserted === 1 ? "" : "s"}, skipped ${totalSkipped} duplicate${totalSkipped === 1 ? "" : "s"}` +
    (totalRejected > 0 ? `, rejected ${totalRejected}` : "") +
    (failedBatches > 0 ? `, ${failedBatches} batch${failedBatches === 1 ? "" : "es"} failed` : "") +
    `.`;

  return { configured: true, steps: allSteps, reply };
}
