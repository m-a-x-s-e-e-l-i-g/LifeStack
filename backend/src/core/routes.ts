import type { FastifyInstance, FastifyReply } from "fastify";
import type { Connector, LifeStackModule, ModuleContext, Widget } from "./types";
import {
  allModules,
  buildModuleContext,
  connectorView,
  getConnector,
  getModule,
  isConnectorEnabled,
  isModuleEnabled,
  lastSync,
  runConnectorImport,
  runConnectorSync,
  setConnectorConfig,
  setConnectorEnabled,
  setModuleEnabled,
} from "./registry";

function meta(m: LifeStackModule) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    icon: m.icon,
    accent: m.accent,
  };
}

async function runWidget(ctx: ModuleContext, w: Widget) {
  const base = {
    id: w.id,
    title: w.title,
    subtitle: w.subtitle ?? null,
    type: w.type,
    size: w.size ?? "md",
  };
  try {
    return { ...base, data: await w.query(ctx), error: null };
  } catch (err) {
    return { ...base, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function notFound(reply: FastifyReply, what: string) {
  return reply.code(404).send({ error: `${what} not found` });
}

async function resolve(
  moduleId: string,
  connectorId: string,
  reply: FastifyReply,
): Promise<{ m: LifeStackModule; c: Connector } | null> {
  const m = getModule(moduleId);
  if (!m) {
    notFound(reply, "module");
    return null;
  }
  const c = getConnector(m, connectorId);
  if (!c) {
    notFound(reply, "connector");
    return null;
  }
  return { m, c };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true, service: "lifestack-backend" }));

  app.get("/api/modules", async () => {
    const out = [];
    for (const m of allModules()) {
      let enabledConnectors = 0;
      for (const c of m.connectors) {
        if (await isConnectorEnabled(m.id, c.id)) enabledConnectors++;
      }
      out.push({
        ...meta(m),
        enabled: await isModuleEnabled(m.id),
        connectorCount: m.connectors.length,
        enabledConnectors,
        hasApi: m.connectors.some((c) => c.kind === "api"),
        widgetCount: m.widgets.length,
        lastSync: await lastSync(m.id),
      });
    }
    return { modules: out };
  });

  app.get<{ Params: { id: string } }>("/api/modules/:id", async (req, reply) => {
    const m = getModule(req.params.id);
    if (!m) return notFound(reply, "module");
    const connectors = [];
    for (const c of m.connectors) connectors.push(await connectorView(m, c));
    return {
      ...meta(m),
      enabled: await isModuleEnabled(m.id),
      widgetCount: m.widgets.length,
      lastSync: await lastSync(m.id),
      connectors,
    };
  });

  app.get<{ Params: { id: string } }>("/api/modules/:id/stats", async (req, reply) => {
    const m = getModule(req.params.id);
    if (!m) return notFound(reply, "module");
    if (!(await isModuleEnabled(m.id)))
      return { module: meta(m), enabled: false, widgets: [] };
    const ctx = buildModuleContext(m);
    const widgets = [];
    for (const w of m.widgets) widgets.push(await runWidget(ctx, w));
    return { module: meta(m), enabled: true, widgets };
  });

  app.post<{ Params: { id: string } }>("/api/modules/:id/enable", async (req, reply) => {
    const m = getModule(req.params.id);
    if (!m) return notFound(reply, "module");
    await setModuleEnabled(m.id, true);
    return { ok: true, enabled: true };
  });

  app.post<{ Params: { id: string } }>("/api/modules/:id/disable", async (req, reply) => {
    const m = getModule(req.params.id);
    if (!m) return notFound(reply, "module");
    await setModuleEnabled(m.id, false);
    return { ok: true, enabled: false };
  });

  // Sync every enabled api connector of a module.
  app.post<{ Params: { id: string } }>("/api/modules/:id/sync", async (req, reply) => {
    const m = getModule(req.params.id);
    if (!m) return notFound(reply, "module");
    const results: Record<string, unknown> = {};
    for (const c of m.connectors) {
      if (!c.sync) continue;
      if (!(await isConnectorEnabled(m.id, c.id))) continue;
      try {
        results[c.id] = await runConnectorSync(m, c);
      } catch (err) {
        results[c.id] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { ok: true, results };
  });

  app.post<{ Params: { id: string; cid: string } }>(
    "/api/modules/:id/connectors/:cid/enable",
    async (req, reply) => {
      const r = await resolve(req.params.id, req.params.cid, reply);
      if (!r) return;
      await setConnectorEnabled(r.m.id, r.c.id, true);
      return { ok: true, enabled: true };
    },
  );

  app.post<{ Params: { id: string; cid: string } }>(
    "/api/modules/:id/connectors/:cid/disable",
    async (req, reply) => {
      const r = await resolve(req.params.id, req.params.cid, reply);
      if (!r) return;
      await setConnectorEnabled(r.m.id, r.c.id, false);
      return { ok: true, enabled: false };
    },
  );

  app.put<{
    Params: { id: string; cid: string };
    Body: { config?: Record<string, unknown> };
  }>("/api/modules/:id/connectors/:cid/config", async (req, reply) => {
    const r = await resolve(req.params.id, req.params.cid, reply);
    if (!r) return;
    await setConnectorConfig(r.m.id, r.c.id, req.body?.config ?? {});
    return { ok: true, connector: await connectorView(r.m, r.c) };
  });

  app.post<{ Params: { id: string; cid: string } }>(
    "/api/modules/:id/connectors/:cid/sync",
    async (req, reply) => {
      const r = await resolve(req.params.id, req.params.cid, reply);
      if (!r) return;
      if (!r.c.sync) return reply.code(400).send({ error: "connector has no sync" });
      try {
        return { ok: true, ...(await runConnectorSync(r.m, r.c)) };
      } catch (err) {
        return reply
          .code(502)
          .send({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post<{
    Params: { id: string; cid: string };
    Body: { rows?: unknown[] };
  }>("/api/modules/:id/connectors/:cid/import", async (req, reply) => {
    const r = await resolve(req.params.id, req.params.cid, reply);
    if (!r) return;
    if (!r.c.import) return reply.code(400).send({ error: "connector has no import" });
    const rows = Array.isArray(req.body?.rows) ? req.body!.rows : [];
    return { ok: true, ...(await runConnectorImport(r.m, r.c, rows)) };
  });

  app.get("/api/overview", async () => {
    const modules = [];
    const featured = [];
    for (const m of allModules()) {
      const enabled = await isModuleEnabled(m.id);
      modules.push({ ...meta(m), enabled, lastSync: await lastSync(m.id) });
      if (!enabled) continue;
      const ctx = buildModuleContext(m);
      for (const w of m.widgets.filter((x) => x.featured)) {
        featured.push({ ...meta(m), widget: await runWidget(ctx, w) });
      }
    }
    return { modules, featured };
  });
}
