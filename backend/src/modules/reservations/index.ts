import type { Connector, LifeStackModule } from "../../core/types";

const inboxReservationsScan: Connector = {
  id: "inbox-reservations",
  name: "Email receipts",
  description:
    "Control whether inbox scanning imports reservation confirmations and tickets into this module.",
  kind: "manual",
  configSchema: [
    {
      key: "scanReservations",
      label: "Scan reservation receipts",
      type: "boolean",
      default: true,
      help: "Restaurants, cinema tickets, spa, swimming pool, and similar bookings",
    },
  ],
};

const reservations: LifeStackModule = {
  id: "reservations",
  name: "Reservations",
  description:
    "Restaurant bookings, cinema tickets, spa visits, pool sessions, and other reservation confirmations.",
  icon: "🎟️",
  accent: "oklch(0.72 0.14 180)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS reservation_entry (
       day Date,
       started_at DateTime64(3) DEFAULT toDateTime64(day, 3),
       category String,
       provider String,
       venue String,
       reservation_ref String,
       guests Int32 DEFAULT 0,
       amount Float64,
       currency String DEFAULT 'EUR',
       amount_eur Float64 DEFAULT amount,
       source String DEFAULT 'inbox',
       message_id String,
       notes String DEFAULT ''
     ) ENGINE = ReplacingMergeTree ORDER BY (day, category, provider, venue, message_id)`,
  ],
  connectors: [inboxReservationsScan],
  widgets: [
    {
      id: "reservations-total",
      title: "Reservations logged",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(count()) AS v FROM reservation_entry FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "bookings" };
      },
    },
    {
      id: "reservation-spend",
      title: "Total booked amount",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(amount_eur), 2) AS v FROM reservation_entry FINAL`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "by-category",
      title: "Bookings by category",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT
             if(category = '', 'other', category) AS label,
             toInt32(count()) AS value
           FROM reservation_entry FINAL
           GROUP BY label
           ORDER BY value DESC, label ASC`,
        );
        return { slices: rows, unit: "bookings" };
      },
    },
    {
      id: "top-venues",
      title: "Top venues",
      type: "list",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ label: string; value: number; sub: string }>(
          `SELECT
             if(venue != '', venue, provider) AS label,
             toInt32(count()) AS value,
             concat('EUR ', toString(round(sum(amount_eur), 2))) AS sub
           FROM reservation_entry FINAL
           GROUP BY label
           ORDER BY value DESC, label ASC
           LIMIT 8`,
        );
        return { items: rows, format: "number" };
      },
    },
    {
      id: "recent",
      title: "Recent reservations",
      type: "table",
      size: "xl",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT
             formatDateTime(started_at, '%Y-%m-%d %H:%i') AS when,
             category,
             provider,
             venue,
             reservation_ref,
             guests,
             round(amount, 2) AS amount,
             upperUTF8(currency) AS currency,
             round(amount_eur, 2) AS amount_eur
           FROM reservation_entry FINAL
           ORDER BY started_at DESC, provider ASC
           LIMIT 20`,
        );
        return {
          columns: [
            { key: "when", label: "When" },
            { key: "category", label: "Category" },
            { key: "provider", label: "Provider" },
            { key: "venue", label: "Venue" },
            { key: "reservation_ref", label: "Ref" },
            { key: "guests", label: "Guests", align: "right" },
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

export default reservations;
