import { getMeta, setMeta } from "../db";
import { logger } from "../logger";
import { allModules, buildModuleContext, isModuleEnabled } from "./registry";

/** Seed synthetic demo data once, so a fresh install is a populated dashboard. */
export async function seedDemoIfNeeded(): Promise<void> {
  if (await getMeta("demo_seeded")) return;
  logger.info("seeding demo data (SEED_DEMO=true, first boot)");
  for (const m of allModules()) {
    if (!m.seed) continue;
    if (!(await isModuleEnabled(m.id))) continue;
    try {
      await m.seed(buildModuleContext(m));
      logger.child(m.id).info("demo data seeded");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.child(m.id).error(`seed failed: ${message}`);
    }
  }
  await setMeta("demo_seeded", new Date().toISOString());
}
