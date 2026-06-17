import type { LifeStackModule } from "../../core/types";

const providerLabelExpr = `multiIf(
  lowerUTF8(provider) LIKE '%uber%', 'Uber 🚕',
  lowerUTF8(provider) LIKE '%bolt%', 'Bolt ⚡',
  lowerUTF8(provider) LIKE '%lime%', 'Lime 🍋‍🟩',
  lowerUTF8(provider) LIKE '%tier%', 'Tier 🛴',
  lowerUTF8(provider) LIKE '%bird%', 'Bird 🛴',
  lowerUTF8(provider) LIKE '%lyft%', 'Lyft 🚕',
  provider
)`;

const rideTypeLabelExpr = `multiIf(
  lowerUTF8(type) LIKE '%scooter%', 'Scooter 🛴',
  lowerUTF8(type) IN ('bike', 'bicycle', 'ebike', 'e-bike', 'cycle'), 'Bike 🚲',
  lowerUTF8(type) IN ('taxi', 'car', 'ride', 'cab'), 'Taxi 🚕',
  type
)`;

const mobility: LifeStackModule = {
  id: "mobility",
  name: "Mobility",
  description:
    "Scooter and ride-hail trips across Uber, Bolt, Lime, Tier, and similar providers.",
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
  connectors: [],
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
          `SELECT ${providerLabelExpr} AS label, toInt32(count()) AS value
           FROM mobility_ride
           GROUP BY label
           ORDER BY value DESC`,
        );
        return { slices: rows, unit: "rides" };
      },
    },
    {
      id: "by-type",
      title: "Rides by type",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT ${rideTypeLabelExpr} AS label, toInt32(count()) AS value
           FROM mobility_ride
           GROUP BY label
           ORDER BY value DESC`,
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
          `SELECT
             toString(day) AS date,
             ${providerLabelExpr} AS provider,
             ${rideTypeLabelExpr} AS ride_type,
             distance_km AS distance,
             duration_min AS minutes,
             round(cost, 2) AS cost
           FROM mobility_ride
           ORDER BY day DESC
           LIMIT 12`,
        );
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "provider", label: "Provider" },
            { key: "ride_type", label: "Type" },
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
