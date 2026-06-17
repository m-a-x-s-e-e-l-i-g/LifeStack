import type { LifeStackModule } from "../../core/types";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const fuel: LifeStackModule = {
  id: "fuel",
  name: "Fuel",
  description: "Fill-ups, fuel economy, and price per liter over time.",
  icon: "⛽",
  accent: "oklch(0.73 0.16 55)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS fuel_fillup (
       day Date,
       liters Float64,
       price_per_liter Float64,
       cost Float64,
       odometer Int32
     ) ENGINE = ReplacingMergeTree ORDER BY odometer`,
  ],
  connectors: [],
  widgets: [
    {
      id: "avg-consumption",
      title: "Average economy",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        // Distance between consecutive fill-ups is computed in JS to avoid
        // window-function edge cases on a deduplicated table.
        const rows = await ctx.db.query<{ liters: number; odometer: number }>(
          `SELECT liters, odometer FROM fuel_fillup FINAL ORDER BY odometer`,
        );
        let litres = 0;
        let dist = 0;
        for (let i = 1; i < rows.length; i++) {
          const d = rows[i].odometer - rows[i - 1].odometer;
          if (d > 0) {
            dist += d;
            litres += rows[i].liters;
          }
        }
        return { value: dist > 0 ? round2((litres / dist) * 100) : 0, unit: "L/100km" };
      },
    },
    {
      id: "total-spent",
      title: "Total fuel spend",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(cost), 2) AS v FROM fuel_fillup FINAL`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "latest-price",
      title: "Latest price",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT price_per_liter AS v FROM fuel_fillup FINAL ORDER BY day DESC LIMIT 1`,
        );
        return { value: rows[0]?.v ?? 0, unit: "€/L" };
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
        const rows = await ctx.db.query<{
          label: string;
          liters: number;
          odometer: number;
        }>(
          `SELECT formatDateTime(day, '%b %d') AS label, liters, odometer
           FROM fuel_fillup FINAL ORDER BY odometer`,
        );
        const series: { label: string; value: number }[] = [];
        for (let i = 1; i < rows.length; i++) {
          const d = rows[i].odometer - rows[i - 1].odometer;
          if (d > 0) series.push({ label: rows[i].label, value: round2((rows[i].liters / d) * 100) });
        }
        return { series, unit: "L/100km" };
      },
    },
    {
      id: "price-trend",
      title: "Price per liter",
      type: "line",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT formatDateTime(day, '%b %d') AS label, price_per_liter AS value
           FROM fuel_fillup FINAL ORDER BY day`,
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
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, round(s, 2) AS value
           FROM (SELECT toStartOfMonth(day) AS m, sum(cost) AS s FROM fuel_fillup FINAL GROUP BY m)
           ORDER BY m`,
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
        const rows = await ctx.db.query(
          `SELECT toString(day) AS date, liters, price_per_liter AS price,
                  round(cost, 2) AS cost, odometer
           FROM fuel_fillup FINAL ORDER BY day DESC LIMIT 12`,
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
