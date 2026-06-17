import type { Connector, LifeStackModule } from "../../core/types";

const csv: Connector = {
  id: "csv",
  name: "CSV / JSON import",
  description: "Import rides. Rows: {day, provider, type, distance_km, duration_min, cost}.",
  kind: "import",
  async import(ctx, rows) {
    const values = rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => ({
        day: String(r.day ?? r.date ?? new Date().toISOString()).slice(0, 10),
        provider: String(r.provider ?? "Unknown"),
        type: String(r.type ?? "car"),
        distance_km: Number(r.distance_km ?? r.distance ?? 0),
        duration_min: Number(r.duration_min ?? r.duration ?? 0),
        cost: Number(r.cost ?? 0),
      }));
    await ctx.db.insert("mobility_ride", values);
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
       day Date,
       provider String,
       type String,
       distance_km Float64,
       duration_min Int32,
       cost Float64
     ) ENGINE = MergeTree ORDER BY day`,
  ],
  connectors: [csv],
  widgets: [
    {
      id: "rides-month",
      title: "Rides this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(countIf(day >= toStartOfMonth(today()))) AS v FROM mobility_ride`,
        );
        return { value: rows[0]?.v ?? 0, unit: "rides" };
      },
    },
    {
      id: "total-spent",
      title: "Total spend",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(cost), 2) AS v FROM mobility_ride`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "total-distance",
      title: "Distance traveled",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(distance_km), 1) AS v FROM mobility_ride`,
        );
        return { value: rows[0]?.v ?? 0, unit: "km" };
      },
    },
    {
      id: "by-provider",
      title: "Rides by provider",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT provider AS label, toInt32(count()) AS value
           FROM mobility_ride GROUP BY provider ORDER BY value DESC`,
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
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, round(s, 2) AS value
           FROM (SELECT toStartOfMonth(day) AS m, sum(cost) AS s FROM mobility_ride GROUP BY m)
           ORDER BY m`,
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
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, toInt32(c) AS value
           FROM (SELECT toStartOfMonth(day) AS m, count() AS c FROM mobility_ride GROUP BY m)
           ORDER BY m`,
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
        const rows = await ctx.db.query(
          `SELECT toString(day) AS date, provider, distance_km AS distance,
                  duration_min AS minutes, round(cost, 2) AS cost
           FROM mobility_ride ORDER BY day DESC LIMIT 12`,
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
