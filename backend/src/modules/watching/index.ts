import type { Connector, LifeStackModule, ModuleContext } from "../../core/types";

/** Circled play mark used as the Trakt connector glyph (uses currentColor). */
const TRAKT_ICON = `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="M10.2 8.4 16 12l-5.8 3.6V8.4Z" fill="currentColor" stroke="none"/></svg>`;

const TRAKT = "https://api.trakt.tv";

interface TraktIds {
  trakt?: number;
}
interface TraktMovie {
  title?: string;
  year?: number;
  runtime?: number;
  genres?: string[];
  ids?: TraktIds;
}
type TraktShow = TraktMovie;
interface TraktEpisode {
  title?: string;
  season?: number;
  number?: number;
  runtime?: number;
  ids?: TraktIds;
}

function isoDate(v: unknown): string {
  return String(v ?? "").slice(0, 10);
}

/** Stable positive integer id for rows that have no Trakt history id (CSV). */
function hashId(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) + 1;
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

function traktHeaders(clientId: string, token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
    Authorization: `Bearer ${token}`,
  };
}

async function traktGet<T>(
  path: string,
  headers: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${TRAKT}${path}`, { headers });
  if (res.status === 404) return [] as unknown as T;
  if (!res.ok) throw new Error(`Trakt API error ${res.status} for ${path}`);
  return (await res.json()) as T;
}

const trakt: Connector = {
  id: "trakt",
  name: "Trakt",
  description:
    "Sync everything from Trakt: watch history (movies and episodes), ratings, watchlist, collection, and your profile stats.",
  kind: "api",
  icon: TRAKT_ICON,
  syncIntervalMinutes: 360,
  configSchema: [
    { key: "clientId", label: "Trakt client ID", type: "text", env: "TRAKT_CLIENT_ID" },
    {
      key: "accessToken",
      label: "Trakt access token",
      type: "password",
      secret: true,
      env: "TRAKT_ACCESS_TOKEN",
      help: "OAuth access token from your Trakt application.",
    },
  ],
  async sync(ctx) {
    const clientId = String(ctx.config.clientId ?? "");
    const token = String(ctx.config.accessToken ?? "");
    if (!clientId || !token)
      throw new Error("Set a Trakt client ID and access token to sync");
    const headers = traktHeaders(clientId, token);
    let inserted = 0;

    // --- Watch history: movies + episodes, paginated (newest first) ---------
    const history: Record<string, unknown>[] = [];
    for (const type of ["movies", "episodes"] as const) {
      for (let page = 1; page <= 200; page++) {
        const items = await traktGet<
          Array<{
            id: number;
            watched_at: string;
            movie?: TraktMovie;
            show?: TraktShow;
            episode?: TraktEpisode;
          }>
        >(`/sync/history/${type}?extended=full&limit=100&page=${page}`, headers);
        if (!Array.isArray(items) || items.length === 0) break;
        for (const it of items) {
          if (type === "movies" && it.movie) {
            const m = it.movie;
            history.push({
              history_id: it.id,
              kind: "movie",
              watched_at: it.watched_at,
              watched_day: isoDate(it.watched_at),
              title: m.title ?? "Untitled",
              episode_title: "",
              season: 0,
              number: 0,
              year: m.year ?? 0,
              runtime: m.runtime ?? 0,
              genres: m.genres ?? [],
              trakt_id: m.ids?.trakt ?? 0,
            });
          } else if (type === "episodes" && it.episode && it.show) {
            const e = it.episode;
            const s = it.show;
            history.push({
              history_id: it.id,
              kind: "episode",
              watched_at: it.watched_at,
              watched_day: isoDate(it.watched_at),
              title: s.title ?? "Untitled",
              episode_title: e.title ?? "",
              season: e.season ?? 0,
              number: e.number ?? 0,
              year: s.year ?? 0,
              runtime: e.runtime ?? s.runtime ?? 0,
              genres: s.genres ?? [],
              trakt_id: s.ids?.trakt ?? 0,
            });
          }
        }
        if (items.length < 100) break;
      }
    }
    await chunkedInsert(ctx, "watch_history", history);
    inserted += history.length;

    // --- Ratings: movies, shows, seasons, episodes --------------------------
    const ratings: Record<string, unknown>[] = [];
    for (const type of ["movies", "shows", "seasons", "episodes"] as const) {
      const items = await traktGet<
        Array<{
          rated_at: string;
          rating: number;
          movie?: TraktMovie;
          show?: TraktShow;
          episode?: TraktEpisode;
          season?: { number?: number; ids?: TraktIds };
        }>
      >(`/sync/ratings/${type}`, headers);
      for (const it of items) {
        const kind = type.slice(0, -1);
        const obj = it.movie ?? it.show ?? it.episode ?? it.season;
        ratings.push({
          kind,
          trakt_id: obj?.ids?.trakt ?? 0,
          title: it.movie?.title ?? it.show?.title ?? it.episode?.title ?? "Untitled",
          year: it.movie?.year ?? it.show?.year ?? 0,
          rating: it.rating ?? 0,
          rated_at: it.rated_at,
        });
      }
    }
    await chunkedInsert(ctx, "watch_rating", ratings);
    inserted += ratings.length;

    // --- Watchlist ----------------------------------------------------------
    const watchlist: Record<string, unknown>[] = [];
    {
      const items = await traktGet<
        Array<{
          rank: number;
          listed_at: string;
          type: string;
          movie?: TraktMovie;
          show?: TraktShow;
        }>
      >(`/sync/watchlist?extended=full`, headers);
      for (const it of items) {
        const obj = it.movie ?? it.show;
        watchlist.push({
          kind: it.type ?? (it.movie ? "movie" : "show"),
          trakt_id: obj?.ids?.trakt ?? 0,
          title: obj?.title ?? "Untitled",
          year: obj?.year ?? 0,
          rank: it.rank ?? 0,
          listed_at: it.listed_at,
        });
      }
    }
    await chunkedInsert(ctx, "watch_watchlist", watchlist);
    inserted += watchlist.length;

    // --- Collection: movies + shows ----------------------------------------
    const collection: Record<string, unknown>[] = [];
    for (const type of ["movies", "shows"] as const) {
      const items = await traktGet<
        Array<{
          collected_at?: string;
          last_collected_at?: string;
          movie?: TraktMovie;
          show?: TraktShow;
        }>
      >(`/sync/collection/${type}?extended=full`, headers);
      for (const it of items) {
        const obj = it.movie ?? it.show;
        collection.push({
          kind: type.slice(0, -1),
          trakt_id: obj?.ids?.trakt ?? 0,
          title: obj?.title ?? "Untitled",
          year: obj?.year ?? 0,
          collected_at: it.collected_at ?? it.last_collected_at ?? new Date().toISOString(),
        });
      }
    }
    await chunkedInsert(ctx, "watch_collection", collection);
    inserted += collection.length;

    // --- Profile stats ------------------------------------------------------
    try {
      const stats = await traktGet<Record<string, Record<string, number>>>(
        `/users/me/stats`,
        headers,
      );
      const rows: Record<string, unknown>[] = [];
      for (const group of ["movies", "shows", "seasons", "episodes"]) {
        const g = stats?.[group];
        if (!g) continue;
        for (const [k, v] of Object.entries(g)) {
          if (typeof v === "number") rows.push({ metric: `${group}_${k}`, value: v });
        }
      }
      await chunkedInsert(ctx, "watch_stats", rows);
    } catch {
      // stats are optional, ignore failures
    }

    return {
      inserted,
      message: `synced ${history.length} plays, ${ratings.length} ratings, ${watchlist.length} watchlist, ${collection.length} collected`,
    };
  },
};

const csv: Connector = {
  id: "csv",
  name: "CSV / JSON import",
  description: "Import movie watches. Rows: {watched_at, title, year, runtime, genre}.",
  kind: "import",
  async import(ctx, rows) {
    const values = rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => {
        const title = String(r.title ?? "Untitled");
        const watchedAt = String(r.watched_at ?? r.date ?? new Date().toISOString());
        const genre = r.genre != null ? String(r.genre) : "";
        return {
          history_id: hashId(`${title}@${watchedAt}`),
          kind: "movie",
          watched_at: watchedAt,
          watched_day: isoDate(watchedAt),
          title,
          episode_title: "",
          season: 0,
          number: 0,
          year: r.year != null ? Number(r.year) : 0,
          runtime: Number(r.runtime ?? 0),
          genres: genre ? [genre] : [],
          trakt_id: 0,
        };
      });
    await chunkedInsert(ctx, "watch_history", values);
    return { inserted: values.length };
  },
};

const watching: LifeStackModule = {
  id: "watching",
  name: "Movies & TV",
  description:
    "Everything you watch, from Trakt: films and episodes, ratings, watchlist, collection, runtime, genres, and a watch calendar.",
  icon: "🎬",
  accent: "oklch(0.66 0.18 25)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS watch_history (
       history_id Int64,
       kind String,
       watched_at DateTime,
       watched_day Date,
       title String,
       episode_title String,
       season Int32,
       number Int32,
       year Int32,
       runtime Int32,
       genres Array(String),
       trakt_id Int32,
       source String DEFAULT 'trakt'
     ) ENGINE = ReplacingMergeTree ORDER BY history_id`,
    `CREATE TABLE IF NOT EXISTS watch_rating (
       kind String,
       trakt_id Int32,
       title String,
       year Int32,
       rating Int32,
       rated_at DateTime
     ) ENGINE = ReplacingMergeTree(rated_at) ORDER BY (kind, trakt_id)`,
    `CREATE TABLE IF NOT EXISTS watch_watchlist (
       kind String,
       trakt_id Int32,
       title String,
       year Int32,
       rank Int32,
       listed_at DateTime
     ) ENGINE = ReplacingMergeTree(listed_at) ORDER BY (kind, trakt_id)`,
    `CREATE TABLE IF NOT EXISTS watch_collection (
       kind String,
       trakt_id Int32,
       title String,
       year Int32,
       collected_at DateTime
     ) ENGINE = ReplacingMergeTree(collected_at) ORDER BY (kind, trakt_id)`,
    `CREATE TABLE IF NOT EXISTS watch_stats (
       metric String,
       value Float64,
       updated_at DateTime64(3) DEFAULT now64(3)
     ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY metric`,
  ],
  connectors: [trakt, csv],
  widgets: [
    {
      id: "films-year",
      title: "Films watched",
      subtitle: "Last 12 months",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(countIf(kind = 'movie' AND watched_day >= today() - INTERVAL 12 MONTH)) AS v
           FROM watch_history FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "films" };
      },
    },
    {
      id: "episodes-year",
      title: "Episodes watched",
      subtitle: "Last 12 months",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(countIf(kind = 'episode' AND watched_day >= today() - INTERVAL 12 MONTH)) AS v
           FROM watch_history FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "episodes" };
      },
    },
    {
      id: "hours",
      title: "Hours watched",
      subtitle: "Last 12 months",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(round(sum(runtime) / 60)) AS v
           FROM watch_history FINAL WHERE watched_day >= today() - INTERVAL 12 MONTH`,
        );
        return { value: rows[0]?.v ?? 0, unit: "h" };
      },
    },
    {
      id: "unique",
      title: "Unique titles",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(uniqExact(title)) AS v FROM watch_history FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "titles" };
      },
    },
    {
      id: "calendar",
      title: "Watch calendar",
      subtitle: "Last 180 days",
      type: "calendar",
      size: "lg",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT toString(watched_day) AS date, toInt32(count()) AS value
           FROM watch_history FINAL
           WHERE watched_day >= today() - INTERVAL 180 DAY
           GROUP BY watched_day ORDER BY watched_day`,
        );
        return { days: rows, unit: "plays" };
      },
    },
    {
      id: "genres",
      title: "Top genres",
      type: "donut",
      size: "md",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT g AS label, toInt32(count()) AS value
           FROM (SELECT genres FROM watch_history FINAL) ARRAY JOIN genres AS g
           WHERE g != '' GROUP BY g ORDER BY value DESC LIMIT 8`,
        );
        return { slices: rows, unit: "plays" };
      },
    },
    {
      id: "monthly",
      title: "Plays per month",
      type: "bar",
      size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT formatDateTime(m, '%b') AS label, toInt32(count()) AS value
           FROM (SELECT toStartOfMonth(watched_day) AS m FROM watch_history FINAL
                 WHERE watched_day >= toStartOfMonth(today()) - INTERVAL 11 MONTH)
           GROUP BY m ORDER BY m`,
        );
        return { series: rows, unit: "plays" };
      },
    },
    {
      id: "ratings",
      title: "Your ratings",
      subtitle: "Distribution, 1 to 10",
      type: "bar",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT toString(rating) AS label, toInt32(count()) AS value
           FROM watch_rating FINAL GROUP BY rating ORDER BY rating`,
        );
        return { series: rows, unit: "rated" };
      },
    },
    {
      id: "top-shows",
      title: "Most watched shows",
      type: "list",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT title AS label, toInt32(count()) AS value
           FROM watch_history FINAL WHERE kind = 'episode'
           GROUP BY title ORDER BY value DESC LIMIT 8`,
        );
        return { items: rows };
      },
    },
    {
      id: "recent",
      title: "Recently watched",
      type: "list",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT if(kind = 'episode', concat(title, '  S', toString(season), 'E', toString(number)), title) AS label,
                  formatDateTime(watched_day, '%b %d') AS sub,
                  toInt32(year) AS value
           FROM watch_history FINAL ORDER BY watched_at DESC LIMIT 8`,
        );
        return { items: rows };
      },
    },
    {
      id: "watchlist",
      title: "On your watchlist",
      type: "list",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT title AS label, kind AS sub, toInt32(year) AS value
           FROM watch_watchlist FINAL ORDER BY listed_at DESC LIMIT 10`,
        );
        return { items: rows };
      },
    },
    {
      id: "collection",
      title: "In your collection",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(count()) AS v FROM watch_collection FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "items" };
      },
    },
  ],
};

export default watching;
