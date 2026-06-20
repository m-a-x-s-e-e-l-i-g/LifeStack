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
  pickupLocation?: string;
  dropoffLocation?: string;
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

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return round2(R * c);
}

function pickUberLocations(text: string): { pickup?: string; dropoff?: string; distanceKm: number } {
  let pickup: string | undefined;
  let dropoff: string | undefined;
  let distanceKm = 0;

  // Try to extract pickup location
  const pickupMatch = text.match(/pick(?:ed)?\s+up\s+(?:at|from)?\s*([^\n\r,]+?)(?:\n|,|$)/i);
  if (pickupMatch?.[1]) pickup = pickupMatch[1].trim().slice(0, 100);

  // Try to extract dropoff location
  const dropoffMatch = text.match(/drop(?:ped)?\s+off\s+(?:at|to)?\s*([^\n\r,]+?)(?:\n|,|$)/i);
  if (dropoffMatch?.[1]) dropoff = dropoffMatch[1].trim().slice(0, 100);

  // Try to extract coordinates from either location (format: "52.3676° N, 4.9041° E" or "52.3676, 4.9041")
  const coordPattern = /(\d+(?:\.\d+)?)[°]?\s*([NS])?[,\s]+(\d+(?:\.\d+)?)[°]?\s*([EW])?/gi;
  const coords: Array<{ lat: number; lon: number }> = [];

  let match;
  while ((match = coordPattern.exec(text))) {
    let lat = parseFloat(match[1]);
    let lon = parseFloat(match[3]);

    if (match[2]?.toUpperCase() === "S") lat = -lat;
    if (match[4]?.toUpperCase() === "W") lon = -lon;

    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      coords.push({ lat, lon });
    }
  }

  // If we found 2 coordinates, calculate distance
  if (coords.length >= 2) {
    distanceKm = haversineDistance(coords[0].lat, coords[0].lon, coords[1].lat, coords[1].lon);
  }

  return { pickup, dropoff, distanceKm };
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
  let distanceKm = pickDistanceKm(text);
  const durationMin = pickDurationMin(text);
  const merchant = pickMerchant(text);
  const out: Candidate[] = [];

  const maybeRide = (provider: string, type: string, pickupLoc?: string, dropoffLoc?: string, calculatedDist?: number) =>
    out.push({
      kind: "mobility",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: calculatedDist ?? distanceKm,
      durationMin,
      type,
      merchant: "",
      pickupLocation: pickupLoc,
      dropoffLocation: dropoffLoc,
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

  if (enabled(cfg, "scanFood", true) && (lower.includes("uber eats") || lower.includes("ubereats"))) {
    maybeFood("Uber Eats");
  }
  if (enabled(cfg, "scanFood", true) && (lower.includes("thuisbezorgd") || lower.includes("takeaway.com"))) {
    maybeFood("Thuisbezorgd");
  }
  if (enabled(cfg, "scanGroceries", true) && (lower.includes("albert heijn") || lower.includes("ah.nl"))) {
    maybeGroceries("Albert Heijn");
  }
  if (enabled(cfg, "scanGroceries", true) && lower.includes("jumbo")) {
    maybeGroceries("Jumbo");
  }
  if (enabled(cfg, "scanMobility", true) && lower.includes("lime")) {
    const type = lower.includes("bike") ? "bike" : "scooter";
    maybeRide("Lime", type);
  }
  if (enabled(cfg, "scanMobility", true) && lower.includes("bolt")) {
    const type = lower.includes("scooter") ? "scooter" : lower.includes("bike") ? "bike" : "taxi";
    maybeRide("Bolt", type);
  }
  if (enabled(cfg, "scanMobility", true) && lower.includes("uber") && !lower.includes("uber eats") && !lower.includes("ubereats")) {
    const type = lower.includes("scooter") ? "scooter" : lower.includes("bike") ? "bike" : "taxi";
    
    // For Uber taxi rides, try to extract distance from locations
    if (type === "taxi") {
      const locations = pickUberLocations(text);
      if (locations.distanceKm > 0) {
        maybeRide("Uber", type, locations.pickup, locations.dropoff, locations.distanceKm);
      } else {
        maybeRide("Uber", type, locations.pickup, locations.dropoff);
      }
    } else {
      maybeRide("Uber", type);
    }
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

const MOBILITY_SCAN_MODULE_ID = "mobility";
const FOOD_SCAN_MODULE_ID = "food";
const GROCERIES_SCAN_MODULE_ID = "groceries";
const MOBILITY_SCAN_CONNECTOR_ID = "inbox-mobility";
const FOOD_SCAN_CONNECTOR_ID = "inbox-food";
const GROCERIES_SCAN_CONNECTOR_ID = "inbox-groceries";

async function loadConnectorConfig(
  ctx: ConnectorContext,
  moduleId: string,
  connectorId: string,
): Promise<Record<string, unknown>> {
  const rows = await ctx.db.query<{ config: string }>(
    `SELECT config FROM connector_state FINAL
     WHERE module_id = {moduleId:String} AND connector_id = {connectorId:String}
     LIMIT 1`,
    { moduleId, connectorId },
  );

  const raw = rows[0]?.config;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    ctx.logger.warn(
      `inbox:${moduleId}/${connectorId} config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

async function resolveScanConfig(ctx: ConnectorContext): Promise<Record<string, unknown>> {
  const [mobilityCfg, foodCfg, groceriesCfg] = await Promise.all([
    loadConnectorConfig(ctx, MOBILITY_SCAN_MODULE_ID, MOBILITY_SCAN_CONNECTOR_ID),
    loadConnectorConfig(ctx, FOOD_SCAN_MODULE_ID, FOOD_SCAN_CONNECTOR_ID),
    loadConnectorConfig(ctx, GROCERIES_SCAN_MODULE_ID, GROCERIES_SCAN_CONNECTOR_ID),
  ]);

  return { ...ctx.config, ...mobilityCfg, ...foodCfg, ...groceriesCfg };
}

function gmailAuthorizeUrl(clientId: string, redirectUri: string): string | null {
  if (!clientId) return null;
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "https://www.googleapis.com/auth/gmail.readonly");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

function outlookAuthorizeUrl(clientId: string, redirectUri: string): string | null {
  if (!clientId) return null;
  const u = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", "offline_access Mail.Read");
  return u.toString();
}

async function exchangeGmailCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string }> {
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

async function refreshGmailToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
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

async function exchangeOutlookCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string }> {
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

async function refreshOutlookToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
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
    {
      key: "clientId",
      label: "Gmail OAuth Client ID",
      type: "text",
      help: "From your Google Cloud OAuth app. Required to authorize Gmail.",
    },
    {
      key: "clientSecret",
      label: "Gmail OAuth Client secret",
      type: "password",
      secret: true,
      help: "From the same OAuth app. Stored securely in connector settings.",
    },
    {
      key: "redirectUri",
      label: "Gmail redirect URI",
      type: "text",
      default: "http://localhost:3000/api/oauth/gmail",
      help: "Set this exact URI in your OAuth app's authorized redirect URIs.",
    },
  ],
  authorizeUrl: (ctx) => {
    const clientId = String(ctx.config.clientId ?? "").trim();
    const redirectUri =
      String(ctx.config.redirectUri ?? "").trim() || "http://localhost:3000/api/oauth/gmail";
    return gmailAuthorizeUrl(clientId, redirectUri);
  },
  async authorize(ctx, input) {
    if (input.disconnect) {
      await ctx.saveConfig({ gmailAccessToken: "", gmailRefreshToken: "" });
      return { message: "Disconnected from Gmail." };
    }

    const code = String(input.code ?? "").trim();
    const clientId = String(ctx.config.clientId ?? "").trim();
    const clientSecret = String(ctx.config.clientSecret ?? "").trim();
    const redirectUri =
      String(ctx.config.redirectUri ?? "").trim() || "http://localhost:3000/api/oauth/gmail";
    if (!code) throw new Error("Paste the authorization code from Gmail.");
    if (!clientId || !clientSecret)
      throw new Error("Save Gmail OAuth Client ID and Client secret first.");

    try {
      const { accessToken, refreshToken } = await exchangeGmailCode(
        code,
        clientId,
        clientSecret,
        redirectUri,
      );
      await ctx.saveConfig({ gmailAccessToken: accessToken, gmailRefreshToken: refreshToken });
      return { message: "Connected to Gmail." };
    } catch (e) {
      throw new Error(`Gmail connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
  async sync(ctx) {
    let token = String(ctx.config.gmailAccessToken ?? "").trim();
    const refreshToken = String(ctx.config.gmailRefreshToken ?? "").trim();
    const clientId = String(ctx.config.clientId ?? "").trim();
    const clientSecret = String(ctx.config.clientSecret ?? "").trim();
    const lookbackDays = Math.max(1, Math.round(Number(ctx.config.lookbackDays ?? 14)));
    const scanCfg = await resolveScanConfig(ctx);

    if (!clientId || !clientSecret)
      throw new Error("Set Gmail OAuth Client ID and Client secret in connector settings.");
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
        const candidates = detectCandidates(body, msg.id, date, scanCfg);

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
            token = await refreshGmailToken(refreshToken, clientId, clientSecret);
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
    {
      key: "clientId",
      label: "Outlook OAuth Client ID",
      type: "text",
      help: "From your Microsoft Entra app registration. Required to authorize Outlook.",
    },
    {
      key: "clientSecret",
      label: "Outlook OAuth Client secret",
      type: "password",
      secret: true,
      help: "From the same app registration. Stored securely in connector settings.",
    },
    {
      key: "redirectUri",
      label: "Outlook redirect URI",
      type: "text",
      default: "http://localhost:3000/api/oauth/outlook",
      help: "Set this exact URI in your app registration redirect URIs.",
    },
  ],
  authorizeUrl: (ctx) => {
    const clientId = String(ctx.config.clientId ?? "").trim();
    const redirectUri =
      String(ctx.config.redirectUri ?? "").trim() || "http://localhost:3000/api/oauth/outlook";
    return outlookAuthorizeUrl(clientId, redirectUri);
  },
  async authorize(ctx, input) {
    if (input.disconnect) {
      await ctx.saveConfig({ outlookAccessToken: "", outlookRefreshToken: "" });
      return { message: "Disconnected from Outlook." };
    }

    const code = String(input.code ?? "").trim();
    const clientId = String(ctx.config.clientId ?? "").trim();
    const clientSecret = String(ctx.config.clientSecret ?? "").trim();
    const redirectUri =
      String(ctx.config.redirectUri ?? "").trim() || "http://localhost:3000/api/oauth/outlook";
    if (!code) throw new Error("Paste the authorization code from Outlook.");
    if (!clientId || !clientSecret)
      throw new Error("Save Outlook OAuth Client ID and Client secret first.");

    try {
      const { accessToken, refreshToken } = await exchangeOutlookCode(
        code,
        clientId,
        clientSecret,
        redirectUri,
      );
      await ctx.saveConfig({ outlookAccessToken: accessToken, outlookRefreshToken: refreshToken });
      return { message: "Connected to Outlook." };
    } catch (e) {
      throw new Error(`Outlook connection failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
  async sync(ctx) {
    let token = String(ctx.config.outlookAccessToken ?? "").trim();
    const refreshToken = String(ctx.config.outlookRefreshToken ?? "").trim();
    const clientId = String(ctx.config.clientId ?? "").trim();
    const clientSecret = String(ctx.config.clientSecret ?? "").trim();
    const lookbackDays = Math.max(1, Math.round(Number(ctx.config.lookbackDays ?? 14)));
    const scanCfg = await resolveScanConfig(ctx);

    if (!clientId || !clientSecret)
      throw new Error("Set Outlook OAuth Client ID and Client secret in connector settings.");
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
        const candidates = detectCandidates(body, msg.id, date, scanCfg);

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
            token = await refreshOutlookToken(refreshToken, clientId, clientSecret);
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
    const scanCfg = await resolveScanConfig(ctx);

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
          const candidates = detectCandidates(body, messageId, parsed.date ?? envelopeDate, scanCfg);
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
