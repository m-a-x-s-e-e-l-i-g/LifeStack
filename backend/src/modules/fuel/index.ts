import JSZip from "jszip";
import { basename, extname, join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import type { Connector, ConnectorContext, LifeStackModule, ModuleContext } from "../../core/types";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const DROPBOX_ICON = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path fill="#0061FF" d="M6.1 2.8 1 6.1l5.1 3.3 5.1-3.3L6.1 2.8Zm11.8 0-5.1 3.3 5.1 3.3L23 6.1l-5.1-3.3ZM1 12.7l5.1 3.3 5.1-3.3-5.1-3.3L1 12.7Zm16.9-3.3-5.1 3.3 5.1 3.3 5.1-3.3-5.1-3.3ZM6.1 17.1l5.1 3.3 5.1-3.3-5.1-3.3-5.1 3.3Z"/></svg>`;
const GDRIVE_ICON = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path fill="#0F9D58" d="m9.4 2 2.2 3.8-6.3 11H1.1L9.4 2Z"/><path fill="#F4B400" d="M14.6 2H9.4l6.2 10.8h4.3L14.6 2Z"/><path fill="#4285F4" d="m7.4 20 2-3.4h13.5L21 20H7.4Z"/></svg>`;
const FUELIO_ICON = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path fill="currentColor" d="M9.4 2.8c2.4 0 4.3 2 4.3 4.4v2.4h1.6v10.2H4.7V7.2c0-2.4 2-4.4 4.4-4.4h.3Zm10.5 2.1 1.5 1.5v10.3c0 1.4-1.1 2.5-2.5 2.5-1.1 0-2-.7-2.4-1.6l1.4-.8c.1.4.5.6 1 .6.5 0 .9-.4.9-.9v-5.1h-2.2V7.7h2.3V6.4l-.9-.9.9-.6Z"/></svg>`;

const DROPBOX_TOKEN = "https://api.dropboxapi.com/oauth2/token";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REDIRECT = "http://localhost";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface FuelLogRow {
  day: string;
  liters: number;
  price_per_liter: number;
  cost: number;
  odometer: number;
  vehicle_guid: string;
  vehicle_name: string;
  entry_guid: string;
}

interface FuelFile {
  name: string;
  bytes: Uint8Array;
}

function toNum(v: unknown): number {
  const raw = String(v ?? "").trim().replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v: unknown): number {
  return Math.round(toNum(v));
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function normalizeSection(v: string): string {
  return v.replace(/^##\s*/, "").trim();
}

function splitCsvSections(csv: string): Record<string, Array<Record<string, string>>> {
  const lines = csv.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const sections: Record<string, Array<Record<string, string>>> = {};
  let section = "";
  let header: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const first = String(cols[0] ?? "").trim();
    if (first.startsWith("## ")) {
      section = normalizeSection(first);
      header = [];
      if (!sections[section]) sections[section] = [];
      continue;
    }
    if (!section) continue;
    if (header.length === 0) {
      header = cols.map((c) => c.trim());
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = String(cols[i] ?? "").trim();
    sections[section].push(row);
  }
  return sections;
}

function parseFuelioCsv(csv: string, sourceName: string): FuelLogRow[] {
  const sections = splitCsvSections(csv);
  const vehicle = sections.Vehicle?.[0] ?? {};
  const vehicle_name = String(vehicle.Name ?? basename(sourceName, extname(sourceName)) ?? "").trim();
  const vehicle_guid = String((vehicle.guid ?? vehicle_name) || sourceName).trim();
  const logs = sections.Log ?? [];
  const rows: FuelLogRow[] = [];
  for (const log of logs) {
    const ts = String(log["Data"] ?? "").trim();
    const day = ts.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const liters = toNum(log["Fuel (litres)"]);
    const odometer = toInt(log["Odo (km)"]);
    if (!(liters > 0) || !(odometer > 0)) continue;
    const explicitPpl = toNum(log.VolumePrice);
    const explicitCost = toNum(log["Price (optional)"]);
    const cost = explicitCost > 0 ? explicitCost : round2(liters * explicitPpl);
    const price_per_liter = explicitPpl > 0 ? explicitPpl : liters > 0 ? round2(cost / liters) : 0;
    const guid = String(log.guid ?? log.UniqueId ?? "").trim();
    const entry_guid = guid || `${vehicle_guid}:${ts}:${odometer}:${liters}:${cost}`;
    rows.push({
      day,
      liters: round2(liters),
      price_per_liter: round2(price_per_liter),
      cost: round2(cost),
      odometer,
      vehicle_guid,
      vehicle_name: vehicle_name || vehicle_guid,
      entry_guid,
    });
  }
  return rows;
}

async function parseFuelioFile(file: FuelFile): Promise<FuelLogRow[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv")) {
    const text = Buffer.from(file.bytes).toString("utf8");
    return parseFuelioCsv(text, file.name);
  }
  if (lower.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(file.bytes);
    const rows: FuelLogRow[] = [];
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (entry.dir || !name.toLowerCase().endsWith(".csv")) continue;
      const text = await entry.async("string");
      rows.push(...parseFuelioCsv(text, name));
    }
    return rows;
  }
  return [];
}

function parseCsvList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function matchesAny(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const lower = name.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

async function collectLocalFiles(paths: string[], patterns: string[]): Promise<FuelFile[]> {
  const files: FuelFile[] = [];
  for (const p of paths) {
    const st = await stat(p);
    if (st.isDirectory()) {
      const entries = await readdir(p, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = join(p, entry.name);
        if (!matchesAny(entry.name, patterns)) continue;
        if (!/\.(csv|zip)$/i.test(entry.name)) continue;
        files.push({ name: full, bytes: new Uint8Array(await readFile(full)) });
      }
      continue;
    }
    if (!st.isFile()) continue;
    const name = basename(p);
    if (!matchesAny(name, patterns)) continue;
    if (!/\.(csv|zip)$/i.test(name)) continue;
    files.push({ name: p, bytes: new Uint8Array(await readFile(p)) });
  }
  return files;
}

async function existingEntryGuids(ctx: ModuleContext, guids: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  if (guids.length === 0) return seen;
  for (let i = 0; i < guids.length; i += 500) {
    const chunk = guids.slice(i, i + 500);
    const rows = await ctx.db.query<{ entry_guid: string }>(
      `SELECT entry_guid FROM fuel_fillup FINAL WHERE entry_guid IN {ids:Array(String)}`,
      { ids: chunk },
    );
    for (const row of rows) seen.add(String(row.entry_guid));
  }
  return seen;
}

async function chunkedInsert(ctx: ModuleContext, table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) await ctx.db.insert(table, rows.slice(i, i + 1000));
}

async function importFuelioFiles(ctx: ConnectorContext, files: FuelFile[]): Promise<{ inserted: number; skipped: number; files: number }> {
  const parsed: FuelLogRow[] = [];
  for (const file of files) parsed.push(...(await parseFuelioFile(file)));
  const unique = new Map<string, FuelLogRow>();
  for (const row of parsed) unique.set(row.entry_guid, row);
  const all = [...unique.values()];
  const seen = await existingEntryGuids(ctx, all.map((r) => r.entry_guid));
  const toInsert = all
    .filter((r) => !seen.has(r.entry_guid))
    .map((r) => ({
      day: r.day,
      liters: r.liters,
      price_per_liter: r.price_per_liter,
      cost: r.cost,
      odometer: r.odometer,
      vehicle_guid: r.vehicle_guid,
      vehicle_name: r.vehicle_name,
      entry_guid: r.entry_guid,
    }));
  if (toInsert.length > 0) await chunkedInsert(ctx, "fuel_fillup", toInsert);
  return { inserted: toInsert.length, skipped: all.length - toInsert.length, files: files.length };
}

async function postForm(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new HttpError(res.status, `OAuth request failed (${res.status}): ${text.slice(0, 240)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function dropboxExchangeCode(clientId: string, clientSecret: string, code: string): Promise<{ accessToken: string; refreshToken: string }> {
  const data = await postForm(
    DROPBOX_TOKEN,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  );
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new Error("Dropbox did not return an access token.");
  return { accessToken, refreshToken: String(data.refresh_token ?? "") };
}

async function dropboxRefresh(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const data = await postForm(
    DROPBOX_TOKEN,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  );
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new Error("Dropbox refresh did not return an access token.");
  return accessToken;
}

async function dropboxListFiles(token: string, folderPath: string): Promise<Array<{ path: string; name: string }>> {
  const out: Array<{ path: string; name: string }> = [];
  let cursor = "";
  while (true) {
    const url = cursor
      ? "https://api.dropboxapi.com/2/files/list_folder/continue"
      : "https://api.dropboxapi.com/2/files/list_folder";
    const body = cursor ? { cursor } : { path: folderPath || "", recursive: true, include_non_downloadable_files: false };
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new HttpError(res.status, `Dropbox list_folder failed (${res.status}).`);
    const data = (await res.json()) as {
      entries?: Array<{ ".tag"?: string; path_lower?: string; name?: string }>;
      cursor?: string;
      has_more?: boolean;
    };
    for (const e of data.entries ?? []) {
      if (e[".tag"] !== "file") continue;
      out.push({ path: String(e.path_lower ?? ""), name: String(e.name ?? "") });
    }
    if (!data.has_more || !data.cursor) break;
    cursor = data.cursor;
  }
  return out;
}

async function dropboxDownload(token: string, path: string): Promise<FuelFile> {
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!res.ok) throw new HttpError(res.status, `Dropbox download failed (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return { name, bytes };
}

async function googleExchangeCode(clientId: string, clientSecret: string, code: string): Promise<{ accessToken: string; refreshToken: string }> {
  const data = await postForm(
    GOOGLE_TOKEN,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: GOOGLE_REDIRECT,
    }),
  );
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new Error("Google did not return an access token.");
  return { accessToken, refreshToken: String(data.refresh_token ?? "") };
}

async function googleRefresh(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const data = await postForm(
    GOOGLE_TOKEN,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  );
  const accessToken = String(data.access_token ?? "");
  if (!accessToken) throw new Error("Google refresh did not return an access token.");
  return accessToken;
}

async function googleListFiles(token: string, folderId: string, patterns: string[]): Promise<Array<{ id: string; name: string }>> {
  const nameFilter = patterns.length
    ? patterns.map((p) => `name contains '${p.replace(/'/g, "\\'")}'`).join(" or ")
    : "name contains 'sync.csv'";
  const folderFilter = folderId ? `'${folderId}' in parents and ` : "";
  const q = `${folderFilter}trashed = false and (${nameFilter})`;
  const url = `https://www.googleapis.com/drive/v3/files?fields=files(id,name)&q=${encodeURIComponent(q)}&pageSize=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new HttpError(res.status, `Google Drive list files failed (${res.status}).`);
  const data = (await res.json()) as { files?: Array<{ id?: string; name?: string }> };
  return (data.files ?? [])
    .map((f) => ({ id: String(f.id ?? ""), name: String(f.name ?? "") }))
    .filter((f) => !!f.id);
}

async function googleDownload(token: string, id: string, name: string): Promise<FuelFile> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new HttpError(res.status, `Google Drive download failed (${res.status}).`);
  return { name, bytes: new Uint8Array(await res.arrayBuffer()) };
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof HttpError && err.status === 401;
}

async function syncFromDropbox(ctx: ConnectorContext): Promise<{ inserted: number; skipped: number; files: number }> {
  const localPaths = parseCsvList(ctx.config.localPaths);
  const patterns = parseCsvList(ctx.config.filePatterns);
  const folderPath = String(ctx.config.folderPath ?? "").trim();
  const clientId = String(ctx.config.clientId ?? "").trim();
  const clientSecret = String(ctx.config.clientSecret ?? "").trim();
  let accessToken = String(ctx.config.accessToken ?? "").trim();
  const refreshToken = String(ctx.config.refreshToken ?? "").trim();

  const files: FuelFile[] = [];
  if (localPaths.length > 0) files.push(...(await collectLocalFiles(localPaths, patterns)));

  async function cloudFiles(token: string): Promise<FuelFile[]> {
    const listed = await dropboxListFiles(token, folderPath);
    const matched = listed.filter((f) => matchesAny(f.name, patterns) && /\.(csv|zip)$/i.test(f.name));
    const out: FuelFile[] = [];
    for (const f of matched) out.push(await dropboxDownload(token, f.path));
    return out;
  }

  if (clientId && clientSecret && (accessToken || refreshToken)) {
    if (!accessToken && refreshToken) {
      accessToken = await dropboxRefresh(clientId, clientSecret, refreshToken);
      await ctx.saveConfig({ accessToken });
    }
    try {
      files.push(...(await cloudFiles(accessToken)));
    } catch (err) {
      if (!isUnauthorized(err) || !refreshToken) throw err;
      accessToken = await dropboxRefresh(clientId, clientSecret, refreshToken);
      await ctx.saveConfig({ accessToken });
      files.push(...(await cloudFiles(accessToken)));
    }
  }

  if (files.length === 0) {
    throw new Error("No Fuelio files found. Set local paths and/or connect Dropbox with folder + file pattern.");
  }
  return importFuelioFiles(ctx, files);
}

async function syncFromGoogleDrive(ctx: ConnectorContext): Promise<{ inserted: number; skipped: number; files: number }> {
  const localPaths = parseCsvList(ctx.config.localPaths);
  const patterns = parseCsvList(ctx.config.filePatterns);
  const folderId = String(ctx.config.folderId ?? "").trim();
  const clientId = String(ctx.config.clientId ?? "").trim();
  const clientSecret = String(ctx.config.clientSecret ?? "").trim();
  let accessToken = String(ctx.config.accessToken ?? "").trim();
  const refreshToken = String(ctx.config.refreshToken ?? "").trim();

  const files: FuelFile[] = [];
  if (localPaths.length > 0) files.push(...(await collectLocalFiles(localPaths, patterns)));

  async function cloudFiles(token: string): Promise<FuelFile[]> {
    const listed = await googleListFiles(token, folderId, patterns);
    const matched = listed.filter((f) => /\.(csv|zip)$/i.test(f.name));
    const out: FuelFile[] = [];
    for (const f of matched) out.push(await googleDownload(token, f.id, f.name));
    return out;
  }

  if (clientId && clientSecret && (accessToken || refreshToken)) {
    if (!accessToken && refreshToken) {
      accessToken = await googleRefresh(clientId, clientSecret, refreshToken);
      await ctx.saveConfig({ accessToken });
    }
    try {
      files.push(...(await cloudFiles(accessToken)));
    } catch (err) {
      if (!isUnauthorized(err) || !refreshToken) throw err;
      accessToken = await googleRefresh(clientId, clientSecret, refreshToken);
      await ctx.saveConfig({ accessToken });
      files.push(...(await cloudFiles(accessToken)));
    }
  }

  if (files.length === 0) {
    throw new Error("No Fuelio files found. Set local paths and/or connect Google Drive with folder + file pattern.");
  }
  return importFuelioFiles(ctx, files);
}

const fuelioDropbox: Connector = {
  id: "fuelio-dropbox",
  name: "Fuelio (Dropbox Backup)",
  description:
    "Sync Fuelio CSV/CSV.ZIP backups from Dropbox and/or local file paths. Supports one or many vehicle backup files.",
  kind: "api",
  icon: DROPBOX_ICON,
  syncIntervalMinutes: 60,
  configSchema: [
    { key: "clientId", label: "Dropbox app key", type: "text", help: "Create an app in Dropbox Developers." },
    { key: "clientSecret", label: "Dropbox app secret", type: "password", secret: true, optional: true },
    { key: "accessToken", label: "Access token", type: "password", secret: true, optional: true },
    { key: "refreshToken", label: "Refresh token", type: "password", secret: true, optional: true },
    { key: "folderPath", label: "Dropbox folder path", type: "text", default: "", help: "Example: /Apps/Fuelio" },
    {
      key: "filePatterns",
      label: "File name contains (comma-separated)",
      type: "text",
      default: "sync.csv.zip,sync.csv",
      help: "Matches one or multiple vehicle files.",
    },
    {
      key: "localPaths",
      label: "Local file/folder paths (comma-separated)",
      type: "text",
      default: "",
      help: "Optional host-mounted paths for automatic sync when you replace files.",
    },
  ],
  async authorize(ctx, input) {
    if (input.disconnect) {
      await ctx.saveConfig({ accessToken: "", refreshToken: "" });
      return { message: "Disconnected from Dropbox." };
    }
    const clientId = String(ctx.config.clientId ?? "").trim();
    const clientSecret = String(ctx.config.clientSecret ?? "").trim();
    const code = String(input.code ?? "").trim();
    if (!clientId || !clientSecret) throw new Error("Save Dropbox app key and secret first.");
    if (!code) throw new Error("Paste the Dropbox authorization code.");
    const tok = await dropboxExchangeCode(clientId, clientSecret, code);
    await ctx.saveConfig({ accessToken: tok.accessToken, refreshToken: tok.refreshToken });
    return { message: "Connected to Dropbox." };
  },
  async sync(ctx) {
    const out = await syncFromDropbox(ctx);
    return {
      inserted: out.inserted,
      message: `Fuelio sync complete: ${out.inserted} inserted, ${out.skipped} skipped from ${out.files} file(s).`,
    };
  },
};

const fuelioGoogleDrive: Connector = {
  id: "fuelio-google-drive",
  name: "Fuelio (Google Drive Backup)",
  description:
    "Sync Fuelio CSV/CSV.ZIP backups from Google Drive and/or local file paths. Supports one or many vehicle backup files.",
  kind: "api",
  icon: GDRIVE_ICON,
  syncIntervalMinutes: 60,
  configSchema: [
    { key: "clientId", label: "Google OAuth client ID", type: "text", help: "Use a Desktop app OAuth client." },
    { key: "clientSecret", label: "Google OAuth client secret", type: "password", secret: true, optional: true },
    { key: "accessToken", label: "Access token", type: "password", secret: true, optional: true },
    { key: "refreshToken", label: "Refresh token", type: "password", secret: true, optional: true },
    { key: "folderId", label: "Drive folder ID", type: "text", default: "", help: "Optional: limit to one folder." },
    {
      key: "filePatterns",
      label: "File name contains (comma-separated)",
      type: "text",
      default: "sync.csv.zip,sync.csv",
      help: "Matches one or multiple vehicle files.",
    },
    {
      key: "localPaths",
      label: "Local file/folder paths (comma-separated)",
      type: "text",
      default: "",
      help: "Optional host-mounted paths for automatic sync when you replace files.",
    },
  ],
  async authorize(ctx, input) {
    if (input.disconnect) {
      await ctx.saveConfig({ accessToken: "", refreshToken: "" });
      return { message: "Disconnected from Google Drive." };
    }
    const clientId = String(ctx.config.clientId ?? "").trim();
    const clientSecret = String(ctx.config.clientSecret ?? "").trim();
    const code = String(input.code ?? "").trim();
    if (!clientId || !clientSecret) throw new Error("Save Google client ID and secret first.");
    if (!code) throw new Error("Paste the Google authorization code.");
    const tok = await googleExchangeCode(clientId, clientSecret, code);
    await ctx.saveConfig({ accessToken: tok.accessToken, refreshToken: tok.refreshToken });
    return { message: "Connected to Google Drive." };
  },
  async sync(ctx) {
    const out = await syncFromGoogleDrive(ctx);
    return {
      inserted: out.inserted,
      message: `Fuelio sync complete: ${out.inserted} inserted, ${out.skipped} skipped from ${out.files} file(s).`,
    };
  },
};

const fuelioLocal: Connector = {
  id: "fuelio-local",
  name: "Fuelio (Local Files)",
  description:
    "Sync Fuelio CSV or CSV.ZIP from one or multiple local file paths. Replace files in place and sync runs automatically.",
  kind: "manual",
  icon: FUELIO_ICON,
  syncIntervalMinutes: 30,
  configSchema: [
    {
      key: "localPaths",
      label: "Local file/folder paths (comma-separated)",
      type: "text",
      default: "",
      help: "Example: /data/fuelio,/data/fuelio/vehicle-1-sync.csv.zip",
    },
    {
      key: "filePatterns",
      label: "File name contains (comma-separated)",
      type: "text",
      default: "sync.csv.zip,sync.csv",
      help: "Use this to include multiple vehicle backup files.",
    },
  ],
  async sync(ctx) {
    const localPaths = parseCsvList(ctx.config.localPaths);
    const patterns = parseCsvList(ctx.config.filePatterns);
    if (localPaths.length === 0) throw new Error("Set at least one local path.");
    const files = await collectLocalFiles(localPaths, patterns);
    if (files.length === 0) throw new Error("No matching CSV/ZIP files found in local paths.");
    const out = await importFuelioFiles(ctx, files);
    return {
      inserted: out.inserted,
      message: `Fuelio local sync complete: ${out.inserted} inserted, ${out.skipped} skipped from ${out.files} file(s).`,
    };
  },
};

const inboxFuelScan: Connector = {
  id: "inbox-fuel",
  name: "Email receipts",
  description: "Control whether inbox scanning imports parking receipts into this module.",
  kind: "manual",
  configSchema: [
    {
      key: "scanParking",
      label: "Scan parking receipts",
      type: "boolean",
      default: true,
      help: "Q-Park, EasyPark, Parkmobile, and similar parking payment receipts",
    },
  ],
};

const fuel: LifeStackModule = {
  id: "fuel",
  name: "Fuel",
  description: "Fuel fill-ups, parking costs, and overall car running expenses.",
  icon: "⛽",
  accent: "oklch(0.73 0.16 55)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS fuel_fillup (
       day Date,
       liters Float64,
       price_per_liter Float64,
       cost Float64,
       odometer Int32
     ) ENGINE = ReplacingMergeTree ORDER BY odometer`,
    `ALTER TABLE fuel_fillup ADD COLUMN IF NOT EXISTS vehicle_guid String DEFAULT '' AFTER odometer`,
    `ALTER TABLE fuel_fillup ADD COLUMN IF NOT EXISTS vehicle_name String DEFAULT '' AFTER vehicle_guid`,
    `ALTER TABLE fuel_fillup ADD COLUMN IF NOT EXISTS entry_guid String DEFAULT '' AFTER vehicle_name`,
    `CREATE TABLE IF NOT EXISTS fuel_parking_entry (
       day Date,
       started_at DateTime64(3) DEFAULT toDateTime64(day, 3),
       provider String,
       location String DEFAULT '',
       amount Float64,
       currency String DEFAULT 'EUR',
       amount_eur Float64 DEFAULT amount,
       source String DEFAULT 'inbox',
       message_id String,
       notes String DEFAULT ''
     ) ENGINE = ReplacingMergeTree ORDER BY (day, provider, message_id)`,
  ],
  connectors: [fuelioDropbox, fuelioGoogleDrive, fuelioLocal, inboxFuelScan],
  widgets: [
    {
      id: "avg-consumption",
      title: "Average economy",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ liters: number; odometer: number }>(
          `SELECT liters, odometer FROM fuel_fillup FINAL ORDER BY day, odometer`,
        );
        let litres = 0;
        let dist = 0;
        for (let i = 1; i < rows.length; i++) {
          const d = rows[i].odometer - rows[i - 1].odometer;
          if (d > 0) {
            dist += d;
            litres += rows[i].liters;
          }
        }
        return { value: dist > 0 ? round2((litres / dist) * 100) : 0, unit: "L/100km" };
      },
    },
    {
      id: "total-spent",
      title: "Total fuel spend",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(cost), 2) AS v FROM fuel_fillup FINAL`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "parking-spent",
      title: "Total parking spend",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT round(sum(amount_eur), 2) AS v FROM fuel_parking_entry FINAL`,
        );
        return { value: rows[0]?.v ?? 0, format: "currency" };
      },
    },
    {
      id: "car-spent-total",
      title: "Total car spend",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ total: number }>(
          `SELECT
             round(sum(cost), 2)
               + coalesce((SELECT round(sum(amount_eur), 2) FROM fuel_parking_entry FINAL), 0) AS total
           FROM fuel_fillup FINAL`,
        );
        return { value: rows[0]?.total ?? 0, format: "currency" };
      },
    },
    {
      id: "latest-price",
      title: "Latest price",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT price_per_liter AS v FROM fuel_fillup FINAL ORDER BY day DESC LIMIT 1`,
        );
        return { value: rows[0]?.v ?? 0, unit: "€/L" };
      },
    },
    {
      id: "economy-trend",
      title: "Fuel economy per fill-up",
      subtitle: "L/100km",
      type: "line",
      size: "lg",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ label: string; liters: number; odometer: number }>(
          `SELECT formatDateTime(day, '%b %d') AS label, liters, odometer
           FROM fuel_fillup FINAL ORDER BY day, odometer`,
        );
        const series: { label: string; value: number }[] = [];
        for (let i = 1; i < rows.length; i++) {
          const d = rows[i].odometer - rows[i - 1].odometer;
          if (d > 0) series.push({ label: rows[i].label, value: round2((rows[i].liters / d) * 100) });
        }
        return { series, unit: "L/100km" };
      },
    },
    {
      id: "price-trend",
      title: "Price per liter",
      type: "line",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT formatDateTime(day, '%b %d') AS label, price_per_liter AS value
           FROM fuel_fillup FINAL ORDER BY day`,
        );
        return { series: rows, format: "currency" };
      },
    },
    {
      id: "cost-month",
      title: "Cost per month",
      type: "bar",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, round(s, 2) AS value
           FROM (SELECT toStartOfMonth(day) AS m, sum(cost) AS s FROM fuel_fillup FINAL GROUP BY m)
           ORDER BY m`,
        );
        return { series: rows, format: "currency" };
      },
    },
    {
      id: "recent",
      title: "Recent fill-ups",
      type: "table",
      size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT
             toString(day) AS date,
             if(vehicle_name = '', 'Vehicle', vehicle_name) AS vehicle,
             liters,
             price_per_liter AS price,
             round(cost, 2) AS cost,
             odometer
           FROM fuel_fillup FINAL
           ORDER BY day DESC, odometer DESC
           LIMIT 24`,
        );
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "vehicle", label: "Vehicle" },
            { key: "liters", label: "Liters", align: "right" },
            { key: "price", label: "€/L", format: "currency", align: "right" },
            { key: "cost", label: "Cost", format: "currency", align: "right" },
            { key: "odometer", label: "Odometer", align: "right" },
          ],
          rows,
        };
      },
    },
    {
      id: "recent-parking",
      title: "Recent parking costs",
      type: "table",
      size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT
             formatDateTime(started_at, '%Y-%m-%d %H:%i') AS when,
             provider,
             location,
             round(amount, 2) AS amount,
             upperUTF8(currency) AS currency,
             round(amount_eur, 2) AS amount_eur
           FROM fuel_parking_entry FINAL
           ORDER BY started_at DESC, provider ASC
           LIMIT 24`,
        );
        return {
          columns: [
            { key: "when", label: "When" },
            { key: "provider", label: "Provider" },
            { key: "location", label: "Location" },
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

export default fuel;
