import type { Connector, LifeStackModule, ModuleContext } from "../../core/types";
import { alreadySeeded, daysAgo, insertMany, iso, rand, round2, seasonal } from "../_demo";

const COLUMNS = ["day", "day_kwh", "night_kwh", "cost"];

async function seed(ctx: ModuleContext): Promise<void> {
  if (await alreadySeeded(ctx, "energy_reading")) return;
  const rows: unknown[][] = [];
  for (let i = 288; i >= 0; i--) {
    const d = daysAgo(i);
    const base = rand(8, 14) * seasonal(d);
    const dayKwh = round2(base * rand(0.5, 0.65));
    const nightKwh = round2(base * rand(0.35, 0.5));
    rows.push([iso(d), dayKwh, nightKwh, round2(dayKwh * 0.3 + nightKwh * 0.21)]);
  }
  await insertMany(ctx, "energy_reading", COLUMNS, rows);
}

const tibber: Connector = {
  id: "tibber",
  name: "Tibber",
  description: "Pull daily electricity consumption and cost from the Tibber API.",
  kind: "api",
  syncIntervalMinutes: 360,
  configSchema: [
    {
      key: "token",
      label: "Tibber API token",
      type: "password",
      secret: true,
      env: "TIBBER_TOKEN",
      help: "Personal access token from developer.tibber.com.",
    },
  ],
  async sync(ctx) {
    const token = String(ctx.config.token ?? "");
    if (!token) throw new Error("Set a Tibber API token to sync");
    const gql = `{ viewer { homes { consumption(resolution: DAILY, last: 90) { nodes { from consumption cost } } } } }`;
    const res = await fetch("https://api.tibber.com/v1-beta/gql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: gql }),
    });
    if (!res.ok) throw new Error(`Tibber API error ${res.status}`);
    const json = (await res.json()) as {
      data?: { viewer?: { homes?: Array<{ consumption?: { nodes?: Array<{ from: string; consumption: number | null; cost: number | null }> } }> } };
    };
    const homes = json.data?.viewer?.homes ?? [];
    let inserted = 0;
    for (const home of homes) {
      for (const n of home.consumption?.nodes ?? []) {
        if (n.consumption == null) continue;
        const r = await ctx.db.query(
          `INSERT INTO energy_reading (day, day_kwh, night_kwh, cost) VALUES ($1, $2, 0, $3)
           ON CONFLICT (day) DO UPDATE SET day_kwh = EXCLUDED.day_kwh, cost = EXCLUDED.cost`,
          [String(n.from).slice(0, 10), Number(n.consumption), Number(n.cost ?? 0)],
        );
        inserted += r.rowCount ?? 0;
      }
    }
    return { inserted, message: `synced ${inserted} day(s) from Tibber` };
  },
};

const csv: Connector = {
  id: "csv",
  name: "CSV / JSON import",
  description: "Import meter readings. Rows: {day, day_kwh, night_kwh, cost}.",
  kind: "import",
  async import(ctx, rows) {
    const values = rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => {
        const dayKwh = Number(r.day_kwh ?? r.dayKwh ?? r.kwh ?? 0);
        const nightKwh = Number(r.night_kwh ?? r.nightKwh ?? 0);
        return [
          String(r.day ?? r.date ?? iso(new Date())).slice(0, 10),
          dayKwh,
          nightKwh,
          Number(r.cost ?? round2(dayKwh * 0.3 + nightKwh * 0.21)),
        ];
      });
    await insertMany(ctx, "energy_reading", COLUMNS, values);
    return { inserted: values.length };
  },
};

const energy: LifeStackModule = {
  id: "energy",
  name: "Energy",
  description: "Home electricity: usage, day versus night, and cost.",
  icon: "⚡",
  accent: "oklch(0.80 0.15 100)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS energy_reading (
       id serial PRIMARY KEY,
       day date NOT NULL UNIQUE,
       day_kwh numeric NOT NULL,
       night_kwh numeric NOT NULL,
       cost numeric NOT NULL
     )`,
  ],
  connectors: [tibber, csv],
  seed,
  widgets: [
    {
      id: "kwh-month",
      title: "Usage this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT round(coalesce(sum(day_kwh + night_kwh), 0)::numeric, 1) AS v
           FROM energy_reading WHERE day >= date_trunc('month', now())`,
        );
        return { value: rows[0].v, unit: "kWh" };
      },
    },
    {
      id: "cost-month",
      title: "Cost this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT coalesce(sum(cost), 0) AS v FROM energy_reading WHERE day >= date_trunc('month', now())`,
        );
        return { value: round2(rows[0].v), format: "currency" };
      },
    },
    {
      id: "avg-daily",
      title: "Avg daily use",
      subtitle: "Last 30 days",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT round(coalesce(avg(day_kwh + night_kwh), 0)::numeric, 1) AS v
           FROM energy_reading WHERE day >= now() - interval '30 days'`,
        );
        return { value: rows[0].v, unit: "kWh/day" };
      },
    },
    {
      id: "day-night",
      title: "Day vs night",
      subtitle: "Last 90 days",
      type: "donut",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query<{ d: number; n: number }>(
          `SELECT round(coalesce(sum(day_kwh), 0)::numeric, 1) AS d, round(coalesce(sum(night_kwh), 0)::numeric, 1) AS n
           FROM energy_reading WHERE day >= now() - interval '90 days'`,
        );
        return {
          slices: [
            { label: "Day", value: rows[0].d },
            { label: "Night", value: rows[0].n },
          ],
          unit: "kWh",
        };
      },
    },
    {
      id: "kwh-month-bar",
      title: "Usage per month",
      type: "bar",
      size: "lg",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(date_trunc('month', day), 'Mon') AS label, round(sum(day_kwh + night_kwh)::numeric, 0) AS value
           FROM energy_reading GROUP BY date_trunc('month', day) ORDER BY date_trunc('month', day)`,
        );
        return { series: rows, unit: "kWh" };
      },
    },
    {
      id: "calendar",
      title: "Daily usage",
      subtitle: "Last 180 days",
      type: "calendar",
      size: "lg",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(day, 'YYYY-MM-DD') AS date, round((day_kwh + night_kwh)::numeric, 1) AS value
           FROM energy_reading WHERE day >= now() - interval '180 days' ORDER BY day`,
        );
        return { days: rows, unit: "kWh" };
      },
    },
    {
      id: "cost-trend",
      title: "Cost per month",
      type: "line",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(date_trunc('month', day), 'Mon') AS label, round(sum(cost)::numeric, 2) AS value
           FROM energy_reading GROUP BY date_trunc('month', day) ORDER BY date_trunc('month', day)`,
        );
        return { series: rows, format: "currency" };
      },
    },
  ],
};

export default energy;
