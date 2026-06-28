import type { Connector, LifeStackModule } from "../../core/types";

const inboxFlightsScan: Connector = {
  id: "inbox-flights",
  name: "Email receipts",
  description: "Control whether inbox scanning imports boarding passes and flight receipts.",
  kind: "manual",
  configSchema: [
    {
      key: "scanFlights",
      label: "Scan flight emails",
      type: "boolean",
      default: true,
      help: "Boarding passes, itineraries, and airline receipt emails",
    },
  ],
};

const flights: LifeStackModule = {
  id: "flights",
  name: "Flights",
  description: "Boarding passes and airline receipts parsed from your mailbox.",
  icon: "✈️",
  accent: "oklch(0.72 0.15 210)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS flight_trip (
       day Date,
       departed_at DateTime64(3) DEFAULT toDateTime64(day, 3),
       airline String,
       flight_number String,
       booking_ref String,
       origin_iata String,
       destination_iata String,
       passenger String,
       seat String,
       ticket_total Float64,
       ticket_currency String DEFAULT 'EUR',
       ticket_total_eur Float64 DEFAULT ticket_total,
       source String DEFAULT 'inbox',
       message_id String,
       notes String DEFAULT ''
     ) ENGINE = ReplacingMergeTree ORDER BY (day, airline, flight_number, message_id)`,
  ],
  connectors: [inboxFlightsScan],
  widgets: [
    {
      id: "flights-total",
      title: "Flights logged",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(count()) AS v FROM flight_trip FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "flights" };
      },
    },
    {
      id: "spend-total",
      title: "Total air spend",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(ticket_total_eur), 2) AS v FROM flight_trip FINAL`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "by-airline",
      title: "Flights by airline",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT airline AS label, toInt32(count()) AS value
           FROM flight_trip FINAL
           GROUP BY airline
           ORDER BY value DESC, label ASC`,
        );
        return { slices: rows, unit: "flights" };
      },
    },
    {
      id: "top-routes",
      title: "Top routes",
      type: "list",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ label: string; value: number; sub: string }>(
          `SELECT
             if(origin_iata != '' AND destination_iata != '', concat(origin_iata, ' -> ', destination_iata), 'Unknown route') AS label,
             toInt32(count()) AS value,
             concat('EUR ', toString(round(sum(ticket_total_eur), 2))) AS sub
           FROM flight_trip FINAL
           GROUP BY label
           ORDER BY value DESC, label ASC
           LIMIT 8`,
        );
        return { items: rows, format: "number" };
      },
    },
    {
      id: "recent",
      title: "Recent flights",
      type: "table",
      size: "xl",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT
             formatDateTime(departed_at, '%Y-%m-%d %H:%i') AS departure,
             airline,
             flight_number,
             if(origin_iata != '' AND destination_iata != '', concat(origin_iata, ' -> ', destination_iata), '') AS route,
             booking_ref,
             round(ticket_total, 2) AS amount,
             upperUTF8(ticket_currency) AS currency,
             round(ticket_total_eur, 2) AS amount_eur
           FROM flight_trip FINAL
           ORDER BY departed_at DESC
           LIMIT 20`,
        );
        return {
          columns: [
            { key: "departure", label: "Departure" },
            { key: "airline", label: "Airline" },
            { key: "flight_number", label: "Flight" },
            { key: "route", label: "Route" },
            { key: "booking_ref", label: "Booking" },
            { key: "amount", label: "Amount", align: "right" },
            { key: "currency", label: "Cur." },
            { key: "amount_eur", label: "EUR", format: "currency", align: "right" },
          ],
          rows,
        };
      },
    },
  ],
};

export default flights;