import type { Connector, ConnectorContext, LifeStackModule } from "../../core/types";

const inboxGroceries: Connector = {
  id: "inbox-groceries",
  name: "Email receipts",
  description: "Control whether inbox scanning imports grocery receipts into this module.",
  kind: "manual",
  configSchema: [
    {
      key: "scanGroceries",
      label: "Scan grocery receipts",
      type: "boolean",
      default: true,
      help: "Albert Heijn, Jumbo, and other grocers",
    },
  ],
};

const groceries: LifeStackModule = {
  id: "groceries",
  name: "Groceries",
  description: "Track grocery shopping and spending from supermarket receipts.",
  icon: "🛒",
  accent: "oklch(0.68 0.15 142)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS grocery_receipt (
       day Date,
       id UUID DEFAULT generateUUIDv4(),
       message_id String,
       store String,
       amount Decimal64(2),
       currency String,
       cost_eur Decimal64(2),
       items_count UInt32 DEFAULT 0,
       created_at DateTime DEFAULT now()
     ) ENGINE = ReplacingMergeTree ORDER BY (day, store)`,
  ],
  connectors: [inboxGroceries],
  widgets: [
    {
      id: "total-spent",
      title: "Total spent",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toDecimal64(sum(cost_eur), 2) AS v FROM grocery_receipt FINAL`,
        );
        return { value: (rows[0]?.v ?? 0).toFixed(2), unit: "EUR" };
      },
    },
    {
      id: "by-store",
      title: "Spending by store",
      type: "donut",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT store AS label, toDecimal64(sum(cost_eur), 2) AS value
           FROM grocery_receipt FINAL
           GROUP BY store
           ORDER BY value DESC`,
        );
        return { slices: rows, unit: "EUR" };
      },
    },
    {
      id: "receipts",
      title: "Recent receipts",
      type: "table",
      size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT day, store, amount, currency, cost_eur, items_count
           FROM grocery_receipt FINAL
           ORDER BY day DESC
           LIMIT 50`,
        );
        return {
          columns: [
            { key: "day", label: "Date", format: "date" },
            { key: "store", label: "Store" },
            { key: "items_count", label: "Items" },
            { key: "amount", label: "Amount", align: "right" },
            { key: "currency", label: "Currency" },
            { key: "cost_eur", label: "EUR", align: "right", format: "decimal" },
          ],
          rows,
        };
      },
    },
  ],
};

export default groceries;
