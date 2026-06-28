import { logger } from "../logger";
import {
  allModules,
  getConnector,
  getModule,
  isConnectorEnabled,
  isModuleEnabled,
  moduleConnectors,
  runConnectorSync,
} from "./registry";

const timers = new Map<string, NodeJS.Timeout>();
const running = new Set<string>();

function scheduleConnector(
  moduleId: string,
  connectorId: string,
  syncIntervalMinutes: number,
  initialDelayMs = 0,
): void {
  const key = `${moduleId}:${connectorId}`;
  if (timers.has(key)) return;
  const ms = syncIntervalMinutes * 60_000;
  const timer = setInterval(() => {
    void tick(moduleId, connectorId);
  }, ms);
  timer.unref?.();
  timers.set(key, timer);
  logger.info(`scheduled ${moduleId}:${connectorId} sync every ${syncIntervalMinutes}m`);
  // Initial catch-up so data appears without waiting a full interval.
  triggerSync(moduleId, connectorId, initialDelayMs);
}

export async function ensureConnectorScheduled(
  moduleId: string,
  connectorId: string,
): Promise<void> {
  const m = getModule(moduleId);
  if (!m) return;
  const c = await getConnector(m, connectorId);
  if (!c?.sync || !c.syncIntervalMinutes) return;
  scheduleConnector(moduleId, connectorId, c.syncIntervalMinutes);
}

export function startScheduler(): void {
  void (async () => {
    let stagger = 3000;
    for (const m of allModules()) {
      const connectors = await moduleConnectors(m);
      for (const c of connectors) {
        if (!c.sync || !c.syncIntervalMinutes) continue;
        scheduleConnector(m.id, c.id, c.syncIntervalMinutes, stagger);
        stagger += 4000;
      }
    }
  })();
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
  const m = getModule(moduleId);
  const c = m ? await getConnector(m, connectorId) : undefined;
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
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}
