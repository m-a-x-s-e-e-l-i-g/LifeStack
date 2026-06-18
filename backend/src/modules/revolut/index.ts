import type { Connector, ConnectorContext, LifeStackModule, SyncResult } from "../../core/types";

interface RevolutTransaction {
  id: string;
  description: string;
  amount: number;
  currency: string;
  state: string;
  started_date: string;
  completed_date?: string;
}

const EUR_PER_UNIT: Record<string, number> = {
  EUR: 1,
  CZK: 0.0402,
  USD: 0.93,
  GBP: 1.18,
  PLN: 0.235,
  CHF: 1.04,
  SEK: 0.086,
  NOK: 0.086,
  DKK: 0.134,
  HUF: 0.0025,
};

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function toEur(amount: number, currency: string): number {
  const rate = EUR_PER_UNIT[currency] ?? 1;
  return round2(Math.abs(amount) * rate);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const revolutApi: Connector = {
  id: "revolut-api",
  name: "Revolut",
  description: "Sync your Revolut transactions for financial tracking.",
  kind: "api",
  syncIntervalMinutes: 60,
  hasAuthorize: true,
  configSchema: [
    {
      key: "accessToken",
      label: "Access token",
      type: "password",
      secret: true,
      help: "OAuth token from Revolut Business API (set automatically after authorization).",
    },
    {
      key: "accountId",
      label: "Account ID",
      type: "text",
      help: "Revolut account/business ID to sync transactions from.",
    },
    { key: "lookbackDays", label: "Look back days", type: "number", default: 90 },
  ],
  async authorize(ctx, input) {
    if (input.disconnect) {
      await ctx.saveConfig({ accessToken: "", accountId: "" });
      return { message: "Disconnected from Revolut." };
    }
    throw new Error("Revolut OAuth setup required. Visit https://developer.revolut.com to create an app and retrieve your access token.");
  },
  async sync(ctx): Promise<SyncResult> {
    const token = String(ctx.config.accessToken ?? "").trim();
    const accountId = String(ctx.config.accountId ?? "").trim();
    const lookbackDays = Math.max(1, Math.round(Number(ctx.config.lookbackDays ?? 90)));

    if (!token || !accountId) throw new Error("Configure access token and account ID first.");

    const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    const to = new Date();

    try {
      const res = await fetch(
        `https://api.revolut.com/1.0/accounts/${accountId}/transactions?from=${from.toISOString()}&to=${to.toISOString()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (res.status === 401) throw new Error("Invalid or expired Revolut token. Reconnect to refresh.");
      if (!res.ok) throw new Error(`Revolut API error ${res.status}`);

      const txns = (await res.json()) as RevolutTransaction[];
      const rows: Record<string, unknown>[] = [];
      let inserted = 0;

      for (const txn of txns) {
        if (txn.state !== "COMPLETED") continue;
        const date = txn.completed_date || txn.started_date;
        if (!date) continue;

        rows.push({
          day: isoDay(new Date(date)),
          txn_id: txn.id,
          description: txn.description,
          amount: round2(txn.amount),
          currency: txn.currency,
          amount_eur: toEur(txn.amount, txn.currency),
          date: date,
        });
      }

      if (rows.length > 0) {
        await ctx.db.insert("revolut_transaction", rows);
        inserted = rows.length;
      }

      return { inserted, message: `Synced ${inserted} transaction(s) from Revolut.` };
    } catch (e) {
      throw new Error(`Revolut sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

const revolut: LifeStackModule = {
  id: "revolut",
  name: "Finance",
  description: "Track spending and income from Revolut and other financial accounts.",
  icon: "💳",
  accent: "oklch(0.71 0.18 285)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS revolut_transaction (
       day Date,
       txn_id String,
       description String,
       amount Decimal64(2),
       currency String,
       amount_eur Decimal64(2),
       date DateTime,
       created_at DateTime DEFAULT now()
     ) ENGINE = ReplacingMergeTree ORDER BY (day, txn_id)`,
  ],
  connectors: [revolutApi],
  widgets: [
    {
      id: "net-flow",
      title: "Net flow",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toDecimal64(sum(amount_eur), 2) AS v FROM revolut_transaction FINAL`,
        );
        const val = rows[0]?.v ?? 0;
        return {
          value: val.toFixed(2),
          unit: "EUR",
          delta: val > 0 ? 1 : val < 0 ? -1 : 0,
          deltaLabel: val > 0 ? "income" : val < 0 ? "expenses" : "neutral",
        };
      },
    },
    {
      id: "income-vs-expense",
      title: "Income vs Expenses",
      type: "split",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ kind: string; amount: number }>(
          `SELECT
             if(amount_eur > 0, 'Income', 'Expenses') AS kind,
             toDecimal64(sum(abs(amount_eur)), 2) AS amount
           FROM revolut_transaction FINAL
           GROUP BY kind`,
        );
        const parts = [
          { label: "Income", value: rows.find((r) => r.kind === "Income")?.amount ?? 0, unit: "EUR" },
          { label: "Expenses", value: rows.find((r) => r.kind === "Expenses")?.amount ?? 0, unit: "EUR" },
        ];
        return { parts };
      },
    },
    {
      id: "transactions",
      title: "Recent transactions",
      type: "table",
      size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT day, description, amount, currency, amount_eur
           FROM revolut_transaction FINAL
           ORDER BY day DESC
           LIMIT 100`,
        );
        return {
          columns: [
            { key: "day", label: "Date", format: "date" },
            { key: "description", label: "Description" },
            { key: "amount", label: "Amount", align: "right" },
            { key: "currency", label: "Currency" },
            { key: "amount_eur", label: "EUR", align: "right", format: "decimal" },
          ],
          rows,
        };
      },
    },
  ],
};

export default revolut;
