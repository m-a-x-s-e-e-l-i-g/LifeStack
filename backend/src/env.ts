export const env = {
  CLICKHOUSE_URL: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  CLICKHOUSE_DB: process.env.CLICKHOUSE_DB ?? "lifestack",
  CLICKHOUSE_USER: process.env.CLICKHOUSE_USER ?? "lifestack",
  CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD ?? "lifestack",
  PORT: Number(process.env.BACKEND_PORT ?? 4000),
  BACKEND_BODY_LIMIT_MB: Math.max(1, Number(process.env.BACKEND_BODY_LIMIT_MB ?? 400)),
  LOG_LEVEL: (process.env.LOG_LEVEL ?? "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",
  // AI assistant (OpenAI-compatible). These are fallbacks; runtime config
  // stored via the API (Settings) takes precedence.
  AI_BASE_URL: process.env.AI_BASE_URL ?? "",
  AI_API_KEY: process.env.AI_API_KEY ?? "",
  AI_MODEL: process.env.AI_MODEL ?? "",
};
