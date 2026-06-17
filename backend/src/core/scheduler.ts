import { logger } from "../logger";
import {
  allModules,
  isConnectorEnabled,
  isModuleEnabled,
  runConnectorSync,
} from "./registry";

const timers: NodeJS.Timeout[] = [];
const running = new Set<string>();

export function startScheduler(): void {
  let stagger = 3000;
  for (const m of allModules()) {
    for (const c of m.connectors) {
      if (!c.sync || !c.syncIntervalMinutes) continue;
      const ms = c.syncIntervalMinutes * 60_000;
      const timer = setInterval(() => {
        void tick(m.id, c.id);
      }, ms);
      timer.unref?.();
      timers.push(timer);
      logger.info(`scheduled ${m.id}:${c.id} sync every ${c.syncIntervalMinutes}m`);
      // Initial catch-up so data appears without waiting a full interval.
      triggerSync(m.id, c.id, stagger);
      stagger += 4000;
    }
  }
}

/**
 * Fire a sync in the background after an optional delay. Safe to call freely:
 * it no-ops when the module or connector is disabled or a sync is already
 * running. Used by routes to sync right after a connector is enabled or
 * authorized, so the user never has to trigger it by hand.
 */
export function triggerSync(moduleId: string, connectorId: string, delayMs = 0): void {
  const t = setTimeout(() => void tick(moduleId, connectorId), delayMs);
  t.unref?.();
}

async function tick(moduleId: string, connectorId: string): Promise<void> {
  const key = `${moduleId}:${connectorId}`;
  if (running.has(key)) return;
  if (!(await isModuleEnabled(moduleId))) return;
  if (!(await isConnectorEnabled(moduleId, connectorId))) return;
  const m = allModules().find((x) => x.id === moduleId);
  const c = m?.connectors.find((x) => x.id === connectorId);
  if (!m || !c) return;
  running.add(key);
  try {
    await runConnectorSync(m, c);
  } catch {
    // runConnectorSync already logged and recorded the failure.
  } finally {
    running.delete(key);
  }
}

export function stopScheduler(): void {
  timers.forEach(clearInterval);
  timers.length = 0;
}
