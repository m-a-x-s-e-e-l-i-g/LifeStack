export type WidgetType = "metric" | "bar" | "line" | "donut" | "calendar" | "list" | "table";
export type WidgetSize = "sm" | "md" | "lg" | "xl";

export interface ModuleMeta {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
}

export interface ModuleSummary extends ModuleMeta {
  enabled: boolean;
  connectorCount: number;
  enabledConnectors: number;
  hasApi: boolean;
  widgetCount: number;
  lastSync: string | null;
}

export interface WidgetResult {
  id: string;
  title: string;
  subtitle: string | null;
  type: WidgetType;
  size: WidgetSize;
  data: unknown;
  error: string | null;
}

export interface MetricData {
  value: number | string;
  unit?: string;
  format?: string;
  delta?: number;
  deltaLabel?: string;
}
export interface SeriesPoint {
  label: string;
  value: number;
}
export interface SeriesData {
  series: SeriesPoint[];
  unit?: string;
  format?: string;
  signed?: boolean;
}
export interface DonutData {
  slices: { label: string; value: number }[];
  unit?: string;
  format?: string;
}
export interface CalendarData {
  days: { date: string; value: number }[];
  unit?: string;
}
export interface ListData {
  items: { label: string; value: number | string; sub?: string }[];
  format?: string;
}
export interface TableColumn {
  key: string;
  label: string;
  format?: string;
  align?: "left" | "right";
}
export interface TableData {
  columns: TableColumn[];
  rows: Record<string, unknown>[];
}

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  help: string | null;
  secret: boolean;
  hasValue: boolean;
  value?: string | number | boolean;
}

export interface ConnectorView {
  id: string;
  name: string;
  description: string;
  kind: "api" | "import" | "manual";
  enabled: boolean;
  hasSync: boolean;
  hasImport: boolean;
  syncIntervalMinutes: number | null;
  config: ConfigField[];
  lastSync: string | null;
}

export interface ModuleDetail extends ModuleMeta {
  enabled: boolean;
  widgetCount: number;
  lastSync: string | null;
  connectors: ConnectorView[];
}

export interface OverviewFeatured extends ModuleMeta {
  widget: WidgetResult;
}

export interface OverviewData {
  modules: (ModuleMeta & { enabled: boolean; lastSync: string | null })[];
  featured: OverviewFeatured[];
}
