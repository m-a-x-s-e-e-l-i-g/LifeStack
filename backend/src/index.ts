import cors from "@fastify/cors";
import Fastify from "fastify";
import { runCoreMigrations, waitForDb } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { registerRoutes } from "./core/routes";
import { initModules } from "./core/registry";
import { startScheduler } from "./core/scheduler";

async function main(): Promise<void> {
  logger.info("LifeStack backend starting");
  await waitForDb();
  await runCoreMigrations();
  await initModules();

  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });
  await app.register(cors, { origin: true });
  await registerRoutes(app);
  startScheduler();

  await app.listen({ host: "0.0.0.0", port: env.PORT });
  logger.info(`backend listening on http://0.0.0.0:${env.PORT}`);
}

main().catch((err) => {
  logger.error(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
