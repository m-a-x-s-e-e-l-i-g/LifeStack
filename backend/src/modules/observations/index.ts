import type { Connector, LifeStackModule, ModuleContext } from "../../core/types";

const GBIF_ICON = `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 2.5c3.8 0 6.9 2.9 6.9 6.5 0 5.4-4 9.5-6.9 12.5C9.1 18.5 5.1 14.4 5.1 9c0-3.6 3.1-6.5 6.9-6.5Z"/><path d="M12 6.1v6.6"/><path d="M8.8 9.4h6.4"/></svg>`;

const OBSERVATION_DATASET_KEY = "8a863029-f435-446a-821e-275f4f641165";
const GBIF_SEARCH_URL = "https://api.gbif.org/v1/occurrence/search";
const GBIF_USER_AGENT = "LifeStack/1.0 (+https://github.com/m-a-x-s-e-e-l-i-g/LifeStack)";

interface GbifOccurrence {
  key?: number;
  gbifID?: string;
  datasetKey?: string;
  occurrenceID?: string;
  recordedBy?: string;
  eventDate?: string;
  eventTime?: string;
  scientificName?: string;
  vernacularName?: string;
  taxonRank?: string;
  kingdom?: string;
  phylum?: string;
  class?: string;
  order?: string;
  family?: string;
  genus?: string;
  species?: string;
  countryCode?: string;
  country?: string;
  stateProvince?: string;
  locality?: string;
  decimalLatitude?: number;
  decimalLongitude?: number;
  coordinateUncertaintyInMeters?: number;
  individualCount?: number;
  media?: unknown[];
  issues?: unknown[];
  basisOfRecord?: string;
  occurrenceStatus?: string;
  license?: string;
  lastInterpreted?: string;
}

interface GbifSearchResponse {
  count?: number;
  offset?: number;
  limit?: number;
  endOfRecords?: boolean;
  results?: GbifOccurrence[];
}

interface ObservationRow {
  gbif_id: number;
  observation_id: string;
  occurrence_id: string;
  recorded_by: string;
  event_date: string;
  event_time: string;
  scientific_name: string;
  vernacular_name: string;
  taxon_rank: string;
  kingdom: string;
  phylum: string;
  class_name: string;
  order_name: string;
  family: string;
  genus: string;
  species: string;
  country_code: string;
  country: string;
  state_province: string;
  locality: string;
  decimal_latitude: number;
  decimal_longitude: number;
  coordinate_uncertainty_m: number;
  individual_count: number;
  media_count: number;
  issue_count: number;
  basis_of_record: string;
  occurrence_status: string;
  license: string;
  dataset_key: string;
  last_interpreted: string;
  synced_at: string;
  source: string;
  _last_interpreted_ts: number;
}

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function int(value: unknown): number {
  return Math.round(numeric(value));
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isoDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m?.[1]) return m[1];
  const d = new Date(raw);
  if (Number.isNaN(d.valueOf())) return null;
  return d.toISOString().slice(0, 10);
}

function isoTimestamp(value: unknown): string {
  const raw = text(value);
  if (!raw) return "1970-01-01T00:00:00Z";
  const d = new Date(raw);
  if (Number.isNaN(d.valueOf())) return "1970-01-01T00:00:00Z";
  return d.toISOString();
}

function unixTs(value: unknown): number {
  const d = new Date(String(value ?? ""));
  if (Number.isNaN(d.valueOf())) return 0;
  return Math.floor(d.valueOf() / 1000);
}

function observationId(occurrenceId: string): string {
  const m = occurrenceId.match(/\/observation\/(\d+)(?:\D|$)/i);
  return m?.[1] ?? "";
}

async function chunkedInsert(
  ctx: ModuleContext,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    await ctx.db.insert(table, rows.slice(i, i + 1000));
  }
}

async function existingInterpretedTs(
  ctx: ModuleContext,
  ids: number[],
): Promise<Map<number, number>> {
  const seen = new Map<number, number>();
  if (ids.length === 0) return seen;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await ctx.db.query<{ gbif_id: number; last_interpreted_ts: number }>(
      `SELECT gbif_id, toUnixTimestamp(last_interpreted) AS last_interpreted_ts
       FROM observation_occurrence FINAL
       WHERE gbif_id IN {ids:Array(Int64)}`,
      { ids: chunk },
    );
    for (const row of rows) seen.set(int(row.gbif_id), int(row.last_interpreted_ts));
  }
  return seen;
}

function normalizeRow(o: GbifOccurrence, fallbackDatasetKey: string): ObservationRow | null {
  const gbifId = int(o.key ?? o.gbifID);
  if (!gbifId) return null;
  const interpreted = isoTimestamp(o.lastInterpreted);
  const eventDate =
    isoDate(o.eventDate) ??
    isoDate(o.lastInterpreted) ??
    "1970-01-01";
  const occurrenceIdValue = text(o.occurrenceID);
  return {
    gbif_id: gbifId,
    observation_id: observationId(occurrenceIdValue),
    occurrence_id: occurrenceIdValue,
    recorded_by: text(o.recordedBy),
    event_date: eventDate,
    event_time: text(o.eventTime),
    scientific_name: text(o.scientificName),
    vernacular_name: text(o.vernacularName),
    taxon_rank: text(o.taxonRank),
    kingdom: text(o.kingdom),
    phylum: text(o.phylum),
    class_name: text(o.class),
    order_name: text(o.order),
    family: text(o.family),
    genus: text(o.genus),
    species: text(o.species),
    country_code: text(o.countryCode),
    country: text(o.country),
    state_province: text(o.stateProvince),
    locality: text(o.locality),
    decimal_latitude: numeric(o.decimalLatitude),
    decimal_longitude: numeric(o.decimalLongitude),
    coordinate_uncertainty_m: numeric(o.coordinateUncertaintyInMeters),
    individual_count: int(o.individualCount),
    media_count: Array.isArray(o.media) ? o.media.length : 0,
    issue_count: Array.isArray(o.issues) ? o.issues.length : 0,
    basis_of_record: text(o.basisOfRecord),
    occurrence_status: text(o.occurrenceStatus),
    license: text(o.license),
    dataset_key: text(o.datasetKey) || fallbackDatasetKey,
    last_interpreted: interpreted,
    synced_at: new Date().toISOString(),
    source: "gbif",
    _last_interpreted_ts: unixTs(interpreted),
  };
}

async function fetchPage(
  datasetKey: string,
  recordedBy: string,
  offset: number,
  limit: number,
): Promise<GbifSearchResponse> {
  const url = new URL(GBIF_SEARCH_URL);
  url.searchParams.set("datasetKey", datasetKey);
  url.searchParams.set("recordedBy", recordedBy);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": GBIF_USER_AGENT,
    },
  });

  if (res.status === 429) {
    throw new Error("GBIF rate limited the request. Try syncing again in a minute.");
  }
  if (!res.ok) {
    throw new Error(`GBIF API error ${res.status} while fetching observations.`);
  }
  return (await res.json()) as GbifSearchResponse;
}

const gbifObservationOrg: Connector = {
  id: "gbif-observation-org",
  name: "GBIF / Observation.org",
  description:
    "Sync your Observation.org records through GBIF occurrence search.",
  kind: "api",
  icon: GBIF_ICON,
  syncIntervalMinutes: 720,
  configSchema: [
    {
      key: "observationUserId",
      label: "Observation.org user ID",
      type: "text",
      default: "987548",
      env: "OBSERVATION_ORG_USER_ID",
      help: "Numeric ID from your profile URL: observation.org/users/<id>/",
    },
    {
      key: "datasetKey",
      label: "GBIF dataset key",
      type: "text",
      default: OBSERVATION_DATASET_KEY,
      optional: true,
      help: "Advanced: override only if your records are published in a different GBIF dataset.",
    },
  ],
  async sync(ctx) {
    const rawId = text(ctx.config.observationUserId).replace(/\D+/g, "");
    if (!rawId) {
      throw new Error("Set your Observation.org user ID to sync observations.");
    }
    const recordedBy = `User ${rawId}`;
    const datasetKey = text(ctx.config.datasetKey) || OBSERVATION_DATASET_KEY;
    const pageSize = 300;

    let offset = 0;
    let scanned = 0;
    let inserted = 0;
    let total: number | null = null;

    for (let page = 0; page < 350; page++) {
      const body = await fetchPage(datasetKey, recordedBy, offset, pageSize);
      const results = Array.isArray(body.results) ? body.results : [];
      if (total === null && typeof body.count === "number") total = body.count;
      if (results.length === 0) break;

      scanned += results.length;
      const normalized = results
        .map((o) => normalizeRow(o, datasetKey))
        .filter((o): o is ObservationRow => !!o);

      const ids = normalized.map((r) => r.gbif_id);
      const known = await existingInterpretedTs(ctx, ids);
      const toInsert = normalized
        .filter((row) => {
          const prev = known.get(row.gbif_id);
          return prev === undefined || row._last_interpreted_ts > prev;
        })
        .map(({ _last_interpreted_ts, ...row }) => row);

      if (toInsert.length > 0) {
        await chunkedInsert(ctx, "observation_occurrence", toInsert);
        inserted += toInsert.length;
      }

      if (body.endOfRecords || results.length < pageSize) break;
      offset += results.length;
      if (offset >= 100_000) break;
    }

    return {
      inserted,
      message: `synced ${scanned} observation(s) for ${recordedBy}${
        total !== null ? ` (GBIF count ${total})` : ""
      }`,
    };
  },
};

const observations: LifeStackModule = {
  id: "observations",
  name: "Nature observations",
  description:
    "Your Observation.org records synced through GBIF: species, places, and trends.",
  icon: "🦉",
  accent: "oklch(0.74 0.16 145)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS observation_occurrence (
       gbif_id Int64,
       observation_id String,
       occurrence_id String,
       recorded_by String,
       event_date Date,
       event_time String,
       scientific_name String,
       vernacular_name String,
       taxon_rank String,
       kingdom String,
       phylum String,
       class_name String,
       order_name String,
       family String,
       genus String,
       species String,
       country_code String,
       country String,
       state_province String,
       locality String,
       decimal_latitude Float64,
       decimal_longitude Float64,
       coordinate_uncertainty_m Float64,
       individual_count Int32,
       media_count Int32,
       issue_count Int32,
       basis_of_record String,
       occurrence_status String,
       license String,
       dataset_key String,
       last_interpreted DateTime,
       synced_at DateTime DEFAULT now(),
       source String DEFAULT 'gbif'
     ) ENGINE = ReplacingMergeTree(last_interpreted) ORDER BY gbif_id`,
  ],
  connectors: [gbifObservationOrg],
  widgets: [
    {
      id: "total-observations",
      title: "Total observations",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(count()) AS v FROM observation_occurrence FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "obs" };
      },
    },
    {
      id: "species-count",
      title: "Species observed",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(uniqExact(name)) AS v
           FROM (
             SELECT if(species != '', species, scientific_name) AS name
             FROM observation_occurrence FINAL
             WHERE species != '' OR scientific_name != ''
           )`,
        );
        return { value: rows[0]?.v ?? 0, unit: "species" };
      },
    },
    {
      id: "this-year",
      title: "Observations this year",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ cur: number; prev: number }>(
          `SELECT
             toInt32(countIf(toYear(event_date) = toYear(today()))) AS cur,
             toInt32(countIf(toYear(event_date) = toYear(today()) - 1)) AS prev
           FROM observation_occurrence FINAL`,
        );
        const cur = rows[0]?.cur ?? 0;
        const prev = rows[0]?.prev ?? 0;
        return {
          value: cur,
          unit: "obs",
          delta: cur - prev,
          deltaLabel: "vs last year",
        };
      },
    },
    {
      id: "monthly-trend",
      title: "Monthly observations",
      subtitle: "Last 12 months",
      type: "bar",
      size: "lg",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, toInt32(c) AS value
           FROM (
             SELECT toStartOfMonth(event_date) AS m, count() AS c
             FROM observation_occurrence FINAL
             WHERE event_date >= toStartOfMonth(today()) - INTERVAL 11 MONTH
             GROUP BY m
           )
           ORDER BY m`,
        );
        return { series: rows, unit: "obs" };
      },
    },
    {
      id: "class-split",
      title: "Observed classes",
      type: "donut",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT if(class_name = '', 'Unknown', class_name) AS label, toInt32(count()) AS value
           FROM observation_occurrence FINAL
           GROUP BY label
           ORDER BY value DESC
           LIMIT 8`,
        );
        return { slices: rows, unit: "obs" };
      },
    },
    {
      id: "top-species",
      title: "Top species",
      type: "list",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ label: string; value: number; sub: string }>(
          `SELECT
             if(species != '', species, scientific_name) AS label,
             toInt32(count()) AS value,
             concat('Last seen ', toString(max(event_date))) AS sub
           FROM observation_occurrence FINAL
           WHERE species != '' OR scientific_name != ''
           GROUP BY label
           ORDER BY value DESC
           LIMIT 8`,
        );
        return { items: rows };
      },
    },
    {
      id: "calendar",
      title: "Observation calendar",
      subtitle: "Last 365 days",
      type: "calendar",
      size: "lg",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT toString(event_date) AS date, toInt32(count()) AS value
           FROM observation_occurrence FINAL
           WHERE event_date >= today() - INTERVAL 365 DAY
           GROUP BY event_date
           ORDER BY event_date`,
        );
        return { days: rows, unit: "obs" };
      },
    },
    {
      id: "recent",
      title: "Recent observations",
      type: "table",
      size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT
             toString(event_date) AS date,
             if(species != '', species, scientific_name) AS species,
             if(country != '', country, country_code) AS country,
             if(locality != '', locality, state_province) AS location,
             media_count
           FROM observation_occurrence FINAL
           ORDER BY event_date DESC, gbif_id DESC
           LIMIT 15`,
        );
        return {
          columns: [
            { key: "date", label: "Date" },
            { key: "species", label: "Species" },
            { key: "country", label: "Country" },
            { key: "location", label: "Location" },
            { key: "media_count", label: "Media", align: "right" },
          ],
          rows,
        };
      },
    },
  ],
};

export default observations;