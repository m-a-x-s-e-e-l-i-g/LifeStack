import type { QueryResult, QueryResultRow } from "pg";

export interface Logger {
  debug: (msg: string, ...args: unknown[]) => void;
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface ModuleDb {
  query<T extends QueryResultRow = any>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

/** Context handed to widget queries and module seed. `config` is reserved module config. */
export interface ModuleContext {
  db: ModuleDb;
  config: Record<string, unknown>;
  logger: Logger;
  now: Date;
}

/** Context handed to a connector's sync/import. `config` is the connector's resolved config. */
export type ConnectorContext = ModuleContext;

export type WidgetType =
  | "metric"
  | "bar"
  | "line"
  | "donut"
  | "calendar"
  | "list"
  | "table";

export type WidgetSize = "sm" | "md" | "lg" | "xl";

export interface Widget {
  id: string;
  title: string;
  subtitle?: string;
  type: WidgetType;
  size?: WidgetSize;
  /** Show this widget on the cross-module overview page. */
  featured?: boolean;
  query: (ctx: ModuleContext) => Promise<unknown>;
}

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  default?: string | number | boolean;
  help?: string;
  /** Treat as secret: never return the value over the API, only whether it is set. */
  secret?: boolean;
  /** Environment variable used as a fallback default. */
  env?: string;
}

export interface SyncResult {
  inserted?: number;
  updated?: number;
  message?: string;
}

/**
 * A pluggable data source for a module. `api` connectors pull from an external
 * service via `sync`; `import`/`manual` connectors accept rows via `import`.
 */
export interface Connector {
  id: string;
  name: string;
  description: string;
  kind: "api" | "import" | "manual";
  configSchema?: ConfigField[];
  syncIntervalMinutes?: number;
  sync?: (ctx: ConnectorContext) => Promise<SyncResult>;
  import?: (ctx: ConnectorContext, rows: unknown[]) => Promise<SyncResult>;
}

/** A domain (movies, finance, energy, ...). Owns its schema, stats, and connectors. */
export interface LifeStackModule {
  id: string;
  name: string;
  description: string;
  /** Emoji or short glyph shown in the nav and headers. */
  icon: string;
  /** OKLCH color string owned by this module, used across its charts. */
  accent: string;
  migrations: string[];
  connectors: Connector[];
  /** Insert realistic synthetic data for demo mode. */
  seed?: (ctx: ModuleContext) => Promise<void>;
  widgets: Widget[];
}
