import { client, getMeta, setMeta } from "../db";
import { env } from "../env";
import { logger } from "../logger";

/**
 * Chat-first assistant. Provider agnostic: talks to any OpenAI-compatible
 * /chat/completions endpoint (OpenAI, Ollama /v1, LM Studio, vLLM, ...).
 * The model answers questions about the user's data through a single
 * read-only SQL tool over ClickHouse, plus a schema description in the prompt.
 */

const log = logger.child("ai");

const CORE_TABLES = new Set([
  "meta",
  "module_state",
  "connector_state",
  "schema_migrations",
  "sync_log",
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

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
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
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

async function callModel(
  cfg: AiConfig,
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
      model: cfg.model,
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
];

function systemPrompt(schema: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the analyst inside LifeStack, a self-hosted personal statistics app. You answer questions about the user's own data by querying a ClickHouse database with the run_sql tool.

Today is ${today} (UTC).

Data tables (ClickHouse):
${schema}

Rules:
- To get any number, call run_sql. Never invent values; if a query returns no rows, say the data is not there yet.
- ClickHouse dialect: use today(), now(), toStartOfMonth(x), toYYYYMM(x), formatDateTime(x, '%b'), countIf(cond), sumIf(x, cond), uniqExact(x), arrayJoin(arr). Date math uses INTERVAL, e.g. today() - INTERVAL 12 MONTH.
- Tables holding deduplicated entities use ReplacingMergeTree; add FINAL after the table name (e.g. FROM watch_history FINAL) so re-synced rows are not double counted.
- Keep queries focused and always include a LIMIT for row listings.
- Reply in concise prose. Lead with the answer and the key number. Do not show SQL unless asked; the app already displays the queries you ran.`;
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

  const schema = await schemaSummary();
  const convo: unknown[] = [
    { role: "system", content: systemPrompt(schema) },
    ...incoming
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content ?? "" })),
  ];

  const steps: ChatStep[] = [];

  for (let i = 0; i < 6; i++) {
    const msg = await callModel(cfg, convo, TOOLS);
    convo.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      return { reply: msg.content ?? "", steps, configured: true };
    }
    for (const call of calls) {
      let content: string;
      let stepSql = "";
      let stepRows: Record<string, unknown>[] | null = null;
      let stepError: string | null = null;
      try {
        const args = JSON.parse(call.function.arguments || "{}") as { sql?: string };
        stepSql = String(args.sql ?? "");
        const out = await runReadonlySql(stepSql);
        stepRows = out.rows;
        content = JSON.stringify({ rowCount: out.rows.length, rows: out.rows.slice(0, 50) });
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
    configured: true,
    steps,
    reply:
      "I ran several queries but could not settle on an answer. Try asking something more specific.",
  };
}
