import { env } from "./env";
import type { Logger } from "./core/types";

const order = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const threshold = order[env.LOG_LEVEL] ?? 20;

function emit(level: keyof typeof order, tag: string, msg: string, extra: unknown[]) {
  if (order[level] < threshold) return;
  const time = new Date().toISOString();
  const label = level.toUpperCase().padEnd(5);
  const scope = tag ? ` [${tag}]` : "";
  const line = `${time} ${label}${scope} ${msg}`;
  if (level === "error") console.error(line, ...extra);
  else if (level === "warn") console.warn(line, ...extra);
  else console.log(line, ...extra);
}

function make(tag: string): Logger & { child: (t: string) => Logger } {
  return {
    debug: (msg, ...a) => emit("debug", tag, msg, a),
    info: (msg, ...a) => emit("info", tag, msg, a),
    warn: (msg, ...a) => emit("warn", tag, msg, a),
    error: (msg, ...a) => emit("error", tag, msg, a),
    child: (t: string) => make(tag ? `${tag}:${t}` : t),
  };
}

export const logger = make("");
