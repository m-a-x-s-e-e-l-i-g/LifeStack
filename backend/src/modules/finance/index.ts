import type { LifeStackModule } from "../../core/types";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const finance: LifeStackModule = {
  id: "finance",
  name: "Finance",
  description: "Bank transfers, monthly cash flow, and spending by category.",
  icon: "💶",
  accent: "oklch(0.74 0.15 155)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS finance_tx (
       day Date,
       description String,
       category String,
       amount Float64
     ) ENGINE = MergeTree ORDER BY day`,
  ],
  connectors: [],
  widgets: [
    {
      id: "net-month",
      title: "Net this month",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ cur: number; prev: number }>(
          `SELECT
             round(sumIf(amount, day >= toStartOfMonth(today())), 2) AS cur,
             round(sumIf(amount, day >= toStartOfMonth(today()) - INTERVAL 1 MONTH
                                 AND day < toStartOfMonth(today())), 2) AS prev
           FROM finance_tx`,
        );
        const cur = rows[0]?.cur ?? 0;
        const prev = rows[0]?.prev ?? 0;
        return {
          value: cur,
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
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(-sumIf(amount, amount < 0 AND day >= toStartOfMonth(today())), 2) AS v
           FROM finance_tx`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
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
        const rows = await ctx.db.query(
          `SELECT category AS label, round(-sum(amount), 2) AS value
           FROM finance_tx WHERE amount < 0 AND day >= today() - INTERVAL 90 DAY
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
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, round(s, 2) AS value
           FROM (SELECT toStartOfMonth(day) AS m, sum(amount) AS s FROM finance_tx
                 WHERE day >= toStartOfMonth(today()) - INTERVAL 11 MONTH GROUP BY m)
           ORDER BY m`,
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
        const rows = await ctx.db.query(
          `WITH daily AS (SELECT day, sum(amount) AS s FROM finance_tx GROUP BY day)
           SELECT formatDateTime(day, '%b %d') AS label,
                  round(sum(s) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2) AS value
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
        const rows = await ctx.db.query(
          `SELECT category AS label, round(-sum(amount), 2) AS value
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
        const rows = await ctx.db.query(
          `SELECT toString(day) AS date, description, category, round(amount, 2) AS amount
           FROM finance_tx ORDER BY day DESC LIMIT 12`,
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
