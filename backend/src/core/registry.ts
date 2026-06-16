import { applyModuleMigrations, query } from "../db";
import { logger } from "../logger";
import { modules } from "../modules";
import type {
  Connector,
  ConfigField,
  LifeStackModule,
  ModuleContext,
  SyncResult,
} from "./types";

const byId = new Map<string, LifeStackModule>(modules.map((m) => [m.id, m]));

export function allModules(): LifeStackModule[] {
  return modules;
}

export function getModule(id: string): LifeStackModule | undefined {
  return byId.get(id);
}

export function getConnector(
  m: LifeStackModule,
  connectorId: string,
): Connector | undefined {
  return m.connectors.find((c) => c.id === connectorId);
}

export async function isModuleEnabled(id: string): Promise<boolean> {
  const { rows } = await query<{ enabled: boolean }>(
    "SELECT enabled FROM module_state WHERE id = $1",
    [id],
  );
  return rows[0]?.enabled ?? true;
}

interface ConnectorStateRow {
  enabled: boolean;
  config: Record<string, unknown>;
}

async function connectorState(
  moduleId: string,
  connectorId: string,
): Promise<ConnectorStateRow> {
  const { rows } = await query<ConnectorStateRow>(
    "SELECT enabled, config FROM connector_state WHERE module_id = $1 AND connector_id = $2",
    [moduleId, connectorId],
  );
  return rows[0] ?? { enabled: false, config: {} };
}

export async function isConnectorEnabled(
  moduleId: string,
  connectorId: string,
): Promise<boolean> {
  return (await connectorState(moduleId, connectorId)).enabled;
}

/** True when every env-backed field of an api connector has its env var set. */
function envSatisfied(c: Connector): boolean {
  const envFields = (c.configSchema ?? []).filter((f) => f.env);
  return envFields.length > 0 && envFields.every((f) => !!process.env[f.env!]);
}

/** Merge field defaults, env fallbacks, and stored overrides into a usable config. */
export async function resolveConnectorConfig(
  m: LifeStackModule,
  c: Connector,
): Promise<Record<string, unknown>> {
  const { config: stored } = await connectorState(m.id, c.id);
  const out: Record<string, unknown> = {};
  for (const f of c.configSchema ?? []) {
    if (f.default !== undefined) out[f.key] = f.default;
    if (f.env && process.env[f.env]) out[f.key] = process.env[f.env];
    const s = stored[f.key];
    if (s !== undefined && s !== null && s !== "") out[f.key] = s;
  }
  return { ...stored, ...out };
}

export function buildModuleContext(m: LifeStackModule): ModuleContext {
  return { db: { query }, config: {}, logger: logger.child(m.id), now: new Date() };
}

export async function buildConnectorContext(
  m: LifeStackModule,
  c: Connector,
): Promise<ModuleContext> {
  return {
    db: { query },
    config: await resolveConnectorConfig(m, c),
    logger: logger.child(`${m.id}:${c.id}`),
    now: new Date(),
  };
}

/** Ensure state rows exist and run migrations. Modules default enabled; api connectors
 *  default enabled only when their env credentials are present. */
export async function initModules(): Promise<void> {
  for (const m of modules) {
    await query(
      "INSERT INTO module_state (id, enabled) VALUES ($1, true) ON CONFLICT (id) DO NOTHING",
      [m.id],
    );
    for (const c of m.connectors) {
      const defaultEnabled = c.kind === "api" ? envSatisfied(c) : true;
      await query(
        `INSERT INTO connector_state (module_id, connector_id, enabled)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [m.id, c.id, defaultEnabled],
      );
    }
    const applied = await applyModuleMigrations(m.id, m.migrations);
    if (applied > 0) logger.info(`module ${m.id}: applied ${applied} migration(s)`);
  }
}

export async function setModuleEnabled(id: string, enabled: boolean): Promise<void> {
  await query(
    "UPDATE module_state SET enabled = $2, updated_at = now() WHERE id = $1",
    [id, enabled],
  );
}

export async function setConnectorEnabled(
  moduleId: string,
  connectorId: string,
  enabled: boolean,
): Promise<void> {
  await query(
    `UPDATE connector_state SET enabled = $3, updated_at = now()
     WHERE module_id = $1 AND connector_id = $2`,
    [moduleId, connectorId, enabled],
  );
}

export async function setConnectorConfig(
  moduleId: string,
  connectorId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const current = (await connectorState(moduleId, connectorId)).config;
  const merged = { ...current, ...patch };
  await query(
    `UPDATE connector_state SET config = $3, updated_at = now()
     WHERE module_id = $1 AND connector_id = $2`,
    [moduleId, connectorId, JSON.stringify(merged)],
  );
}

export async function lastSync(
  moduleId: string,
  connectorId?: string,
): Promise<{ at: string | null; status: string | null; message: string | null }> {
  const { rows } = await query<{
    finished_at: string | null;
    status: string;
    message: string | null;
  }>(
    `SELECT finished_at, status, message FROM sync_log
     WHERE module_id = $1 AND ($2::text IS NULL OR connector_id = $2)
     ORDER BY id DESC LIMIT 1`,
    [moduleId, connectorId ?? null],
  );
  const r = rows[0];
  return {
    at: r?.finished_at ?? null,
    status: r?.status ?? null,
    message: r?.message ?? null,
  };
}

/** Run a connector's sync, recording a sync_log entry. */
export async function runConnectorSync(
  m: LifeStackModule,
  c: Connector,
): Promise<SyncResult> {
  if (!c.sync) return { message: "connector has no sync" };
  const { rows } = await query<{ id: number }>(
    "INSERT INTO sync_log (module_id, connector_id, status) VALUES ($1, $2, 'running') RETURNING id",
    [m.id, c.id],
  );
  const logId = rows[0].id;
  try {
    const ctx = await buildConnectorContext(m, c);
    const result = await c.sync(ctx);
    await query(
      `UPDATE sync_log SET finished_at = now(), status = 'ok', inserted = $2, message = $3 WHERE id = $1`,
      [logId, result.inserted ?? 0, result.message ?? null],
    );
    logger.child(`${m.id}:${c.id}`).info(`sync ok (${result.inserted ?? 0} inserted)`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE sync_log SET finished_at = now(), status = 'error', message = $2 WHERE id = $1`,
      [logId, message],
    );
    logger.child(`${m.id}:${c.id}`).error(`sync failed: ${message}`);
    throw err;
  }
}

/** Run a connector's import handler, recording a sync_log entry. */
export async function runConnectorImport(
  m: LifeStackModule,
  c: Connector,
  rows: unknown[],
): Promise<SyncResult> {
  if (!c.import) return { message: "connector has no import" };
  const ctx = await buildConnectorContext(m, c);
  const result = await c.import(ctx, rows);
  await query(
    "INSERT INTO sync_log (module_id, connector_id, status, finished_at, inserted, message) VALUES ($1, $2, 'ok', now(), $3, $4)",
    [m.id, c.id, result.inserted ?? 0, result.message ?? `imported ${result.inserted ?? 0}`],
  );
  return result;
}

/** Public, secret-masked view of a connector's config schema with current values. */
export async function configView(m: LifeStackModule, c: Connector) {
  const resolved = await resolveConnectorConfig(m, c);
  return (c.configSchema ?? []).map((f: ConfigField) => {
    const value = resolved[f.key];
    const hasValue = value !== undefined && value !== null && value !== "";
    return {
      key: f.key,
      label: f.label,
      type: f.type,
      help: f.help ?? null,
      secret: !!f.secret,
      hasValue,
      value: f.secret ? undefined : (value ?? f.default ?? ""),
    };
  });
}

/** Public view of a connector, including state and last sync. */
export async function connectorView(m: LifeStackModule, c: Connector) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    kind: c.kind,
    enabled: await isConnectorEnabled(m.id, c.id),
    hasSync: !!c.sync,
    hasImport: !!c.import,
    syncIntervalMinutes: c.syncIntervalMinutes ?? null,
    config: await configView(m, c),
    lastSync: await lastSync(m.id, c.id),
  };
}
