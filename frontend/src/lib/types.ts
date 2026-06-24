export type WidgetType =
  | "metric"
  | "statpanel"
  | "split"
  | "cards"
  | "bar"
  | "line"
  | "donut"
  | "calendar"
  | "list"
  | "table";
export type WidgetSize = "sm" | "md" | "lg" | "xl";

export interface SyncInfo {
  at: string | null;
  status: string | null;
  message: string | null;
}

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
  lastSync: SyncInfo | null;
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
export interface StatPanelRow {
  kind: string;
  minutes: number;
  count: number;
  countUnit?: string;
}
export interface StatPanelData {
  segments: { label: string; rows: StatPanelRow[] }[];
}
export interface SplitPart {
  label: string;
  value: number | string;
  unit?: string;
  format?: string;
}
export interface SplitData {
  parts: SplitPart[];
}
export interface CardsItem {
  label: string;
  rides: number;
  distance_km: number;
  cost: number;
  avg_cost?: number;
  bike_rides?: number;
  bike_km?: number;
  scooter_rides?: number;
  scooter_km?: number;
  taxi_rides?: number;
  taxi_km?: number;
}
export interface CardsData {
  cards: CardsItem[];
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
  type: "text" | "password" | "number" | "boolean" | "section";
  help: string | null;
  secret: boolean;
  hasValue: boolean;
  value?: string | number | boolean;
  icon?: string;
}

export interface ConnectorView {
  id: string;
  name: string;
  description: string;
  kind: "api" | "import" | "manual" | "oauth";
  icon: string | null;
  enabled: boolean;
  hasSync: boolean;
  hasAuthorize?: boolean;
  authorizeUrl?: string | null;
  hasImport: boolean;
  syncIntervalMinutes: number | null;
  config: ConfigField[];
  lastSync: SyncInfo | null;
}

export interface ModuleDetail extends ModuleMeta {
  enabled: boolean;
  widgetCount: number;
  lastSync: SyncInfo | null;
  connectors: ConnectorView[];
}

export interface OverviewFeatured extends ModuleMeta {
  widget: WidgetResult;
}

export interface OverviewData {
  modules: (ModuleMeta & { enabled: boolean; lastSync: SyncInfo | null })[];
  featured: OverviewFeatured[];
}

export interface ObservationInsightsSummary {
  totalObservations: number;
  totalSpecies: number;
  countriesObserved: number;
  mappedObservations: number;
  activeDays: number;
  firstObserved: string | null;
  lastObserved: string | null;
}

export interface ObservationMonthlyPoint {
  month: string;
  label: string;
  observations: number;
  species: number;
}

export interface ObservationCountryStat {
  country: string;
  observations: number;
  species: number;
}

export interface ObservationMapPoint {
  lat: number;
  lon: number;
  species: string;
  country: string;
  date: string;
}

export interface ObservationInsights {
  module: ModuleMeta;
  enabled: boolean;
  summary: ObservationInsightsSummary | null;
  monthly: ObservationMonthlyPoint[];
  countries: ObservationCountryStat[];
  map: {
    totalMapped: number;
    returned: number;
    points: ObservationMapPoint[];
  };
  topSpecies: { species: string; observations: number }[];
  streaks: { current: number; latest: number; longest: number };
  busiestDay: { date: string; observations: number } | null;
}

export interface AiStatus {
  configured: boolean;
  model: string | null;
  baseUrl: string | null;
  hasKey: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  attachments?: { name?: string | null; mime: string; dataUrl: string }[];
}

export interface ChatStep {
  sql: string;
  rows: Record<string, unknown>[] | null;
  error: string | null;
}

export interface PendingChange {
  id: string;
  kind: "write_records" | "delete_records" | "update_records";
  target: string;
  rows?: unknown[];
  where?: unknown;
  updates?: Record<string, unknown>;
  summary: string;
}

export interface ChatResponse {
  reply: string;
  steps: ChatStep[];
  configured: boolean;
  pendingActions?: PendingChange[];
}
