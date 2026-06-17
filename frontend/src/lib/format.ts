import type { SyncInfo } from "./types";

const eurWhole = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});
const eurCents = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCurrency(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.abs(n) >= 100 ? eurWhole.format(n) : eurCents.format(n);
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const decimals = Number.isInteger(n) ? 0 : 1;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals }).format(n);
}

/** Compact axis label, e.g. 1.2k, 3.4M. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (abs >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return formatNumber(n);
}

/** Format a value for display given an optional `format` ('currency') and `unit`. */
export function display(value: unknown, format?: string, compact = false): string {
  if (typeof value !== "number") return String(value ?? "—");
  if (format === "currency") return formatCurrency(value);
  return compact ? formatCompact(value) : formatNumber(value);
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Whether the most recent sync attempt ended in an error. */
export function syncFailed(info: SyncInfo | null | undefined): boolean {
  return info?.status === "error";
}

/** Human label for a connector or module's last sync, e.g. "synced 5m ago". */
export function syncLabel(info: SyncInfo | null | undefined): string {
  if (!info?.at) return "not synced yet";
  return `${syncFailed(info) ? "sync failed" : "synced"} ${relativeTime(info.at)}`;
}

/** Watch time from minutes, Trakt style: 150d 2h 56m, 13h 25m, 47m. */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  const total = Math.round(minutes);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
