import { applyModuleMigrations, command, insert, query } from "../db";
import { logger } from "../logger";
import { modules } from "../modules";
import type {
  Connector,
  ConfigField,
  ConnectorContext,
  LifeStackModule,
  ModuleContext,
  SyncResult,
} from "./types";

const byId = new Map<string, LifeStackModule>(modules.map((m) => [m.id, m]));

const db = { query, insert, command };

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
  const rows = await query<{ enabled: number }>(
    "SELECT enabled FROM module_state FINAL WHERE id = {id:String} LIMIT 1",
    { id },
  );
  return (rows[0]?.enabled ?? 1) === 1;
}

interface ConnectorStateRow {
  enabled: boolean;
  config: Record<string, unknown>;
}

async function connectorState(
  moduleId: string,
  connectorId: string,
): Promise<ConnectorStateRow> {
  const rows = await query<{ enabled: number; config: string }>(
    `SELECT enabled, config FROM connector_state FINAL
     WHERE module_id = {m:String} AND connector_id = {c:String} LIMIT 1`,
    { m: moduleId, c: connectorId },
  );
  const r = rows[0];
  if (!r) return { enabled: false, config: {} };
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(r.config || "{}");
  } catch {
    config = {};
  }
  return { enabled: r.enabled === 1, config };
}

export async function isConnectorEnabled(
  moduleId: string,
  connectorId: string,
): Promise<boolean> {
  return (await connectorState(moduleId, connectorId)).enabled;
}

/** True when every required env-backed field of an api connector has its env var set. */
function envSatisfied(c: Connector): boolean {
  const envFields = (c.configSchema ?? []).filter((f) => f.env && !f.optional);
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
  return { db, config: {}, logger: logger.child(m.id), now: new Date() };
}

export async function buildConnectorContext(
  m: LifeStackModule,
  c: Connector,
): Promise<ConnectorContext> {
  return {
    db,
    config: await resolveConnectorConfig(m, c),
    logger: logger.child(`${m.id}:${c.id}`),
    now: new Date(),
    saveConfig: (patch) => setConnectorConfig(m.id, c.id, patch),
  };
}

async function rowExists(sql: string, params: Record<string, unknown>): Promise<boolean> {
  const rows = await query<{ c: number }>(sql, params);
  return (rows[0]?.c ?? 0) > 0;
}

/** Ensure state rows exist and run migrations. Modules default enabled; api connectors
 *  default enabled only when their env credentials are present. */
export async function initModules(): Promise<void> {
  for (const m of modules) {
    if (
      !(await rowExists(
        "SELECT count() AS c FROM module_state FINAL WHERE id = {id:String}",
        { id: m.id },
      ))
    ) {
      await insert("module_state", [{ id: m.id, enabled: 1 }]);
    }
    for (const c of m.connectors) {
      const exists = await rowExists(
        `SELECT count() AS c FROM connector_state FINAL
         WHERE module_id = {m:String} AND connector_id = {c:String}`,
        { m: m.id, c: c.id },
      );
      if (!exists) {
        const defaultEnabled = c.kind === "api" ? envSatisfied(c) : true;
        await insert("connector_state", [
          { module_id: m.id, connector_id: c.id, enabled: defaultEnabled ? 1 : 0, config: "{}" },
        ]);
      }
    }
    const applied = await applyModuleMigrations(m.id, m.migrations);
    if (applied > 0) logger.info(`module ${m.id}: applied ${applied} migration(s)`);
  }
}

export async function setModuleEnabled(id: string, enabled: boolean): Promise<void> {
  await insert("module_state", [
    { id, enabled: enabled ? 1 : 0, updated_at: new Date().toISOString() },
  ]);
}

export async function setConnectorEnabled(
  moduleId: string,
  connectorId: string,
  enabled: boolean,
): Promise<void> {
  const { config } = await connectorState(moduleId, connectorId);
  await insert("connector_state", [
    {
      module_id: moduleId,
      connector_id: connectorId,
      enabled: enabled ? 1 : 0,
      config: JSON.stringify(config),
      updated_at: new Date().toISOString(),
    },
  ]);
}

export async function setConnectorConfig(
  moduleId: string,
  connectorId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { enabled, config } = await connectorState(moduleId, connectorId);
  const merged = { ...config, ...patch };
  await insert("connector_state", [
    {
      module_id: moduleId,
      connector_id: connectorId,
      enabled: enabled ? 1 : 0,
      config: JSON.stringify(merged),
      updated_at: new Date().toISOString(),
    },
  ]);
}

export async function lastSync(
  moduleId: string,
  connectorId?: string,
): Promise<{ at: string | null; status: string | null; message: string | null }> {
  const params: Record<string, unknown> = { m: moduleId };
  let filter = "module_id = {m:String}";
  if (connectorId) {
    filter += " AND connector_id = {c:String}";
    params.c = connectorId;
  }
  const rows = await query<{ finished_at: string; status: string; message: string }>(
    `SELECT formatDateTime(finished_at, '%Y-%m-%dT%H:%i:%SZ') AS finished_at, status, message
     FROM sync_log WHERE ${filter} ORDER BY finished_at DESC LIMIT 1`,
    params,
  );
  const r = rows[0];
  return {
    at: r?.finished_at ?? null,
    status: r?.status ?? null,
    message: r?.message ?? null,
  };
}

async function recordSync(
  moduleId: string,
  connectorId: string,
  status: string,
  startedAt: Date,
  inserted: number,
  message: string | null,
): Promise<void> {
  await insert("sync_log", [
    {
      module_id: moduleId,
      connector_id: connectorId,
      status,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      inserted,
      message: message ?? "",
    },
  ]);
}

/** Run a connector's sync, recording a sync_log entry. */
export async function runConnectorSync(
  m: LifeStackModule,
  c: Connector,
): Promise<SyncResult> {
  if (!c.sync) return { message: "connector has no sync" };
  const startedAt = new Date();
  try {
    const ctx = await buildConnectorContext(m, c);
    const result = await c.sync(ctx);
    await recordSync(m.id, c.id, "ok", startedAt, result.inserted ?? 0, result.message ?? null);
    logger.child(`${m.id}:${c.id}`).info(`sync ok (${result.inserted ?? 0} inserted)`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSync(m.id, c.id, "error", startedAt, 0, message);
    logger.child(`${m.id}:${c.id}`).error(`sync failed: ${message}`);
    throw err;
  }
}

/** Run a connector's explicit authorize step (e.g. OAuth PIN exchange). */
export async function runConnectorAuthorize(
  m: LifeStackModule,
  c: Connector,
  input: Record<string, unknown>,
): Promise<SyncResult> {
  if (!c.authorize) return { message: "connector has no authorize" };
  const ctx = await buildConnectorContext(m, c);
  return c.authorize(ctx, input);
}

/** Run a connector's import handler, recording a sync_log entry. */
export async function runConnectorImport(
  m: LifeStackModule,
  c: Connector,
  rows: unknown[],
): Promise<SyncResult> {
  if (!c.import) return { message: "connector has no import" };
  const startedAt = new Date();
  const ctx = await buildConnectorContext(m, c);
  const result = await c.import(ctx, rows);
  await recordSync(
    m.id,
    c.id,
    "ok",
    startedAt,
    result.inserted ?? 0,
    result.message ?? `imported ${result.inserted ?? 0}`,
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
    icon: c.icon ?? null,
    enabled: await isConnectorEnabled(m.id, c.id),
    hasSync: !!c.sync,
    hasAuthorize: !!c.authorize,
    hasImport: !!c.import,
    syncIntervalMinutes: c.syncIntervalMinutes ?? null,
    config: await configView(m, c),
    lastSync: await lastSync(m.id, c.id),
  };
}
