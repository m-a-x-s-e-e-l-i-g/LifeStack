import type { Connector, LifeStackModule, ModuleContext } from "../../core/types";
import { alreadySeeded, daysAgo, insertMany, iso, rand, randInt, round2, weightedPick } from "../_demo";

type Provider = { name: string; kind: "scooter" | "car" };

const PROVIDERS: [Provider, number][] = [
  [{ name: "Uber", kind: "car" }, 0.28],
  [{ name: "Bolt", kind: "car" }, 0.27],
  [{ name: "Lime", kind: "scooter" }, 0.27],
  [{ name: "Tier", kind: "scooter" }, 0.18],
];

const COLUMNS = ["day", "provider", "type", "distance_km", "duration_min", "cost"];

async function seed(ctx: ModuleContext): Promise<void> {
  if (await alreadySeeded(ctx, "mobility_ride")) return;
  const rows: unknown[][] = [];
  for (let i = 0; i < 140; i++) {
    const day = daysAgo(randInt(0, 288));
    const p = weightedPick(PROVIDERS);
    if (p.kind === "scooter") {
      const dist = round2(rand(0.8, 4));
      rows.push([iso(day), p.name, "scooter", dist, randInt(4, 18), round2(1 + dist * 0.18)]);
    } else {
      const dist = round2(rand(2, 18));
      rows.push([iso(day), p.name, "car", dist, randInt(8, 40), round2(2.5 + dist * 1.1)]);
    }
  }
  await insertMany(ctx, "mobility_ride", COLUMNS, rows);
}

const csv: Connector = {
  id: "csv",
  name: "CSV / JSON import",
  description: "Import rides. Rows: {day, provider, type, distance_km, duration_min, cost}.",
  kind: "import",
  async import(ctx, rows) {
    const values = rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => [
        String(r.day ?? r.date ?? iso(new Date())).slice(0, 10),
        String(r.provider ?? "Unknown"),
        String(r.type ?? "car"),
        Number(r.distance_km ?? r.distance ?? 0),
        Number(r.duration_min ?? r.duration ?? 0),
        Number(r.cost ?? 0),
      ]);
    await insertMany(ctx, "mobility_ride", COLUMNS, values);
    return { inserted: values.length };
  },
};

const mobility: LifeStackModule = {
  id: "mobility",
  name: "Mobility",
  description: "Scooter and ride-hail trips across Uber, Bolt, Lime, and Tier.",
  icon: "🛴",
  accent: "oklch(0.68 0.15 250)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS mobility_ride (
       id serial PRIMARY KEY,
       day date NOT NULL,
       provider text NOT NULL,
       type text NOT NULL,
       distance_km numeric NOT NULL,
       duration_min integer NOT NULL,
       cost numeric NOT NULL
     )`,
  ],
  connectors: [csv],
  seed,
  widgets: [
    {
      id: "rides-month",
      title: "Rides this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT count(*)::int AS v FROM mobility_ride WHERE day >= date_trunc('month', now())`,
        );
        return { value: rows[0].v, unit: "rides" };
      },
    },
    {
      id: "total-spent",
      title: "Total spend",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT coalesce(sum(cost), 0) AS v FROM mobility_ride`,
        );
        return { value: round2(rows[0].v), format: "currency" };
      },
    },
    {
      id: "total-distance",
      title: "Distance traveled",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT round(coalesce(sum(distance_km), 0)::numeric, 1) AS v FROM mobility_ride`,
        );
        return { value: rows[0].v, unit: "km" };
      },
    },
    {
      id: "by-provider",
      title: "Rides by provider",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT provider AS label, count(*)::int AS value FROM mobility_ride GROUP BY provider ORDER BY value DESC`,
        );
        return { slices: rows, unit: "rides" };
      },
    },
    {
      id: "spend-month",
      title: "Spend per month",
      type: "bar",
      size: "lg",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(date_trunc('month', day), 'Mon') AS label, round(sum(cost)::numeric, 2) AS value
           FROM mobility_ride GROUP BY date_trunc('month', day) ORDER BY date_trunc('month', day)`,
        );
        return { series: rows, format: "currency" };
      },
    },
    {
      id: "rides-trend",
      title: "Rides per month",
      type: "line",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(date_trunc('month', day), 'Mon') AS label, count(*)::int AS value
           FROM mobility_ride GROUP BY date_trunc('month', day) ORDER BY date_trunc('month', day)`,
        );
        return { series: rows, unit: "rides" };
      },
    },
    {
      id: "recent",
      title: "Recent rides",
      type: "table",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(day, 'YYYY-MM-DD') AS date, provider, distance_km AS distance,
                  duration_min AS minutes, round(cost::numeric, 2) AS cost
           FROM mobility_ride ORDER BY day DESC, id DESC LIMIT 12`,
        );
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "provider", label: "Provider" },
            { key: "distance", label: "km", align: "right" },
            { key: "minutes", label: "Min", align: "right" },
            { key: "cost", label: "Cost", format: "currency", align: "right" },
          ],
          rows,
        };
      },
    },
  ],
};

export default mobility;
