import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Readable } from "node:stream";
import type { Connector, ConnectorContext, LifeStackModule } from "../../core/types";

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

type ProviderKind = "mobility" | "food" | "groceries";

interface Candidate {
  kind: ProviderKind;
  provider: string;
  messageId: string;
  day: string;
  startedAt: string;
  amount: number;
  currency: string;
  distanceKm: number;
  durationMin: number;
  type: string;
  merchant: string;
  itemsCount?: number;
}

function toNum(v: string): number {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function normCurrency(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (!v) return "EUR";
  if (v === "€" || v === "EUR") return "EUR";
  if (v === "KČ" || v === "KC" || v === "CZK") return "CZK";
  if (v === "$" || v === "USD") return "USD";
  if (v === "£" || v === "GBP") return "GBP";
  if (v === "ZŁ" || v === "PLN") return "PLN";
  return /^[A-Z]{3}$/.test(v) ? v : "EUR";
}

function toEur(amount: number, currency: string): number {
  const rate = EUR_PER_UNIT[currency] ?? 1;
  return round2(amount * rate);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function pickAmount(text: string): { amount: number; currency: string } {
  const t = text.replace(/\s+/g, " ");
  const symbolFirst = t.match(/(?:€|\$|£)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i);
  if (symbolFirst) {
    const symbol = t[symbolFirst.index ?? 0];
    return {
      amount: toNum(symbolFirst[1]),
      currency: normCurrency(symbol),
    };
  }
  const codeAfter = t.match(/([0-9]+(?:[.,][0-9]{1,2})?)\s*(EUR|CZK|USD|GBP|PLN|CHF|SEK|NOK|DKK|HUF|KČ|KC|€|\$|£)\b/i);
  if (codeAfter) {
    return {
      amount: toNum(codeAfter[1]),
      currency: normCurrency(codeAfter[2]),
    };
  }
  return { amount: 0, currency: "EUR" };
}

function pickDistanceKm(text: string): number {
  const m = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*km\b/i);
  return m ? toNum(m[1]) : 0;
}

function pickDurationMin(text: string): number {
  const m = text.match(/([0-9]{1,3})\s*(?:min|mins|minutes)\b/i);
  return m ? Math.round(toNum(m[1])) : 0;
}

function pickMerchant(text: string): string {
  const patterns = [
    /order from\s+([^\n\r,]+)/i,
    /bestelling bij\s+([^\n\r,]+)/i,
    /restaurant[:\s]+([^\n\r,]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim().slice(0, 120);
  }
  return "";
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function enabled(cfg: Record<string, unknown>, key: string, fallback = true): boolean {
  const v = cfg[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
}

function detectCandidates(
  text: string,
  messageId: string,
  date: Date,
  cfg: Record<string, unknown>,
): Candidate[] {
  const lower = text.toLowerCase();
  const amount = pickAmount(text);
  const day = isoDay(date);
  const startedAt = isoStamp(date);
  const distanceKm = pickDistanceKm(text);
  const durationMin = pickDurationMin(text);
  const merchant = pickMerchant(text);
  const out: Candidate[] = [];

  const maybeRide = (provider: string, type: string) =>
    out.push({
      kind: "mobility",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm,
      durationMin,
      type,
      merchant: "",
    });

  const maybeFood = (provider: string) =>
    out.push({
      kind: "food",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: 0,
      durationMin: 0,
      type: "",
      merchant,
    });

  const maybeGroceries = (provider: string) => {
    const itemsMatch = text.match(/(\d+)\s*(?:item|artikel|product|artikel)/i);
    out.push({
      kind: "groceries",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: 0,
      durationMin: 0,
      type: "",
      merchant: provider,
      itemsCount: itemsMatch ? Math.round(toNum(itemsMatch[1])) : 0,
    });
  };

  if (enabled(cfg, "scanUberEats", true) && (lower.includes("uber eats") || lower.includes("ubereats"))) {
    maybeFood("Uber Eats");
  }
  if (enabled(cfg, "scanThuisbezorgd", true) && (lower.includes("thuisbezorgd") || lower.includes("takeaway.com"))) {
    maybeFood("Thuisbezorgd");
  }
  if (enabled(cfg, "scanAlbertHeijn", true) && (lower.includes("albert heijn") || lower.includes("ah.nl"))) {
    maybeGroceries("Albert Heijn");
  }
  if (enabled(cfg, "scanJumbo", true) && lower.includes("jumbo")) {
    maybeGroceries("Jumbo");
  }
  if (enabled(cfg, "scanLime", true) && lower.includes("lime")) {
    const type = lower.includes("bike") ? "bike" : "scooter";
    maybeRide("Lime", type);
  }
  if (enabled(cfg, "scanBolt", true) && lower.includes("bolt")) {
    const type = lower.includes("scooter") ? "scooter" : lower.includes("bike") ? "bike" : "taxi";
    maybeRide("Bolt", type);
  }
  if (enabled(cfg, "scanUber", true) && lower.includes("uber") && !lower.includes("uber eats") && !lower.includes("ubereats")) {
    const type = lower.includes("scooter") ? "scooter" : lower.includes("bike") ? "bike" : "taxi";
    maybeRide("Uber", type);
  }
  return out;
}

async function existingDedupe(ctx: ConnectorContext, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = await ctx.db.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM inbox_receipt_seen FINAL WHERE dedupe_key IN {keys:Array(String)}`,
      { keys: chunk },
    );
    for (const row of rows) seen.add(String(row.dedupe_key));
  }
  return seen;
}

const MOBILITY_TOGGLES = [
  { key: "scanUber", label: "Scan Uber rides", icon: "https://upload.wikimedia.org/wikipedia/commons/6/62/Uber_logo.svg" },
  { key: "scanLime", label: "Scan Lime rides", icon: "https://upload.wikimedia.org/wikipedia/commons/e/e1/Lime_%28transportation_company%29_logo.svg" },
  { key: "scanBolt", label: "Scan Bolt rides", icon: "https://upload.wikimedia.org/wikipedia/commons/2/28/Vector_logo_of_Bolt.svg" },
];

const FOOD_TOGGLES = [
  { key: "scanThuisbezorgd", label: "Scan Thuisbezorgd orders", icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Thuisbezorgd.svg/1024px-Thuisbezorgd.svg.png" },
  { key: "scanUberEats", label: "Scan Uber Eats orders", icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Uber_Eats.svg/1024px-Uber_Eats.svg.png" },
];

const GROCERY_TOGGLES = [
  { key: "scanAlbertHeijn", label: "Scan Albert Heijn receipts", icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Albert_Heijn_logo.svg/1024px-Albert_Heijn_logo.svg.png" },
  { key: "scanJumbo", label: "Scan Jumbo receipts", icon: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Jumbo_supermarkt_logo.svg/1024px-Jumbo_supermarkt_logo.svg.png" },
];

const ALL_PROVIDER_TOGGLES = [...MOBILITY_TOGGLES, ...FOOD_TOGGLES, ...GROCERY_TOGGLES];

async function exchangeGmailCode(code: string): Promise<{ accessToken: string; refreshToken: string }> {
  const clientId = process.env.GMAIL_CLIENT_ID ?? "";
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? "";
  const redirectUri = process.env.GMAIL_REDIRECT_URI ?? "http://localhost:3000/api/oauth/gmail";

  if (!clientId || !clientSecret) throw new Error("Gmail OAuth credentials not configured.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail OAuth failed: ${err}`);
  }

  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error("No access token from Gmail.");
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? "" };
}

async function refreshGmailToken(refreshToken: string): Promise<string> {
  const clientId = process.env.GMAIL_CLIENT_ID ?? "";
  const clientSecret = process.env.GMAIL_CLIENT_SECRET ?? "";

  if (!clientId || !clientSecret) throw new Error("Gmail OAuth credentials not configured.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!res.ok) throw new Error("Gmail token refresh failed.");
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? "";
}

async function fetchGmailMessages(accessToken: string, lookbackDays: number): Promise<Array<{ id: string; headers: Record<string, string>; body: string }>> {
  const q = `after:${Math.floor(Date.now() / 1000) - lookbackDays * 24 * 60 * 60}`;
  const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) throw new Error("Gmail token expired or invalid.");
  if (!res.ok) throw new Error(`Gmail API error ${res.status}`);

  const data = (await res.json()) as { messages?: Array<{ id: string }> };
  const messages = [];

  for (const msg of data.messages ?? []) {
    const msgRes = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (msgRes.ok) {
      const msgData = (await msgRes.json()) as { id: string; payload?: { headers?: Array<{ name: string; value: string }>; parts?: Array<{ body?: { data?: string } }> } };
      const headers: Record<string, string> = {};
      (msgData.payload?.headers ?? []).forEach((h) => {
        headers[h.name.toLowerCase()] = h.value;
      });
      const bodyParts = msgData.payload?.parts ?? [];
      const bodyData = bodyParts.find((p) => p.body?.data)?.body?.data ?? "";
      const body = bodyData ? Buffer.from(bodyData, "base64").toString("utf-8") : "";
      messages.push({ id: msgData.id, headers, body });
    }
  }
  return messages;
}

async function exchangeOutlookCode(code: string): Promise<{ accessToken: string; refreshToken: string }> {
  const clientId = process.env.OUTLOOK_CLIENT_ID ?? "";
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET ?? "";
  const redirectUri = process.env.OUTLOOK_REDIRECT_URI ?? "http://localhost:3000/api/oauth/outlook";

  if (!clientId || !clientSecret) throw new Error("Outlook OAuth credentials not configured.");

  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      scope: "Mail.Read",
    }).toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Outlook OAuth failed: ${err}`);
  }

  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error("No access token from Outlook.");
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? "" };
}

async function refreshOutlookToken(refreshToken: string): Promise<string> {
  const clientId = process.env.OUTLOOK_CLIENT_ID ?? "";
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET ?? "";

  if (!clientId || !clientSecret) throw new Error("Outlook OAuth credentials not configured.");

  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      scope: "Mail.Read",
    }).toString(),
  });

  if (!res.ok) throw new Error("Outlook token refresh failed.");
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? "";
}

async function fetchOutlookMessages(accessToken: string, lookbackDays: number): Promise<Array<{ id: string; subject: string; body: string; receivedDateTime: string }>> {
  const sinceDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${encodeURIComponent(sinceDate)}&$top=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (res.status === 401) throw new Error("Outlook token expired or invalid.");
  if (!res.ok) throw new Error(`Outlook API error ${res.status}`);

  const data = (await res.json()) as { value?: Array<{ id: string; subject: string; bodyPreview: string; receivedDateTime: string }> };
  const messages: Array<{ id: string; subject: string; body: string; receivedDateTime: string }> = [];

  for (const msg of data.value ?? []) {
    const bodyRes = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${msg.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (bodyRes.ok) {
      const bodyData = (await bodyRes.json()) as { body?: { content?: string } };
      messages.push({
        id: msg.id,
        subject: msg.subject,
        body: bodyData.body?.content ?? msg.bodyPreview,
        receivedDateTime: msg.receivedDateTime,
      });
    }
  }
  return messages;
}

const gmailConnector: Connector = {
  id: "gmail",
  name: "Gmail",
  description: "Auto-scan your Gmail inbox for receipts and auto-import them.",
  kind: "oauth",
  syncIntervalMinutes: 30,
  hasAuthorize: true,
  configSchema: [
    { key: "section_mobility", label: "Mobility", type: "section" as const },
    ...MOBILITY_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
    { key: "section_food", label: "Food & Delivery", type: "section" as const },
    ...FOOD_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
    { key: "section_groceries", label: "Groceries", type: "section" as const },
    ...GROCERY_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
  ],
  async authorize(ctx, input) {
    if (input.disconnect) {
      await ctx.saveConfig({ gmailAccessToken: "", gmailRefreshToken: "" });
      return { message: "Disconnected from Gmail." };
    }

    const code = String(input.code ?? "").trim();
    if (!code) throw new Error("Paste the authorization code from Gmail.");

    try {
      const { accessToken, refreshToken } = await exchangeGmailCode(code);
      await ctx.saveConfig({ gmailAccessToken: accessToken, gmailRefreshToken: refreshToken });
      return { message: "Connected to Gmail." };
    } catch (e) {
      throw new Error(`Gmail connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
  async sync(ctx) {
    let token = String(ctx.config.gmailAccessToken ?? "").trim();
    const refreshToken = String(ctx.config.gmailRefreshToken ?? "").trim();
    const lookbackDays = Math.max(1, Math.round(Number(ctx.config.lookbackDays ?? 14)));

    if (!token) throw new Error("Connect Gmail first.");

    try {
      const messages = await fetchGmailMessages(token, lookbackDays);
      const mobilityRows: Record<string, unknown>[] = [];
      const foodRows: Record<string, unknown>[] = [];
      const groceryRows: Record<string, unknown>[] = [];
      const seenRows: Record<string, unknown>[] = [];
      const existing = await existingDedupe(
        ctx,
        messages.map((m) => `gmail|${m.id}`),
      );

      for (const msg of messages) {
        const key = `gmail|${msg.id}`;
        if (existing.has(key)) continue;

        const body = [msg.headers.subject ?? "", msg.body].join("\n");
        const date = new Date(msg.headers.date ?? new Date());
        const candidates = detectCandidates(body, msg.id, date, ctx.config);

        for (const c of candidates) {
          if (c.kind === "mobility") {
            const cost = round2(c.amount);
            const currency = normCurrency(c.currency);
            mobilityRows.push({
              day: c.day,
              started_at: c.startedAt,
              provider: c.provider,
              type: c.type,
              distance_km: round2(c.distanceKm),
              duration_min: Math.round(c.durationMin),
              cost,
              cost_currency: currency,
              cost_eur: toEur(cost, currency),
            });
          } else if (c.kind === "groceries") {
            const amount = round2(c.amount);
            const currency = normCurrency(c.currency);
            groceryRows.push({
              day: c.day,
              message_id: msg.id,
              store: c.provider,
              amount,
              currency,
              cost_eur: toEur(amount, currency),
              items_count: c.itemsCount ?? 0,
            });
          } else {
            foodRows.push({
              day: c.day,
              provider: c.provider,
              merchant: c.merchant || "Unknown",
              total: round2(c.amount),
              currency: normCurrency(c.currency),
              items: 0,
              delivery_fee: 0,
              service_fee: 0,
              tip: 0,
              notes: "Imported from Gmail receipt scan",
              source: "gmail",
            });
          }

          seenRows.push({
            day: c.day,
            dedupe_key: `${c.kind}|${c.provider}|${msg.id}`,
            provider: c.provider,
            kind: c.kind,
            message_id: msg.id,
            created_at: new Date().toISOString(),
          });
        }
      }

      if (mobilityRows.length > 0) await ctx.db.insert("mobility_ride", mobilityRows);
      if (foodRows.length > 0) await ctx.db.insert("food_order", foodRows);
      if (groceryRows.length > 0) await ctx.db.insert("grocery_receipt", groceryRows);
      if (seenRows.length > 0) await ctx.db.insert("inbox_receipt_seen", seenRows);

      const inserted = mobilityRows.length + foodRows.length + groceryRows.length;
      return {
        inserted,
        message: `Scanned ${messages.length} Gmail message(s), inserted ${inserted} entries.`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("expired")) {
        if (refreshToken) {
          try {
            token = await refreshGmailToken(refreshToken);
            await ctx.saveConfig({ gmailAccessToken: token });
            return { message: "Gmail session refreshed. Please retry sync." };
          } catch {
            throw new Error("Gmail token expired. Reconnect to refresh.");
          }
        }
      }
      throw e;
    }
  },
};

const outlookConnector: Connector = {
  id: "outlook",
  name: "Outlook",
  description: "Auto-scan your Outlook inbox for receipts and auto-import them.",
  kind: "oauth",
  syncIntervalMinutes: 30,
  hasAuthorize: true,
  configSchema: [
    { key: "section_mobility", label: "Mobility", type: "section" as const },
    ...MOBILITY_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
    { key: "section_food", label: "Food & Delivery", type: "section" as const },
    ...FOOD_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
    { key: "section_groceries", label: "Groceries", type: "section" as const },
    ...GROCERY_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
  ],
  async authorize(ctx, input) {
    if (input.disconnect) {
      await ctx.saveConfig({ outlookAccessToken: "", outlookRefreshToken: "" });
      return { message: "Disconnected from Outlook." };
    }

    const code = String(input.code ?? "").trim();
    if (!code) throw new Error("Paste the authorization code from Outlook.");

    try {
      const { accessToken, refreshToken } = await exchangeOutlookCode(code);
      await ctx.saveConfig({ outlookAccessToken: accessToken, outlookRefreshToken: refreshToken });
      return { message: "Connected to Outlook." };
    } catch (e) {
      throw new Error(`Outlook connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
  async sync(ctx) {
    let token = String(ctx.config.outlookAccessToken ?? "").trim();
    const refreshToken = String(ctx.config.outlookRefreshToken ?? "").trim();
    const lookbackDays = Math.max(1, Math.round(Number(ctx.config.lookbackDays ?? 14)));

    if (!token) throw new Error("Connect Outlook first.");

    try {
      const messages = await fetchOutlookMessages(token, lookbackDays);
      const mobilityRows: Record<string, unknown>[] = [];
      const foodRows: Record<string, unknown>[] = [];
      const groceryRows: Record<string, unknown>[] = [];
      const seenRows: Record<string, unknown>[] = [];
      const existing = await existingDedupe(
        ctx,
        messages.map((m) => `outlook|${m.id}`),
      );

      for (const msg of messages) {
        const key = `outlook|${msg.id}`;
        if (existing.has(key)) continue;

        const body = [msg.subject, msg.body].join("\n");
        const date = new Date(msg.receivedDateTime);
        const candidates = detectCandidates(body, msg.id, date, ctx.config);

        for (const c of candidates) {
          if (c.kind === "mobility") {
            const cost = round2(c.amount);
            const currency = normCurrency(c.currency);
            mobilityRows.push({
              day: c.day,
              started_at: c.startedAt,
              provider: c.provider,
              type: c.type,
              distance_km: round2(c.distanceKm),
              duration_min: Math.round(c.durationMin),
              cost,
              cost_currency: currency,
              cost_eur: toEur(cost, currency),
            });
          } else if (c.kind === "groceries") {
            const amount = round2(c.amount);
            const currency = normCurrency(c.currency);
            groceryRows.push({
              day: c.day,
              message_id: msg.id,
              store: c.provider,
              amount,
              currency,
              cost_eur: toEur(amount, currency),
              items_count: c.itemsCount ?? 0,
            });
          } else {
            foodRows.push({
              day: c.day,
              provider: c.provider,
              merchant: c.merchant || "Unknown",
              total: round2(c.amount),
              currency: normCurrency(c.currency),
              items: 0,
              delivery_fee: 0,
              service_fee: 0,
              tip: 0,
              notes: "Imported from Outlook receipt scan",
              source: "outlook",
            });
          }

          seenRows.push({
            day: c.day,
            dedupe_key: `${c.kind}|${c.provider}|${msg.id}`,
            provider: c.provider,
            kind: c.kind,
            message_id: msg.id,
            created_at: new Date().toISOString(),
          });
        }
      }

      if (mobilityRows.length > 0) await ctx.db.insert("mobility_ride", mobilityRows);
      if (foodRows.length > 0) await ctx.db.insert("food_order", foodRows);
      if (groceryRows.length > 0) await ctx.db.insert("grocery_receipt", groceryRows);
      if (seenRows.length > 0) await ctx.db.insert("inbox_receipt_seen", seenRows);

      const inserted = mobilityRows.length + foodRows.length + groceryRows.length;
      return {
        inserted,
        message: `Scanned ${messages.length} Outlook message(s), inserted ${inserted} entries.`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("expired")) {
        if (refreshToken) {
          try {
            token = await refreshOutlookToken(refreshToken);
            await ctx.saveConfig({ outlookAccessToken: token });
            return { message: "Outlook session refreshed. Please retry sync." };
          } catch {
            throw new Error("Outlook token expired. Reconnect to refresh.");
          }
        }
      }
      throw e;
    }
  },
};

const mailReceipts: Connector = {
  id: "mail-receipts",
  name: "Mailbox (advanced)",
  description:
    "Connect any mailbox via IMAP and auto-scan for receipts. For custom mail servers or advanced configuration.",
  kind: "api",
  syncIntervalMinutes: 30,
  configSchema: [
    { key: "section_advanced", label: "IMAP Connection", type: "section" as const },
    { key: "imapHost", label: "IMAP host", type: "text", default: "imap.gmail.com" },
    { key: "imapPort", label: "IMAP port", type: "number", default: 993 },
    { key: "imapSecure", label: "Use TLS", type: "boolean", default: true },
    { key: "imapUser", label: "Mailbox username", type: "text" },
    { key: "imapPassword", label: "Mailbox password / app password", type: "password", secret: true, optional: true },
    { key: "mailbox", label: "Folder", type: "text", default: "INBOX" },
    { key: "scanDays", label: "Look back days", type: "number", default: 14 },
    { key: "maxMessages", label: "Max emails per sync", type: "number", default: 400 },
    { key: "section_mobility_scan", label: "Mobility", type: "section" as const },
    ...MOBILITY_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
    { key: "section_food_scan", label: "Food & Delivery", type: "section" as const },
    ...FOOD_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
    { key: "section_groceries_scan", label: "Groceries", type: "section" as const },
    ...GROCERY_TOGGLES.map((p) => ({ key: p.key, label: p.label, type: "boolean" as const, default: true, icon: p.icon })),
  ],
  async sync(ctx) {
    const host = String(ctx.config.imapHost ?? "").trim();
    const port = Math.round(Number(ctx.config.imapPort ?? 993));
    const secure = enabled(ctx.config, "imapSecure", true);
    const user = String(ctx.config.imapUser ?? "").trim();
    const pass = String(ctx.config.imapPassword ?? "").trim();
    const mailbox = String(ctx.config.mailbox ?? "INBOX").trim() || "INBOX";
    const scanDays = Math.max(1, Math.round(Number(ctx.config.scanDays ?? 14)));
    const maxMessages = Math.max(10, Math.round(Number(ctx.config.maxMessages ?? 400)));

    if (!host || !user || !pass) throw new Error("Set IMAP host, username, and password/app password.");

    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
    });

    const mobilityRows: Record<string, unknown>[] = [];
    const foodRows: Record<string, unknown>[] = [];
    const groceryRows: Record<string, unknown>[] = [];
    const seenRows: Record<string, unknown>[] = [];
    let scanned = 0;

    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        const since = new Date(Date.now() - scanDays * 24 * 60 * 60 * 1000);
        const found = await client.search({ since });
        const uids = Array.isArray(found) ? found : [];
        const slice = uids.slice(Math.max(0, uids.length - maxMessages));
        const parsedCandidates: Array<{ key: string; data: Candidate }> = [];

        for await (const msg of client.fetch(slice, { uid: true, envelope: true, source: true })) {
          scanned++;
          const envelopeDate = msg.envelope?.date ?? new Date();
          const messageId = String(msg.envelope?.messageId ?? `${mailbox}:${msg.uid}`).trim();
          const sourceBuffer =
            msg.source instanceof Readable
              ? await streamToBuffer(msg.source)
              : Buffer.isBuffer(msg.source)
                ? msg.source
                : Buffer.from([]);
          const parsed = await simpleParser(sourceBuffer);
          const body = [parsed.subject ?? "", parsed.text ?? "", parsed.html ? String(parsed.html) : ""].join("\n");
          const candidates = detectCandidates(body, messageId, parsed.date ?? envelopeDate, ctx.config);
          for (const c of candidates) {
            const key = `${c.kind}|${c.provider}|${c.messageId}`;
            parsedCandidates.push({ key, data: c });
          }
        }

        const existing = await existingDedupe(ctx, parsedCandidates.map((x) => x.key));
        for (const item of parsedCandidates) {
          if (existing.has(item.key)) continue;
          const c = item.data;
          if (c.kind === "mobility") {
            const cost = round2(c.amount);
            const currency = normCurrency(c.currency);
            mobilityRows.push({
              day: c.day,
              started_at: c.startedAt,
              provider: c.provider,
              type: c.type,
              distance_km: round2(c.distanceKm),
              duration_min: Math.round(c.durationMin),
              cost,
              cost_currency: currency,
              cost_eur: toEur(cost, currency),
            });
          } else if (c.kind === "groceries") {
            const amount = round2(c.amount);
            const currency = normCurrency(c.currency);
            groceryRows.push({
              day: c.day,
              message_id: c.messageId,
              store: c.provider,
              amount,
              currency,
              cost_eur: toEur(amount, currency),
              items_count: c.itemsCount ?? 0,
            });
          } else {
            foodRows.push({
              day: c.day,
              provider: c.provider,
              merchant: c.merchant || "Unknown",
              total: round2(c.amount),
              currency: normCurrency(c.currency),
              items: 0,
              delivery_fee: 0,
              service_fee: 0,
              tip: 0,
              notes: "Imported from mailbox receipt scan",
              source: "mailbox",
            });
          }
          seenRows.push({
            day: c.day,
            dedupe_key: item.key,
            provider: c.provider,
            kind: c.kind,
            message_id: c.messageId,
            created_at: new Date().toISOString(),
          });
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }

    if (mobilityRows.length > 0) await ctx.db.insert("mobility_ride", mobilityRows);
    if (foodRows.length > 0) await ctx.db.insert("food_order", foodRows);
    if (groceryRows.length > 0) await ctx.db.insert("grocery_receipt", groceryRows);
    if (seenRows.length > 0) await ctx.db.insert("inbox_receipt_seen", seenRows);

    return {
      inserted: mobilityRows.length + foodRows.length + groceryRows.length,
      message: `Scanned ${scanned} email(s), inserted ${mobilityRows.length} mobility, ${foodRows.length} food, and ${groceryRows.length} grocery entries.`,
    };
  },
};

const inbox: LifeStackModule = {
  id: "inbox",
  name: "Inbox receipts",
  description: "Auto-scan mailbox receipts and route parsed entries into Mobility and Food modules.",
  icon: "📧",
  accent: "oklch(0.73 0.13 255)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS inbox_receipt_seen (
       day Date,
       dedupe_key String,
       provider String,
       kind String,
       message_id String,
       created_at DateTime
     ) ENGINE = ReplacingMergeTree ORDER BY (provider, dedupe_key)`,
  ],
  connectors: [gmailConnector, outlookConnector, mailReceipts],
  widgets: [
    {
      id: "scanned-total",
      title: "Receipts processed",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(count()) AS v FROM inbox_receipt_seen FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "receipts" };
      },
    },
    {
      id: "providers",
      title: "Receipts by provider",
      type: "donut",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT provider AS label, toInt32(count()) AS value
           FROM inbox_receipt_seen FINAL
           GROUP BY provider
           ORDER BY value DESC`,
        );
        return { slices: rows, unit: "receipts" };
      },
    },
  ],
};

export default inbox;
