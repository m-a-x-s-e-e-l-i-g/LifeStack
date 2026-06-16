import type { Connector, LifeStackModule, ModuleContext } from "../../core/types";
import { alreadySeeded, daysAgo, insertMany, iso, pick, rand, randInt, round2 } from "../_demo";

const EXPENSES: [string, string, number, number][] = [
  ["Groceries", "Supermarket", 8, 65],
  ["Dining", "Restaurant", 12, 55],
  ["Transport", "Transit / parking", 3, 28],
  ["Entertainment", "Streaming & cinema", 6, 30],
  ["Shopping", "Online order", 12, 140],
  ["Health", "Pharmacy", 5, 45],
  ["Coffee", "Cafe", 3, 9],
];

const COLUMNS = ["day", "description", "category", "amount"];

async function seed(ctx: ModuleContext): Promise<void> {
  if (await alreadySeeded(ctx, "finance_tx")) return;
  const rows: unknown[][] = [];
  for (let i = 280; i >= 0; i--) {
    const d = daysAgo(i);
    if (d.getDate() === 1) {
      rows.push([iso(d), "Monthly salary", "Income", round2(2800 + rand(-120, 240))]);
      rows.push([iso(d), "Apartment rent", "Rent", -1250]);
    }
    if (d.getDate() === 5)
      rows.push([iso(d), "Electricity & water", "Utilities", -round2(rand(80, 165))]);
    const n = randInt(0, 3);
    for (let k = 0; k < n; k++) {
      const [category, description, lo, hi] = pick(EXPENSES);
      rows.push([iso(d), description, category, -round2(rand(lo, hi))]);
    }
  }
  await insertMany(ctx, "finance_tx", COLUMNS, rows);
}

const csv: Connector = {
  id: "csv",
  name: "CSV / JSON import",
  description: "Import a bank export. Rows: {day, description, category, amount} (negative = expense).",
  kind: "import",
  async import(ctx, rows) {
    const values = rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => [
        String(r.day ?? r.date ?? iso(new Date())).slice(0, 10),
        String(r.description ?? "Imported"),
        String(r.category ?? "Uncategorized"),
        Number(r.amount ?? 0),
      ]);
    await insertMany(ctx, "finance_tx", COLUMNS, values);
    return { inserted: values.length };
  },
};

const finance: LifeStackModule = {
  id: "finance",
  name: "Finance",
  description: "Bank transfers, monthly cash flow, and spending by category.",
  icon: "💶",
  accent: "oklch(0.74 0.15 155)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS finance_tx (
       id serial PRIMARY KEY,
       day date NOT NULL,
       description text NOT NULL,
       category text NOT NULL,
       amount numeric NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS finance_tx_day_idx ON finance_tx (day)`,
  ],
  connectors: [csv],
  seed,
  widgets: [
    {
      id: "net-month",
      title: "Net this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ cur: number; prev: number }>(
          `SELECT
             coalesce(sum(amount) FILTER (WHERE day >= date_trunc('month', now())), 0) AS cur,
             coalesce(sum(amount) FILTER (WHERE day >= date_trunc('month', now()) - interval '1 month'
                                            AND day < date_trunc('month', now())), 0) AS prev
           FROM finance_tx`,
        );
        const { cur, prev } = rows[0];
        return {
          value: round2(cur),
          format: "currency",
          delta: round2(cur - prev),
          deltaLabel: "vs last month",
        };
      },
    },
    {
      id: "spend-month",
      title: "Spent this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT coalesce(-sum(amount) FILTER (WHERE amount < 0 AND day >= date_trunc('month', now())), 0) AS v
           FROM finance_tx`,
        );
        return { value: round2(rows[0].v), format: "currency" };
      },
    },
    {
      id: "by-category",
      title: "Spending by category",
      subtitle: "Last 90 days",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT category AS label, round((-sum(amount))::numeric, 2) AS value
           FROM finance_tx WHERE amount < 0 AND day >= now() - interval '90 days'
           GROUP BY category ORDER BY value DESC`,
        );
        return { slices: rows, format: "currency" };
      },
    },
    {
      id: "cashflow",
      title: "Monthly cash flow",
      subtitle: "Net per month",
      type: "bar",
      size: "lg",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(date_trunc('month', day), 'Mon') AS label, round(sum(amount)::numeric, 2) AS value
           FROM finance_tx WHERE day >= date_trunc('month', now()) - interval '11 months'
           GROUP BY date_trunc('month', day) ORDER BY date_trunc('month', day)`,
        );
        return { series: rows, format: "currency", signed: true };
      },
    },
    {
      id: "balance",
      title: "Balance trend",
      type: "line",
      size: "lg",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `WITH daily AS (SELECT day, sum(amount) AS s FROM finance_tx GROUP BY day)
           SELECT to_char(day, 'Mon DD') AS label, round((sum(s) OVER (ORDER BY day))::numeric, 2) AS value
           FROM daily ORDER BY day`,
        );
        return { series: rows, format: "currency" };
      },
    },
    {
      id: "top-categories",
      title: "Top spend categories",
      type: "list",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT category AS label, round((-sum(amount))::numeric, 2) AS value
           FROM finance_tx WHERE amount < 0 GROUP BY category ORDER BY value DESC LIMIT 6`,
        );
        return { items: rows, format: "currency" };
      },
    },
    {
      id: "recent",
      title: "Recent transactions",
      type: "table",
      size: "lg",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(day, 'YYYY-MM-DD') AS date, description, category, round(amount::numeric, 2) AS amount
           FROM finance_tx ORDER BY day DESC, id DESC LIMIT 12`,
        );
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "description", label: "Description" },
            { key: "category", label: "Category" },
            { key: "amount", label: "Amount", format: "currency", align: "right" },
          ],
          rows,
        };
      },
    },
  ],
};

export default finance;
