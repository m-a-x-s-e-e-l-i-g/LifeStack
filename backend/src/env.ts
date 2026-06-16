export const env = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://lifestack:lifestack@localhost:5432/lifestack",
  PORT: Number(process.env.BACKEND_PORT ?? 4000),
  LOG_LEVEL: (process.env.LOG_LEVEL ?? "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",
  SEED_DEMO: (process.env.SEED_DEMO ?? "true").toLowerCase() !== "false",
};
