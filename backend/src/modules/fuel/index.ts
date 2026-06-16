import type { Connector, LifeStackModule, ModuleContext } from "../../core/types";
import { alreadySeeded, daysAgo, insertMany, iso, rand, randInt, round2 } from "../_demo";

const COLUMNS = ["day", "liters", "price_per_liter", "cost", "odometer"];

async function seed(ctx: ModuleContext): Promise<void> {
  if (await alreadySeeded(ctx, "fuel_fillup")) return;
  const rows: unknown[][] = [];
  let odometer = 45000;
  for (let i = 0; i < 24; i++) {
    const day = daysAgo(288 - i * 12);
    const dist = randInt(450, 720);
    odometer += dist;
    const liters = round2((dist / 100) * rand(6.4, 8.4));
    const pricePerLiter = round2(1.72 + i * 0.004 + rand(-0.05, 0.05));
    rows.push([iso(day), liters, pricePerLiter, round2(liters * pricePerLiter), odometer]);
  }
  await insertMany(ctx, "fuel_fillup", COLUMNS, rows);
}

const csv: Connector = {
  id: "csv",
  name: "CSV / JSON import",
  description: "Import fill-ups. Rows: {day, liters, price_per_liter, odometer}.",
  kind: "import",
  async import(ctx, rows) {
    const values = rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => {
        const liters = Number(r.liters ?? 0);
        const ppl = Number(r.price_per_liter ?? r.pricePerLiter ?? 0);
        return [
          String(r.day ?? r.date ?? iso(new Date())).slice(0, 10),
          liters,
          ppl,
          Number(r.cost ?? round2(liters * ppl)),
          Number(r.odometer ?? 0),
        ];
      });
    await insertMany(ctx, "fuel_fillup", COLUMNS, values);
    return { inserted: values.length };
  },
};

const fuel: LifeStackModule = {
  id: "fuel",
  name: "Fuel",
  description: "Fill-ups, fuel economy, and price per liter over time.",
  icon: "⛽",
  accent: "oklch(0.73 0.16 55)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS fuel_fillup (
       id serial PRIMARY KEY,
       day date NOT NULL,
       liters numeric NOT NULL,
       price_per_liter numeric NOT NULL,
       cost numeric NOT NULL,
       odometer integer NOT NULL
     )`,
  ],
  connectors: [csv],
  seed,
  widgets: [
    {
      id: "avg-consumption",
      title: "Average economy",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `WITH f AS (SELECT liters, odometer - lag(odometer) OVER (ORDER BY odometer) AS dist FROM fuel_fillup)
           SELECT round((coalesce(sum(liters) FILTER (WHERE dist > 0)
                 / nullif(sum(dist) FILTER (WHERE dist > 0), 0) * 100, 0))::numeric, 2) AS v FROM f`,
        );
        return { value: rows[0].v, unit: "L/100km" };
      },
    },
    {
      id: "total-spent",
      title: "Total fuel spend",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT coalesce(sum(cost), 0) AS v FROM fuel_fillup`,
        );
        return { value: round2(rows[0].v), format: "currency" };
      },
    },
    {
      id: "latest-price",
      title: "Latest price",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT coalesce((SELECT price_per_liter FROM fuel_fillup ORDER BY day DESC LIMIT 1), 0) AS v`,
        );
        return { value: rows[0].v, unit: "€/L" };
      },
    },
    {
      id: "economy-trend",
      title: "Fuel economy per fill-up",
      subtitle: "L/100km",
      type: "line",
      size: "lg",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `WITH f AS (SELECT day, liters, odometer - lag(odometer) OVER (ORDER BY odometer) AS dist FROM fuel_fillup)
           SELECT to_char(day, 'Mon DD') AS label, round((liters / nullif(dist, 0) * 100)::numeric, 2) AS value
           FROM f WHERE dist > 0 ORDER BY day`,
        );
        return { series: rows, unit: "L/100km" };
      },
    },
    {
      id: "price-trend",
      title: "Price per liter",
      type: "line",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(day, 'Mon DD') AS label, price_per_liter AS value FROM fuel_fillup ORDER BY day`,
        );
        return { series: rows, format: "currency" };
      },
    },
    {
      id: "cost-month",
      title: "Cost per month",
      type: "bar",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(date_trunc('month', day), 'Mon') AS label, round(sum(cost)::numeric, 2) AS value
           FROM fuel_fillup GROUP BY date_trunc('month', day) ORDER BY date_trunc('month', day)`,
        );
        return { series: rows, format: "currency" };
      },
    },
    {
      id: "recent",
      title: "Recent fill-ups",
      type: "table",
      size: "lg",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(day, 'YYYY-MM-DD') AS date, liters, price_per_liter AS price,
                  round(cost::numeric, 2) AS cost, odometer
           FROM fuel_fillup ORDER BY day DESC LIMIT 12`,
        );
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "liters", label: "Liters", align: "right" },
            { key: "price", label: "€/L", format: "currency", align: "right" },
            { key: "cost", label: "Cost", format: "currency", align: "right" },
            { key: "odometer", label: "Odometer", align: "right" },
          ],
          rows,
        };
      },
    },
  ],
};

export default fuel;
