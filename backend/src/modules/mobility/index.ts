import type { Connector, LifeStackModule } from "../../core/types";

const providerLabelExpr = `multiIf(
  lowerUTF8(provider) LIKE '%uber%', 'Uber',
  lowerUTF8(provider) LIKE '%bolt%', 'Bolt',
  lowerUTF8(provider) LIKE '%lime%', 'Lime',
  lowerUTF8(provider) LIKE '%tier%', 'Tier',
  lowerUTF8(provider) LIKE '%bird%', 'Bird',
  lowerUTF8(provider) LIKE '%lyft%', 'Lyft',
  provider
)`;

const rideTypeLabelExpr = `multiIf(
  lowerUTF8(type) IN ('bike', 'bicycle', 'ebike', 'e-bike', 'cycle'), 'Bike 🚲',
  lowerUTF8(type) LIKE '%scooter%', 'Scooter 🛴',
  lowerUTF8(type) IN ('taxi', 'car', 'ride', 'cab'), 'Taxi 🚕',
  type
)`;

const inboxMobilityScan: Connector = {
  id: "inbox-mobility",
  name: "Email receipts",
  description: "Control whether inbox scanning imports mobility rides into this module.",
  kind: "manual",
  configSchema: [
    {
      key: "scanMobility",
      label: "Scan mobility receipts",
      type: "boolean",
      default: true,
      help: "Uber, Lime, Bolt rides and scooters",
    },
  ],
};

const mobility: LifeStackModule = {
  id: "mobility",
  name: "Mobility",
  description:
    "Bike, scooter, and ride-hail trips across Uber, Bolt, Lime, Tier, and similar providers.",
  icon: "🛴",
  accent: "oklch(0.68 0.15 250)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS mobility_ride (
       day Date,
      started_at DateTime64(3) DEFAULT toDateTime64(day, 3),
      provider String,
      type String,
      distance_km Float64,
      duration_min Int32,
      cost Float64,
      cost_currency String DEFAULT 'EUR',
      cost_eur Float64 DEFAULT cost
     ) ENGINE = MergeTree ORDER BY day`,
    `ALTER TABLE mobility_ride ADD COLUMN IF NOT EXISTS started_at DateTime64(3) DEFAULT toDateTime64(day, 3) AFTER day`,
    `ALTER TABLE mobility_ride ADD COLUMN IF NOT EXISTS cost_currency String DEFAULT 'EUR' AFTER cost`,
    `ALTER TABLE mobility_ride ADD COLUMN IF NOT EXISTS cost_eur Float64 DEFAULT cost AFTER cost_currency`,
    // Recalculate cost_eur based on cost_currency for all rows
    `ALTER TABLE mobility_ride UPDATE cost_eur = CASE 
       WHEN cost_currency = 'EUR' THEN cost
       WHEN cost_currency = 'CZK' THEN round(cost * 0.0402, 2)
       WHEN cost_currency = 'USD' THEN round(cost * 0.93, 2)
       WHEN cost_currency = 'GBP' THEN round(cost * 1.18, 2)
       WHEN cost_currency = 'PLN' THEN round(cost * 0.235, 2)
       WHEN cost_currency = 'CHF' THEN round(cost * 1.04, 2)
       WHEN cost_currency = 'SEK' THEN round(cost * 0.086, 2)
       WHEN cost_currency = 'NOK' THEN round(cost * 0.086, 2)
       WHEN cost_currency = 'DKK' THEN round(cost * 0.134, 2)
       WHEN cost_currency = 'HUF' THEN round(cost * 0.0025, 2)
       ELSE cost
     END WHERE cost_eur = cost AND cost_currency != 'EUR'`,
    `CREATE TABLE IF NOT EXISTS mobility_lime_pass (
      day Date,
      created_at DateTime64(3) DEFAULT now64(3),
      cost Float64,
      cost_currency String DEFAULT 'EUR',
      cost_eur Float64 DEFAULT cost,
      description String DEFAULT '',
      notes String DEFAULT ''
     ) ENGINE = MergeTree ORDER BY day`,
  ],
  connectors: [inboxMobilityScan],
  widgets: [
    {
     id: "total-spent",
     title: "Total spend",
     type: "metric",
     size: "sm",
     featured: true,
     async query(ctx) {
       const rows = await ctx.db.query<{ rides: number; passes: number; total: number }>(
        `SELECT 
           round(sum(cost_eur), 2) AS rides,
           (SELECT round(sum(cost_eur), 2) FROM mobility_lime_pass) AS passes,
           round(sum(cost_eur), 2) + coalesce((SELECT round(sum(cost_eur), 2) FROM mobility_lime_pass), 0) AS total
         FROM mobility_ride`,
       );
       const r = rows[0] ?? { rides: 0, passes: 0, total: 0 };
       return { value: r.total, format: "currency" };
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
      id: "avg-speed-by-type",
      title: "Average speed",
      type: "split",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ bike: number; scooter: number }>(
          `SELECT
             round(
               if(
                 sumIf(duration_min, lowerUTF8(type) = 'bike' AND duration_min > 0 AND distance_km > 0) = 0,
                 0,
                 sumIf(distance_km, lowerUTF8(type) = 'bike' AND duration_min > 0 AND distance_km > 0) * 60.0
                   / sumIf(duration_min, lowerUTF8(type) = 'bike' AND duration_min > 0 AND distance_km > 0)
               ),
               1
             ) AS bike,
             round(
               if(
                 sumIf(duration_min, lowerUTF8(type) = 'scooter' AND duration_min > 0 AND distance_km > 0) = 0,
                 0,
                 sumIf(distance_km, lowerUTF8(type) = 'scooter' AND duration_min > 0 AND distance_km > 0) * 60.0
                   / sumIf(duration_min, lowerUTF8(type) = 'scooter' AND duration_min > 0 AND distance_km > 0)
               ),
               1
             ) AS scooter
           FROM mobility_ride`,
        );
        const r = rows[0] ?? { bike: 0, scooter: 0 };
        return {
          parts: [
            { label: "Bike", value: r.bike, unit: "km/h", format: "number" },
            { label: "Scooter", value: r.scooter, unit: "km/h", format: "number" },
          ],
        };
      },
    },
    {
      id: "top-speed-by-type",
      title: "Highest average speed",
      type: "list",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ label: string; value: number; sub: string }>(
          `SELECT
             if(kind = 'bike', 'Bike', 'Scooter') AS label,
             round(max(avg_speed), 1) AS value,
             concat(toString(argMax(day, avg_speed)), ' · ', argMax(${providerLabelExpr}, avg_speed)) AS sub
           FROM (
             SELECT
               lowerUTF8(type) AS kind,
               day,
               provider,
               distance_km * 60.0 / duration_min AS avg_speed
             FROM mobility_ride
             WHERE duration_min > 0
               AND distance_km > 0
               AND lowerUTF8(type) IN ('bike', 'scooter')
           )
           GROUP BY kind
           ORDER BY label ASC`,
        );
        return { items: rows, format: "number" };
      },
    },
    {
      id: "provider-summary",
      title: "Provider summary",
      type: "cards",
      size: "xl",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT
            label,
            rides,
            total_distance_km AS distance_km,
            total_cost_eur AS cost,
            bike_rides,
            bike_km,
            scooter_rides,
            scooter_km,
            taxi_rides,
            taxi_km,
            round(if(rides = 0, 0, total_cost_eur / rides), 2) AS avg_cost
           FROM (
             SELECT
               ${providerLabelExpr} AS label,
               toInt32(count()) AS rides,
               round(sum(distance_km), 1) AS total_distance_km,
               round(sum(cost_eur), 2) AS total_cost_eur,
               toInt32(countIf(lowerUTF8(type) = 'bike')) AS bike_rides,
               round(sumIf(distance_km, lowerUTF8(type) = 'bike'), 1) AS bike_km,
               toInt32(countIf(lowerUTF8(type) = 'scooter')) AS scooter_rides,
               round(sumIf(distance_km, lowerUTF8(type) = 'scooter'), 1) AS scooter_km,
               toInt32(countIf(lowerUTF8(type) = 'taxi')) AS taxi_rides,
               round(sumIf(distance_km, lowerUTF8(type) = 'taxi'), 1) AS taxi_km
             FROM mobility_ride
             GROUP BY label
           )
           ORDER BY rides DESC`,
        );
        return { cards: rows };
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
      id: "km-by-type",
      title: "km per type",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT ${rideTypeLabelExpr} AS label, round(sum(distance_km), 1) AS value
           FROM mobility_ride
           WHERE distance_km > 0
           GROUP BY label
           ORDER BY value DESC`,
        );
        return { slices: rows, unit: "km" };
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
          FROM (SELECT toStartOfMonth(day) AS m, sum(cost_eur) AS s FROM mobility_ride GROUP BY m)
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
      title: "Ride history",
      type: "table",
      size: "xl",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT
            formatDateTime(coalesce(started_at, toDateTime64(day, 3)), '%Y-%m-%d %H:%i') AS timestamp,
            ${providerLabelExpr} AS provider,
            ${rideTypeLabelExpr} AS ride_type,
            distance_km AS distance,
            duration_min AS minutes,
            round(if(duration_min > 0, distance_km * 60.0 / duration_min, 0), 1) AS avg_speed,
            round(cost, 2) AS cost_original,
            upperUTF8(cost_currency) AS currency,
            round(cost_eur, 2) AS cost_eur,
            concat(
              '/m/mobility/rides/edit?',
              'day=', toString(day),
              '&started_at=', encodeURLComponent(formatDateTime(coalesce(started_at, toDateTime64(day, 3)), '%Y-%m-%d %H:%i:%s')),
              '&provider=', encodeURLComponent(provider),
              '&type=', encodeURLComponent(type),
              '&distance_km=', toString(distance_km),
              '&duration_min=', toString(duration_min),
              '&cost=', toString(cost),
              '&cost_currency=', encodeURLComponent(upperUTF8(cost_currency))
            ) AS edit_href
           FROM mobility_ride
           ORDER BY coalesce(started_at, toDateTime64(day, 3)) DESC, provider ASC, ride_type ASC`,
        );
        return {
          columns: [
           { key: "timestamp", label: "Timestamp" },
           { key: "provider", label: "Provider", format: "provider" },
           { key: "ride_type", label: "Type" },
           { key: "distance", label: "km", align: "right" },
           { key: "minutes", label: "Min", align: "right" },
           { key: "avg_speed", label: "Avg km/h", align: "right" },
           { key: "cost_original", label: "Original", align: "right" },
           { key: "currency", label: "Cur." },
           { key: "cost_eur", label: "EUR", format: "currency", align: "right" },
          ],
          rows,
        };
      },
    },
  ],
};

export default mobility;
