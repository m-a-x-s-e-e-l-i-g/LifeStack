import type { FastifyInstance, FastifyReply } from "fastify";
import { command } from "../db";
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
  runConnectorSync,
  runConnectorAuthorize,
  setConnectorConfig,
  setConnectorEnabled,
  setModuleEnabled,
} from "./registry";
import { aiStatus, applyPendingChange, chat, setAiConfig, type ChatMessage, type PendingChange } from "./ai";
import { triggerSync } from "./scheduler";

function lit(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const s = String(value ?? "").replace(/'/g, "''");
  return `'${s}'`;
}

const EUR_PER_UNIT: Record<string, number> = {
  EUR: 1,
  CZK: 0.0402,
  USD: 0.93,
  GBP: 1.18,
  PLN: 0.235,
  CHF: 1.04,
  SEK: 0.086,
  NOK: 0.086,
  DKK: 0.134,
  HUF: 0.0025,
};

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
      // Sync straight away so stats populate without a manual trigger.
      if (r.c.sync) triggerSync(r.m.id, r.c.id);
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
    Body: Record<string, unknown>;
  }>("/api/modules/:id/connectors/:cid/authorize", async (req, reply) => {
    const r = await resolve(req.params.id, req.params.cid, reply);
    if (!r) return;
    if (!r.c.authorize) return reply.code(400).send({ error: "connector has no authorize" });
    try {
      const result = await runConnectorAuthorize(r.m, r.c, req.body ?? {});
      // A successful connect means we have a token; sync right away.
      if (r.c.sync && !req.body?.disconnect) triggerSync(r.m.id, r.c.id, 500);
      return { ok: true, ...result, connector: await connectorView(r.m, r.c) };
    } catch (err) {
      return reply
        .code(502)
        .send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
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

  // ----- AI assistant (chat-first) -----------------------------------------

  app.get("/api/ai/status", async () => aiStatus());

  app.put<{ Body: { baseUrl?: string; apiKey?: string; model?: string } }>(
    "/api/ai/config",
    async (req) => {
      await setAiConfig(req.body ?? {});
      return { ok: true, status: await aiStatus() };
    },
  );

  app.post<{ Body: { messages?: ChatMessage[] } }>("/api/chat", async (req, reply) => {
    const messages = Array.isArray(req.body?.messages) ? req.body!.messages : [];
    if (messages.length === 0)
      return reply.code(400).send({ error: "messages array is required" });
    try {
      return await chat(messages);
    } catch (err) {
      return reply
        .code(502)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Body: { change?: PendingChange } }>("/api/chat/approve", async (req, reply) => {
    const change = req.body?.change;
    if (!change) return reply.code(400).send({ error: "change is required" });
    try {
      return { ok: true, result: await applyPendingChange(change) };
    } catch (err) {
      return reply
        .code(502)
        .send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put<{
    Body: {
      original?: {
        day?: string;
        started_at?: string;
        provider?: string;
        type?: string;
        distance_km?: number;
        duration_min?: number;
        cost?: number;
        cost_currency?: string;
      };
      patch?: {
        day?: string;
        started_at?: string;
        provider?: string;
        type?: string;
        distance_km?: number;
        duration_min?: number;
        cost?: number;
        cost_currency?: string;
      };
    };
  }>("/api/modules/mobility/rides/update", async (req, reply) => {
    const original = req.body?.original;
    const patch = req.body?.patch;
    if (!original || !patch) {
      return reply.code(400).send({ ok: false, error: "original and patch are required" });
    }
    const keys: Array<keyof typeof patch> = [
      "day",
      "started_at",
      "provider",
      "type",
      "distance_km",
      "duration_min",
      "cost",
      "cost_currency",
    ];
    const setClauses: string[] = [];
    let nextCost = Number(original.cost ?? 0);
    let nextCurrency = String(original.cost_currency ?? "EUR").toUpperCase();
    for (const key of keys) {
      const v = patch[key];
      if (v === undefined || v === null || v === "") continue;
      if (key === "distance_km" || key === "cost") {
        const n = Number(v);
        setClauses.push(`${key} = ${n}`);
        if (key === "cost") nextCost = n;
      }
      else if (key === "duration_min") setClauses.push(`${key} = ${Math.round(Number(v))}`);
      else if (key === "cost_currency") {
        nextCurrency = String(v).toUpperCase();
        setClauses.push(`${key} = ${lit(nextCurrency)}`);
      }
      else setClauses.push(`${key} = ${lit(v)}`);
    }
    const rate = EUR_PER_UNIT[nextCurrency] ?? 1;
    setClauses.push(`cost_eur = ${Math.round(nextCost * rate * 100) / 100}`);
    if (setClauses.length === 0) {
      return reply.code(400).send({ ok: false, error: "No updates were provided" });
    }
    const where = [
      `day = ${lit(original.day ?? "")}`,
      `started_at = ${lit(original.started_at ?? "")}`,
      `provider = ${lit(original.provider ?? "")}`,
      `type = ${lit(original.type ?? "")}`,
      `distance_km = ${Number(original.distance_km ?? 0)}`,
      `duration_min = ${Math.round(Number(original.duration_min ?? 0))}`,
      `cost = ${Number(original.cost ?? 0)}`,
      `upperUTF8(cost_currency) = ${lit(String(original.cost_currency ?? "EUR").toUpperCase())}`,
    ].join(" AND ");
    try {
      await command(`ALTER TABLE mobility_ride UPDATE ${setClauses.join(", ")} WHERE ${where}`);
      return { ok: true, message: "Ride updated. Refreshing dashboard shortly." };
    } catch (err) {
      return reply
        .code(502)
        .send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
