import type { FastifyInstance, FastifyReply } from "fastify";
import { command, insert, query } from "../db";
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
  moduleConnectors,
  runConnectorSync,
  runConnectorAuthorize,
  setConnectorConfig,
  setConnectorEnabled,
  setModuleEnabled,
} from "./registry";
import { aiStatus, applyPendingChange, chat, setAiConfig, type ChatMessage, type PendingChange } from "./ai";
import { ensureConnectorScheduled, triggerSync } from "./scheduler";
import { inboxMailboxConnector, nextInboxMailboxConnectorId } from "../modules/inbox";

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

type InboxReceiptKind =
  | "mobility"
  | "mobility_pass"
  | "food"
  | "groceries"
  | "parking"
  | "flights"
  | "reservations";

interface InboxReceiptCandidateRow {
  id: string;
  day: string;
  created_at: string;
  updated_at: string;
  dedupe_key: string;
  status: string;
  kind: InboxReceiptKind;
  provider: string;
  message_id: string;
  email_excerpt: string;
  started_at: string;
  type: string;
  merchant: string;
  amount: number;
  currency: string;
  amount_eur: number;
  distance_km: number;
  duration_min: number;
  items_count: number;
  pickup_location: string;
  dropoff_location: string;
  flight_number: string;
  booking_ref: string;
  origin_iata: string;
  destination_iata: string;
  passenger: string;
  seat: string;
  reservation_category: string;
  reservation_ref: string;
  guests: number;
  venue: string;
  source: string;
  source_connector: string;
  review_note: string;
}

interface AiRecordLogRow {
  event_id: string;
  change_id: string;
  target: string;
  hash: string;
  payload: string;
  created_at: string;
}

function inboxAmountLabel(row: InboxReceiptCandidateRow): string {
  const original = `${Math.round(Number(row.amount ?? 0) * 100) / 100} ${String(row.currency ?? "EUR").toUpperCase()}`;
  const eur = Math.round(Number(row.amount_eur ?? 0) * 100) / 100;
  if (String(row.currency ?? "").toUpperCase() === "EUR") return original;
  return `${original} (${eur} EUR)`;
}

function inboxSummary(row: InboxReceiptCandidateRow): string {
  if (row.kind === "mobility") return `${row.provider} ${row.type || "ride"}`.trim();
  if (row.kind === "mobility_pass") return `${row.provider} pass`;
  if (row.kind === "food") return `${row.provider} · ${(row.merchant || "Unknown").trim()}`;
  if (row.kind === "groceries") return `${row.provider} grocery receipt`;
  if (row.kind === "parking") return `${row.provider} parking`;
  if (row.kind === "flights") {
    const route =
      row.origin_iata && row.destination_iata ? `${row.origin_iata} -> ${row.destination_iata}` : "flight receipt";
    return `${row.provider} ${row.flight_number || route}`.trim();
  }
  const venue = row.venue || row.merchant || row.provider;
  return `${row.reservation_category || "reservation"} · ${venue}`;
}

function inboxDetails(row: InboxReceiptCandidateRow): string {
  if (row.kind === "mobility") {
    const bits = [];
    if (Number(row.distance_km ?? 0) > 0) bits.push(`${Math.round(Number(row.distance_km) * 100) / 100} km`);
    if (Number(row.duration_min ?? 0) > 0) bits.push(`${Math.round(Number(row.duration_min))} min`);
    if (row.pickup_location || row.dropoff_location) {
      bits.push([row.pickup_location, row.dropoff_location].filter(Boolean).join(" -> "));
    }
    return bits.join(" · ");
  }
  if (row.kind === "mobility_pass") return row.merchant || "Lime pass";
  if (row.kind === "food") return row.merchant || "";
  if (row.kind === "groceries") return row.items_count > 0 ? `${row.items_count} items` : "";
  if (row.kind === "parking") return row.merchant || row.venue || "";
  if (row.kind === "flights") {
    const bits = [];
    if (row.booking_ref) bits.push(`Ref ${row.booking_ref}`);
    if (row.passenger) bits.push(row.passenger);
    return bits.join(" · ");
  }
  const bits = [];
  if (row.venue) bits.push(row.venue);
  if (row.reservation_ref) bits.push(`Ref ${row.reservation_ref}`);
  if (Number(row.guests ?? 0) > 0) bits.push(`${Math.round(Number(row.guests))} guests`);
  return bits.join(" · ");
}

function inboxInsertTarget(kind: InboxReceiptKind): string {
  if (kind === "mobility") return "mobility_ride";
  if (kind === "mobility_pass") return "mobility_lime_pass";
  if (kind === "food") return "food_order";
  if (kind === "groceries") return "grocery_receipt";
  if (kind === "parking") return "fuel_parking_entry";
  if (kind === "flights") return "flight_trip";
  return "reservation_entry";
}

function inboxInsertRow(row: InboxReceiptCandidateRow): Record<string, unknown> {
  if (row.kind === "mobility") {
    return {
      day: row.day,
      started_at: row.started_at,
      provider: row.provider,
      type: row.type || "ride",
      distance_km: Number(row.distance_km ?? 0),
      duration_min: Math.round(Number(row.duration_min ?? 0)),
      cost: Number(row.amount ?? 0),
      cost_currency: String(row.currency ?? "EUR").toUpperCase(),
      cost_eur: Number(row.amount_eur ?? 0),
    };
  }
  if (row.kind === "mobility_pass") {
    return {
      day: row.day,
      cost: Number(row.amount ?? 0),
      cost_currency: String(row.currency ?? "EUR").toUpperCase(),
      cost_eur: Number(row.amount_eur ?? 0),
      description: row.merchant || `${row.provider} pass`,
      notes: `Approved from inbox review (${row.message_id})`,
    };
  }
  if (row.kind === "food") {
    return {
      day: row.day,
      provider: row.provider,
      merchant: row.merchant || "Unknown",
      total: Number(row.amount ?? 0),
      currency: String(row.currency ?? "EUR").toUpperCase(),
      items: Math.max(0, Math.round(Number(row.items_count ?? 0))),
      delivery_fee: 0,
      service_fee: 0,
      tip: 0,
      notes: "Approved from inbox review",
      source: "inbox",
    };
  }
  if (row.kind === "groceries") {
    return {
      day: row.day,
      message_id: row.message_id,
      store: row.provider,
      amount: Number(row.amount ?? 0),
      currency: String(row.currency ?? "EUR").toUpperCase(),
      cost_eur: Number(row.amount_eur ?? 0),
      items_count: Math.max(0, Math.round(Number(row.items_count ?? 0))),
    };
  }
  if (row.kind === "parking") {
    return {
      day: row.day,
      started_at: row.started_at,
      provider: row.provider || "Parking",
      location: row.merchant || row.venue || "",
      amount: Number(row.amount ?? 0),
      currency: String(row.currency ?? "EUR").toUpperCase(),
      amount_eur: Number(row.amount_eur ?? 0),
      source: "inbox",
      message_id: row.message_id,
      notes: "Approved from inbox review",
    };
  }
  if (row.kind === "flights") {
    return {
      day: row.day,
      departed_at: row.started_at,
      airline: row.provider || "Unknown airline",
      flight_number: row.flight_number ?? "",
      booking_ref: row.booking_ref ?? "",
      origin_iata: (row.origin_iata ?? "").toUpperCase(),
      destination_iata: (row.destination_iata ?? "").toUpperCase(),
      passenger: row.passenger ?? "",
      seat: row.seat ?? "",
      ticket_total: Number(row.amount ?? 0),
      ticket_currency: String(row.currency ?? "EUR").toUpperCase(),
      ticket_total_eur: Number(row.amount_eur ?? 0),
      source: "inbox",
      message_id: row.message_id,
      notes: "Approved from inbox review",
    };
  }
  return {
    day: row.day,
    started_at: row.started_at,
    category: row.reservation_category || "reservation",
    provider: row.provider || "Reservation",
    venue: row.venue || row.merchant || "",
    reservation_ref: row.reservation_ref ?? "",
    guests: Math.max(0, Math.round(Number(row.guests ?? 0))),
    amount: Number(row.amount ?? 0),
    currency: String(row.currency ?? "EUR").toUpperCase(),
    amount_eur: Number(row.amount_eur ?? 0),
    source: "inbox",
    message_id: row.message_id,
    notes: "Approved from inbox review",
  };
}

function inboxTargetWhere(row: InboxReceiptCandidateRow): { table: string; where: string } {
  if (row.kind === "mobility") {
    return {
      table: "mobility_ride",
      where: `day = toDate(${lit(row.day)})
        AND started_at = toDateTime64(${lit(row.started_at)}, 3)
        AND lowerUTF8(provider) = lowerUTF8(${lit(row.provider)})
        AND lowerUTF8(type) = lowerUTF8(${lit(row.type || "ride")})
        AND round(cost, 2) = round(${Number(row.amount ?? 0)}, 2)
        AND upperUTF8(cost_currency) = upperUTF8(${lit(row.currency)})
        AND round(distance_km, 2) = round(${Number(row.distance_km ?? 0)}, 2)
        AND toInt32(duration_min) = toInt32(${Math.round(Number(row.duration_min ?? 0))})`,
    };
  }
  if (row.kind === "mobility_pass") {
    const description = row.merchant || `${row.provider} pass`;
    return {
      table: "mobility_lime_pass",
      where: `day = toDate(${lit(row.day)})
        AND round(cost, 2) = round(${Number(row.amount ?? 0)}, 2)
        AND upperUTF8(cost_currency) = upperUTF8(${lit(row.currency)})
        AND description = ${lit(description)}`,
    };
  }
  if (row.kind === "food") {
    return {
      table: "food_order",
      where: `day = toDate(${lit(row.day)})
        AND lowerUTF8(provider) = lowerUTF8(${lit(row.provider)})
        AND lowerUTF8(merchant) = lowerUTF8(${lit(row.merchant)})
        AND round(total, 2) = round(${Number(row.amount ?? 0)}, 2)
        AND upperUTF8(currency) = upperUTF8(${lit(row.currency)})
        AND toInt32(items) = toInt32(${Math.max(0, Math.round(Number(row.items_count ?? 0)))})`,
    };
  }
  if (row.kind === "groceries") {
    const messageId = String(row.message_id ?? "").trim();
    const messageClause = messageId ? ` AND message_id = ${lit(messageId)}` : "";
    return {
      table: "grocery_receipt",
      where: `day = toDate(${lit(row.day)})
        AND lowerUTF8(store) = lowerUTF8(${lit(row.provider)})
        AND round(amount, 2) = round(${Number(row.amount ?? 0)}, 2)
        AND upperUTF8(currency) = upperUTF8(${lit(row.currency)})
        AND toInt32(items_count) = toInt32(${Math.max(0, Math.round(Number(row.items_count ?? 0)))})${messageClause}`,
    };
  }
  if (row.kind === "flights") {
    const messageId = String(row.message_id ?? "").trim();
    const messageClause = messageId ? ` AND message_id = ${lit(messageId)}` : "";
    return {
      table: "flight_trip",
      where: `day = toDate(${lit(row.day)})
        AND departed_at = toDateTime64(${lit(row.started_at)}, 3)
        AND lowerUTF8(airline) = lowerUTF8(${lit(row.provider)})
        AND upperUTF8(flight_number) = upperUTF8(${lit(row.flight_number)})
        AND upperUTF8(booking_ref) = upperUTF8(${lit(row.booking_ref)})
        AND upperUTF8(origin_iata) = upperUTF8(${lit(row.origin_iata)})
        AND upperUTF8(destination_iata) = upperUTF8(${lit(row.destination_iata)})
        AND round(ticket_total, 2) = round(${Number(row.amount ?? 0)}, 2)
        AND upperUTF8(ticket_currency) = upperUTF8(${lit(row.currency)})${messageClause}`,
    };
  }
  if (row.kind === "parking") {
    const messageId = String(row.message_id ?? "").trim();
    const messageClause = messageId ? ` AND message_id = ${lit(messageId)}` : "";
    return {
      table: "fuel_parking_entry",
      where: `day = toDate(${lit(row.day)})
        AND started_at = toDateTime64(${lit(row.started_at)}, 3)
        AND lowerUTF8(provider) = lowerUTF8(${lit(row.provider)})
        AND lowerUTF8(location) = lowerUTF8(${lit(row.merchant || row.venue || "")})
        AND round(amount, 2) = round(${Number(row.amount ?? 0)}, 2)
        AND upperUTF8(currency) = upperUTF8(${lit(row.currency)})${messageClause}`,
    };
  }
  const messageId = String(row.message_id ?? "").trim();
  const messageClause = messageId ? ` AND message_id = ${lit(messageId)}` : "";
  return {
    table: "reservation_entry",
    where: `day = toDate(${lit(row.day)})
      AND started_at = toDateTime64(${lit(row.started_at)}, 3)
      AND lowerUTF8(category) = lowerUTF8(${lit(row.reservation_category || row.type || "reservation")})
      AND lowerUTF8(provider) = lowerUTF8(${lit(row.provider)})
      AND lowerUTF8(venue) = lowerUTF8(${lit(row.venue || row.merchant || "")})
      AND upperUTF8(reservation_ref) = upperUTF8(${lit(row.reservation_ref)})
      AND toInt32(guests) = toInt32(${Math.max(0, Math.round(Number(row.guests ?? 0)))})
      AND round(amount, 2) = round(${Number(row.amount ?? 0)}, 2)
      AND upperUTF8(currency) = upperUTF8(${lit(row.currency)})${messageClause}`,
  };
}

async function inboxTargetRowExists(row: InboxReceiptCandidateRow): Promise<boolean> {
  const target = inboxTargetWhere(row);
  const rows = await query<{ v: number }>(
    `SELECT toInt32(count()) AS v FROM ${target.table} WHERE ${target.where}`,
  );
  return Number(rows[0]?.v ?? 0) > 0;
}

async function inboxDeleteTargetRow(row: InboxReceiptCandidateRow): Promise<void> {
  const target = inboxTargetWhere(row);
  await command(
    `ALTER TABLE ${target.table}
     DELETE WHERE ${target.where}
     SETTINGS mutations_sync = 1`,
  );
}

const INBOX_CANDIDATE_COLUMNS = `
  id,
  toString(day) AS day,
  toString(created_at) AS created_at,
  toString(updated_at) AS updated_at,
  dedupe_key,
  status,
  kind,
  provider,
  message_id,
  email_excerpt,
  toString(started_at) AS started_at,
  type,
  merchant,
  amount,
  currency,
  amount_eur,
  distance_km,
  duration_min,
  items_count,
  pickup_location,
  dropoff_location,
  flight_number,
  booking_ref,
  origin_iata,
  destination_iata,
  passenger,
  seat,
  reservation_category,
  reservation_ref,
  guests,
  venue,
  source,
  source_connector,
  review_note
`;

async function inboxCandidateById(id: string): Promise<InboxReceiptCandidateRow | null> {
  const rows = await query<InboxReceiptCandidateRow>(
    `SELECT
       ${INBOX_CANDIDATE_COLUMNS}
     FROM inbox_receipt_candidate FINAL
     WHERE id = ${lit(id)}
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

function inboxIds(body: { id?: string; ids?: string[] }): string[] {
  const out = [];
  if (typeof body.id === "string" && body.id.trim()) out.push(body.id.trim());
  if (Array.isArray(body.ids)) {
    for (const raw of body.ids) {
      if (typeof raw !== "string") continue;
      const v = raw.trim();
      if (!v) continue;
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

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
  const c = await getConnector(m, connectorId);
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
      const connectors = await moduleConnectors(m);
      let enabledConnectors = 0;
      for (const c of connectors) {
        if (await isConnectorEnabled(m.id, c.id)) enabledConnectors++;
      }
      out.push({
        ...meta(m),
        enabled: await isModuleEnabled(m.id),
        connectorCount: connectors.length,
        enabledConnectors,
        hasApi: connectors.some((c) => c.kind === "api"),
        widgetCount: m.widgets.length,
        lastSync: await lastSync(m.id),
      });
    }
    return { modules: out };
  });

  app.get<{ Params: { id: string } }>("/api/modules/:id", async (req, reply) => {
    const m = getModule(req.params.id);
    if (!m) return notFound(reply, "module");
    const moduleConnectorList = await moduleConnectors(m);
    const connectors = [];
    for (const c of moduleConnectorList) connectors.push(await connectorView(m, c));
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

  app.get("/api/modules/observations/insights", async (_req, reply) => {
    const m = getModule("observations");
    if (!m) return notFound(reply, "module");

    if (!(await isModuleEnabled(m.id))) {
      return {
        module: meta(m),
        enabled: false,
        summary: null,
        monthly: [],
        countries: [],
        map: { totalMapped: 0, returned: 0, points: [] },
        topSpecies: [],
        streaks: { current: 0, latest: 0, longest: 0 },
        busiestDay: null,
      };
    }

    const ctx = buildModuleContext(m);
    const [
      summaryRows,
      monthlyRows,
      countryRows,
      mapRows,
      topSpeciesRows,
      dailyRows,
    ] = await Promise.all([
      ctx.db.query<{
        total_observations: number;
        total_species: number;
        countries_observed: number;
        mapped_observations: number;
        active_days: number;
        first_observed: string;
        last_observed: string;
      }>(
        `SELECT
           toInt32(count()) AS total_observations,
           toInt32(uniqExactIf(if(species != '', species, scientific_name), species != '' OR scientific_name != '')) AS total_species,
           toInt32(uniqExactIf(if(country != '', country, if(country_code != '', country_code, 'Unknown')), country != '' OR country_code != '')) AS countries_observed,
           toInt32(countIf(decimal_latitude BETWEEN -90 AND 90 AND decimal_longitude BETWEEN -180 AND 180 AND (abs(decimal_latitude) > 0 OR abs(decimal_longitude) > 0))) AS mapped_observations,
           toInt32(uniqExact(event_date)) AS active_days,
           if(count() = 0, '', toString(min(event_date))) AS first_observed,
           if(count() = 0, '', toString(max(event_date))) AS last_observed
         FROM observation_occurrence FINAL`,
      ),
      ctx.db.query<{ month: string; observations: number; species: number }>(
        `SELECT
           formatDateTime(toStartOfMonth(event_date), '%Y-%m') AS month,
           toInt32(count()) AS observations,
           toInt32(uniqExactIf(if(species != '', species, scientific_name), species != '' OR scientific_name != '')) AS species
         FROM observation_occurrence FINAL
         WHERE event_date >= toStartOfMonth(today()) - INTERVAL 11 MONTH
         GROUP BY month
         ORDER BY month ASC`,
      ),
      ctx.db.query<{ country: string; observations: number; species: number }>(
        `SELECT
           country,
           toInt32(count()) AS observations,
           toInt32(uniqExactIf(species_name, species_name != '')) AS species
         FROM (
           SELECT
             if(country != '', country, if(country_code != '', country_code, 'Unknown')) AS country,
             if(species != '', species, scientific_name) AS species_name
           FROM observation_occurrence FINAL
         )
         GROUP BY country
         ORDER BY observations DESC, country ASC
         LIMIT 40`,
      ),
      ctx.db.query<{ lat: number; lon: number; species: string; country: string; date: string }>(
        `SELECT
           toFloat64(decimal_latitude) AS lat,
           toFloat64(decimal_longitude) AS lon,
           if(species != '', species, if(scientific_name != '', scientific_name, 'Unknown species')) AS species,
           if(country != '', country, if(country_code != '', country_code, 'Unknown')) AS country,
           toString(event_date) AS date
         FROM observation_occurrence FINAL
         WHERE decimal_latitude BETWEEN -90 AND 90
           AND decimal_longitude BETWEEN -180 AND 180
           AND (abs(decimal_latitude) > 0 OR abs(decimal_longitude) > 0)
         ORDER BY event_date DESC, gbif_id DESC
         LIMIT 2500`,
      ),
      ctx.db.query<{ species: string; observations: number }>(
        `SELECT
           if(species != '', species, scientific_name) AS species,
           toInt32(count()) AS observations
         FROM observation_occurrence FINAL
         WHERE species != '' OR scientific_name != ''
         GROUP BY species
         ORDER BY observations DESC, species ASC
         LIMIT 12`,
      ),
      ctx.db.query<{ date: string; observations: number }>(
        `SELECT
           toString(event_date) AS date,
           toInt32(count()) AS observations
         FROM observation_occurrence FINAL
         WHERE event_date >= today() - INTERVAL 365 DAY
         GROUP BY event_date
         ORDER BY event_date ASC`,
      ),
    ]);

    const summaryRow = summaryRows[0] ?? {
      total_observations: 0,
      total_species: 0,
      countries_observed: 0,
      mapped_observations: 0,
      active_days: 0,
      first_observed: "",
      last_observed: "",
    };

    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    const monthlyByKey = new Map(
      monthlyRows.map((row) => [row.month, { observations: Number(row.observations ?? 0), species: Number(row.species ?? 0) }]),
    );

    const now = new Date();
    const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const monthly = [];
    for (let i = 0; i < 12; i++) {
      const dt = new Date(Date.UTC(startMonth.getUTCFullYear(), startMonth.getUTCMonth() + i, 1));
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
      const values = monthlyByKey.get(key);
      monthly.push({
        month: key,
        label: `${monthNames[dt.getUTCMonth()]} ${String(dt.getUTCFullYear()).slice(2)}`,
        observations: values?.observations ?? 0,
        species: values?.species ?? 0,
      });
    }

    const daySet = new Set<string>();
    const dayMs = 86_400_000;
    let longestStreak = 0;
    let run = 0;
    let prevMs: number | null = null;

    for (const row of dailyRows) {
      const day = String(row.date ?? "").slice(0, 10);
      const ms = Date.parse(`${day}T00:00:00Z`);
      if (!day || !Number.isFinite(ms)) continue;
      daySet.add(day);
      if (prevMs !== null && ms - prevMs === dayMs) run += 1;
      else run = 1;
      if (run > longestStreak) longestStreak = run;
      prevMs = ms;
    }

    let currentStreak = 0;
    let cursor = new Date();
    cursor.setUTCHours(0, 0, 0, 0);
    while (daySet.has(cursor.toISOString().slice(0, 10))) {
      currentStreak += 1;
      cursor = new Date(cursor.getTime() - dayMs);
    }

    let latestStreak = 0;
    const latestDay = dailyRows[dailyRows.length - 1]?.date?.slice(0, 10);
    if (latestDay) {
      let latestCursor = Date.parse(`${latestDay}T00:00:00Z`);
      while (Number.isFinite(latestCursor)) {
        const iso = new Date(latestCursor).toISOString().slice(0, 10);
        if (!daySet.has(iso)) break;
        latestStreak += 1;
        latestCursor -= dayMs;
      }
    }

    const busiestDay =
      dailyRows.length === 0
        ? null
        : dailyRows.reduce<{ date: string; observations: number } | null>((best, row) => {
            const observations = Number(row.observations ?? 0);
            const date = String(row.date ?? "").slice(0, 10);
            if (!date) return best;
            if (!best || observations > best.observations) return { date, observations };
            return best;
          }, null);

    const mapPoints = mapRows.map((row) => ({
      lat: Number(row.lat),
      lon: Number(row.lon),
      species: String(row.species ?? "Unknown species"),
      country: String(row.country ?? "Unknown"),
      date: String(row.date ?? "").slice(0, 10),
    }));

    return {
      module: meta(m),
      enabled: true,
      summary: {
        totalObservations: Number(summaryRow.total_observations ?? 0),
        totalSpecies: Number(summaryRow.total_species ?? 0),
        countriesObserved: Number(summaryRow.countries_observed ?? 0),
        mappedObservations: Number(summaryRow.mapped_observations ?? 0),
        activeDays: Number(summaryRow.active_days ?? 0),
        firstObserved: summaryRow.first_observed || null,
        lastObserved: summaryRow.last_observed || null,
      },
      monthly,
      countries: countryRows.map((row) => ({
        country: String(row.country ?? "Unknown"),
        observations: Number(row.observations ?? 0),
        species: Number(row.species ?? 0),
      })),
      map: {
        totalMapped: Number(summaryRow.mapped_observations ?? 0),
        returned: mapPoints.length,
        points: mapPoints,
      },
      topSpecies: topSpeciesRows.map((row) => ({
        species: String(row.species ?? "Unknown species"),
        observations: Number(row.observations ?? 0),
      })),
      streaks: {
        current: currentStreak,
        latest: latestStreak,
        longest: longestStreak,
      },
      busiestDay,
    };
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
    const connectors = await moduleConnectors(m);
    const results: Record<string, unknown> = {};
    for (const c of connectors) {
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

  app.post<{ Params: { id: string } }>("/api/modules/:id/connectors/mailbox/add", async (req, reply) => {
    const m = getModule(req.params.id);
    if (!m) return notFound(reply, "module");
    if (m.id !== "inbox") {
      return reply.code(400).send({ error: "mailbox slots are only supported for the inbox module" });
    }

    const connectors = await moduleConnectors(m);
    const connectorId = nextInboxMailboxConnectorId(connectors.map((c) => c.id));
    const c = inboxMailboxConnector(connectorId);
    if (!c) return reply.code(500).send({ error: "failed to create mailbox connector" });

    // Ensure a state row exists so the slot persists and can be configured.
    await setConnectorConfig(m.id, c.id, {
      __mailboxSlot: true,
      __mailboxCreatedAt: new Date().toISOString(),
    });
    await ensureConnectorScheduled(m.id, c.id);
    return { ok: true, connector: await connectorView(m, c) };
  });

  app.post<{ Params: { id: string; cid: string } }>(
    "/api/modules/:id/connectors/:cid/enable",
    async (req, reply) => {
      const r = await resolve(req.params.id, req.params.cid, reply);
      if (!r) return;
      await setConnectorEnabled(r.m.id, r.c.id, true);
      // Sync straight away so stats populate without a manual trigger.
      if (r.c.sync) {
        await ensureConnectorScheduled(r.m.id, r.c.id);
        triggerSync(r.m.id, r.c.id);
      }
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
      if (r.c.sync && !req.body?.disconnect) {
        await ensureConnectorScheduled(r.m.id, r.c.id);
        triggerSync(r.m.id, r.c.id, 500);
      }
      return { ok: true, ...result, connector: await connectorView(r.m, r.c) };
    } catch (err) {
      return reply
        .code(502)
        .send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get<{ Querystring: { status?: string; limit?: number } }>("/api/inbox/receipts", async (req) => {
    const requestedStatus = String(req.query?.status ?? "pending").trim().toLowerCase();
    const status = requestedStatus === "approved" || requestedStatus === "declined" ? requestedStatus : "pending";
    const rawLimit = Number(req.query?.limit ?? 200);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.trunc(rawLimit))) : 200;
    const fetchLimit = Math.max(limit, Math.min(5000, limit * 4));
    const [rows, counts] = await Promise.all([
      query<InboxReceiptCandidateRow>(
        `SELECT
          ${INBOX_CANDIDATE_COLUMNS}
         FROM inbox_receipt_candidate FINAL
         WHERE status = ${lit(status)}
         ORDER BY created_at DESC
         LIMIT ${fetchLimit}`,
      ),
      query<{ status: string; v: number }>(
        `SELECT status, toInt32(uniqExact(dedupe_key)) AS v
         FROM inbox_receipt_candidate FINAL
         GROUP BY status`,
      ),
    ]);
    const dedupedRows: InboxReceiptCandidateRow[] = [];
    const seenDedupe = new Set<string>();
    for (const row of rows) {
      const dedupe = String(row.dedupe_key ?? "").trim() || row.id;
      if (seenDedupe.has(dedupe)) continue;
      seenDedupe.add(dedupe);
      dedupedRows.push(row);
      if (dedupedRows.length >= limit) break;
    }
    const totals = { pending: 0, approved: 0, declined: 0 };
    for (const row of counts) {
      const key = String(row.status ?? "").toLowerCase();
      if (key === "pending" || key === "approved" || key === "declined") {
        totals[key] = Number(row.v ?? 0);
      }
    }
    return {
      status,
      totals,
      receipts: dedupedRows.map((row) => ({
        id: row.id,
        status: row.status,
        kind: row.kind,
        provider: row.provider,
        day: row.day,
        createdAt: row.created_at,
        amount: Number(row.amount ?? 0),
        currency: String(row.currency ?? "EUR").toUpperCase(),
        amountEur: Number(row.amount_eur ?? 0),
        amountLabel: inboxAmountLabel(row),
        summary: inboxSummary(row),
        details: inboxDetails(row),
        messageId: row.message_id,
        emailExcerpt: row.email_excerpt ?? "",
        reviewNote: row.review_note ?? "",
      })),
    };
  });

  app.post<{ Body: { id?: string; ids?: string[] } }>("/api/inbox/receipts/approve", async (req, reply) => {
    const ids = inboxIds(req.body ?? {});
    if (ids.length === 0) return reply.code(400).send({ error: "id or ids is required" });

    const approved: Array<{ id: string; kind: InboxReceiptKind; target: string; inserted: boolean }> = [];
    const rejected: Array<{ id: string; error: string }> = [];
    const handledDedupe = new Set<string>();
    for (const id of ids) {
      const row = await inboxCandidateById(id);
      if (!row) {
        rejected.push({ id, error: "not found" });
        continue;
      }
      if (row.status !== "pending") {
        rejected.push({ id: row.id, error: `already ${row.status}` });
        continue;
      }
      const dedupe = String(row.dedupe_key ?? "").trim() || row.id;
      if (handledDedupe.has(dedupe)) continue;
      handledDedupe.add(dedupe);
      const pendingWhere =
        dedupe === row.id && !String(row.dedupe_key ?? "").trim()
          ? `id = ${lit(row.id)}`
          : `status = 'pending' AND dedupe_key = ${lit(dedupe)}`;
      const target = inboxInsertTarget(row.kind);
      const alreadyExists = await inboxTargetRowExists(row);
      if (!alreadyExists) {
        await insert(target, [inboxInsertRow(row)]);
      }
      await command(
        `ALTER TABLE inbox_receipt_candidate
         UPDATE status = 'approved', updated_at = now64(3), review_note = ${lit(
           alreadyExists ? "approved (already in module data)" : "approved",
         )}
         WHERE ${pendingWhere}
         SETTINGS mutations_sync = 1`,
      );
      approved.push({ id: row.id, kind: row.kind, target, inserted: !alreadyExists });
    }

    return {
      ok: rejected.length === 0,
      approved,
      rejected,
    };
  });

  app.post<{ Body: { id?: string; ids?: string[]; note?: string } }>(
    "/api/inbox/receipts/decline",
    async (req, reply) => {
      const ids = inboxIds(req.body ?? {});
      if (ids.length === 0) return reply.code(400).send({ error: "id or ids is required" });

      const note = String(req.body?.note ?? "declined by user").trim().slice(0, 500) || "declined by user";
      const declined: Array<{ id: string; kind: InboxReceiptKind; removedFromModuleData: boolean }> = [];
      const rejected: Array<{ id: string; error: string }> = [];
      const handledDedupe = new Set<string>();

      for (const id of ids) {
        const row = await inboxCandidateById(id);
        if (!row) {
          rejected.push({ id, error: "not found" });
          continue;
        }
        if (row.status !== "pending") {
          rejected.push({ id: row.id, error: `already ${row.status}` });
          continue;
        }
        const dedupe = String(row.dedupe_key ?? "").trim() || row.id;
        if (handledDedupe.has(dedupe)) continue;
        handledDedupe.add(dedupe);
        const pendingWhere =
          dedupe === row.id && !String(row.dedupe_key ?? "").trim()
            ? `id = ${lit(row.id)}`
            : `status = 'pending' AND dedupe_key = ${lit(dedupe)}`;
        let removedFromModuleData = false;
        if (row.source === "backfill") {
          const exists = await inboxTargetRowExists(row);
          if (exists) {
            await inboxDeleteTargetRow(row);
            removedFromModuleData = true;
          }
        }
        await command(
          `ALTER TABLE inbox_receipt_candidate
           UPDATE status = 'declined', updated_at = now64(3), review_note = ${lit(note)}
           WHERE ${pendingWhere}
           SETTINGS mutations_sync = 1`,
        );
        declined.push({ id: row.id, kind: row.kind, removedFromModuleData });
      }

      return {
        ok: rejected.length === 0,
        declined,
        rejected,
      };
    },
  );

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

  app.get<{ Querystring: { limit?: number; target?: string } }>("/api/ai/records", async (req) => {
    const rawLimit = Number(req.query?.limit ?? 200);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.trunc(rawLimit))) : 200;
    const target = String(req.query?.target ?? "").trim();
    const where = target ? `WHERE target = ${lit(target)}` : "";
    const rows = await query<AiRecordLogRow>(
      `SELECT
         event_id,
         change_id,
         target,
         hash,
         payload,
         toString(created_at) AS created_at
       FROM ai_assistant_record_log
       ${where}
       ORDER BY created_at DESC
       LIMIT ${limit}`,
    );
    return {
      records: rows.map((row) => {
        let parsed: unknown = row.payload;
        try {
          parsed = JSON.parse(row.payload);
        } catch {
          // Keep raw payload text if parsing fails.
        }
        return {
          eventId: row.event_id,
          changeId: row.change_id,
          target: row.target,
          hash: row.hash,
          createdAt: row.created_at,
          payload: parsed,
        };
      }),
    };
  });

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
      "started_at",
      "provider",
      "type",
      "distance_km",
      "duration_min",
      "cost",
      "cost_currency",
    ];
    const patchDay = String(patch.day ?? "").trim();
    const originalDay = String(original.day ?? "").trim();
    if (patchDay && originalDay && patchDay !== originalDay) {
      return reply.code(400).send({ ok: false, error: "Changing day is not supported for ride updates." });
    }
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
