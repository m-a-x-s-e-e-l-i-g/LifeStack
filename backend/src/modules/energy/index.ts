import type { Connector, LifeStackModule } from "../../core/types";

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
      data?: {
        viewer?: {
          homes?: Array<{
            consumption?: { nodes?: Array<{ from: string; consumption: number | null; cost: number | null }> };
          }>;
        };
      };
    };
    const homes = json.data?.viewer?.homes ?? [];
    const rows: Record<string, unknown>[] = [];
    for (const home of homes) {
      for (const n of home.consumption?.nodes ?? []) {
        if (n.consumption == null) continue;
        rows.push({
          day: String(n.from).slice(0, 10),
          day_kwh: Number(n.consumption),
          night_kwh: 0,
          cost: Number(n.cost ?? 0),
        });
      }
    }
    await ctx.db.insert("energy_reading", rows);
    return { inserted: rows.length, message: `synced ${rows.length} day(s) from Tibber` };
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
       day Date,
       day_kwh Float64,
       night_kwh Float64,
       cost Float64
     ) ENGINE = ReplacingMergeTree ORDER BY day`,
  ],
  connectors: [tibber],
  widgets: [
    {
      id: "kwh-month",
      title: "Usage this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(day_kwh + night_kwh), 1) AS v
           FROM energy_reading FINAL WHERE day >= toStartOfMonth(today())`,
        );
        return { value: rows[0]?.v ?? 0, unit: "kWh" };
      },
    },
    {
      id: "cost-month",
      title: "Cost this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(cost), 2) AS v
           FROM energy_reading FINAL WHERE day >= toStartOfMonth(today())`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "avg-daily",
      title: "Avg daily use",
      subtitle: "Last 30 days",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT if(count() = 0, 0, round(avg(day_kwh + night_kwh), 1)) AS v
           FROM energy_reading FINAL WHERE day >= today() - INTERVAL 30 DAY`,
        );
        return { value: rows[0]?.v ?? 0, unit: "kWh/day" };
      },
    },
    {
      id: "day-night",
      title: "Day vs night",
      subtitle: "Last 90 days",
      type: "donut",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ d: number; n: number }>(
          `SELECT round(sum(day_kwh), 1) AS d, round(sum(night_kwh), 1) AS n
           FROM energy_reading FINAL WHERE day >= today() - INTERVAL 90 DAY`,
        );
        return {
          slices: [
            { label: "Day", value: rows[0]?.d ?? 0 },
            { label: "Night", value: rows[0]?.n ?? 0 },
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
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, round(s, 0) AS value
           FROM (SELECT toStartOfMonth(day) AS m, sum(day_kwh + night_kwh) AS s
                 FROM energy_reading FINAL GROUP BY m) ORDER BY m`,
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
        const rows = await ctx.db.query(
          `SELECT toString(day) AS date, round(day_kwh + night_kwh, 1) AS value
           FROM energy_reading FINAL WHERE day >= today() - INTERVAL 180 DAY ORDER BY day`,
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
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, round(s, 2) AS value
           FROM (SELECT toStartOfMonth(day) AS m, sum(cost) AS s
                 FROM energy_reading FINAL GROUP BY m) ORDER BY m`,
        );
        return { series: rows, format: "currency" };
      },
    },
  ],
};

export default energy;
