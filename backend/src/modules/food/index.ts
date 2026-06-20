import type { Connector, LifeStackModule } from "../../core/types";

const inboxFoodScan: Connector = {
  id: "inbox-food",
  name: "Email receipts",
  description: "Control whether inbox scanning imports food delivery receipts into this module.",
  kind: "manual",
  configSchema: [
    {
      key: "scanFood",
      label: "Scan food delivery receipts",
      type: "boolean",
      default: true,
      help: "Uber Eats, Thuisbezorgd, takeaway.com",
    },
  ],
};

const food: LifeStackModule = {
  id: "food",
  name: "Food orders",
  description: "Takeaway and delivery orders from Uber Eats and takeaway.com/thuisbezorgd.",
  icon: "🍜",
  accent: "oklch(0.78 0.15 55)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS food_order (
       day Date,
       provider String,
       merchant String,
       total Float64,
       currency String,
       items Int32,
       delivery_fee Float64,
       service_fee Float64,
       tip Float64,
       notes String,
       source String DEFAULT 'assistant'
     ) ENGINE = MergeTree ORDER BY (day, provider, merchant)`,
  ],
  connectors: [inboxFoodScan],
  widgets: [
    {
      id: "orders-month",
      title: "Orders this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(countIf(day >= toStartOfMonth(today()))) AS v FROM food_order`,
        );
        return { value: rows[0]?.v ?? 0, unit: "orders" };
      },
    },
    {
      id: "spend-month",
      title: "Spend this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sumIf(total, day >= toStartOfMonth(today())), 2) AS v FROM food_order`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "avg-order",
      title: "Average order value",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(avg(total), 2) AS v FROM food_order`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "by-provider",
      title: "Orders by provider",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT provider AS label, toInt32(count()) AS value
           FROM food_order GROUP BY provider ORDER BY value DESC`,
        );
        return { slices: rows, unit: "orders" };
      },
    },
    {
      id: "spend-trend",
      title: "Spend per month",
      type: "bar",
      size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, round(s, 2) AS value
           FROM (SELECT toStartOfMonth(day) AS m, sum(total) AS s FROM food_order GROUP BY m)
           ORDER BY m`,
        );
        return { series: rows, format: "currency" };
      },
    },
    {
      id: "top-merchants",
      title: "Top restaurants",
      type: "list",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ label: string; value: number; sub: string }>(
          `SELECT merchant AS label, round(sum(total), 2) AS value, toString(count()) AS sub
           FROM food_order
           WHERE merchant != ''
           GROUP BY merchant
           ORDER BY value DESC
           LIMIT 8`,
        );
        return { items: rows, format: "currency" };
      },
    },
    {
      id: "recent",
      title: "Recent orders",
      type: "table",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT toString(day) AS date, provider, merchant,
                  round(total, 2) AS total, items
           FROM food_order ORDER BY day DESC LIMIT 12`,
        );
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "provider", label: "Provider" },
            { key: "merchant", label: "Restaurant" },
            { key: "items", label: "Items", align: "right" },
            { key: "total", label: "Total", format: "currency", align: "right" },
          ],
          rows,
        };
      },
    },
  ],
};

export default food;
