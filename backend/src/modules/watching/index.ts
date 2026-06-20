import type { Connector, LifeStackModule, ModuleContext } from "../../core/types";

/** Circled play mark used as the Trakt connector glyph (uses currentColor). */
const TRAKT_ICON = `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9.25"/><path d="M10.2 8.4 16 12l-5.8 3.6V8.4Z" fill="currentColor" stroke="none"/></svg>`;

const TRAKT = "https://api.trakt.tv";

/**
 * Out-of-band redirect URI for Trakt apps without a web callback. With this
 * value set on the app, Trakt shows the user a PIN to paste back here.
 */
const TRAKT_REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

/**
 * Trakt sits behind Cloudflare, which returns 403 to requests that lack a real
 * User-Agent. Always send one, on both the API and OAuth token endpoints.
 */
const TRAKT_UA = "LifeStack/1.0 (+https://github.com/m-a-x-s-e-e-l-i-g/LifeStack)";

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
    "User-Agent": TRAKT_UA,
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

interface TraktToken {
  access_token: string;
  refresh_token?: string;
}

/** POST the OAuth token endpoint with a grant body and parse the token pair. */
async function traktToken(
  body: Record<string, string>,
  failure: string,
): Promise<TraktToken> {
  const res = await fetch(`${TRAKT}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": TRAKT_UA },
    body: JSON.stringify({ ...body, redirect_uri: TRAKT_REDIRECT }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { error?: string; error_description?: string };
      detail = data.error_description || data.error || "";
    } catch {
      // non-JSON error body (e.g. an HTML gateway page); status alone will do
    }
    throw new Error(`${failure}${detail ? `: ${detail}` : ""} (HTTP ${res.status}).`);
  }
  const tok = (await res.json()) as TraktToken;
  if (!tok.access_token) throw new Error(`${failure}: no access token returned.`);
  return tok;
}

/** Exchange a single-use PIN (authorization code) for an access + refresh token. */
function traktExchangePin(
  clientId: string,
  clientSecret: string,
  pin: string,
): Promise<TraktToken> {
  return traktToken(
    {
      code: pin,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
    },
    "Trakt rejected the PIN. PINs are single use: open the authorize link again, copy a fresh code, paste it, and save",
  );
}

/** Trade a refresh token for a fresh access token once the old one expires. */
function traktRefresh(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TraktToken> {
  return traktToken(
    {
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    },
    "Trakt could not refresh the session. Paste a fresh PIN to reconnect",
  );
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
    {
      key: "clientId",
      label: "Client ID",
      type: "text",
      env: "TRAKT_CLIENT_ID",
      help: "From your Trakt app at https://trakt.tv/oauth/applications. Set the app's Redirect URI to urn:ietf:wg:oauth:2.0:oob.",
    },
    {
      key: "clientSecret",
      label: "Client secret",
      type: "password",
      secret: true,
      optional: true,
      env: "TRAKT_CLIENT_SECRET",
      help: "From the same Trakt app. Used once to exchange your PIN for a token.",
    },
    {
      key: "accessToken",
      label: "Access token",
      type: "password",
      secret: true,
      env: "TRAKT_ACCESS_TOKEN",
      help: "Set automatically once you connect. Provide one manually only if you already minted a token yourself.",
    },
  ],
  // Exchange a one-time PIN for tokens (or clear them). Kept separate from sync so
  // connecting is an explicit, fast step with its own success and error feedback.
  async authorize(ctx, input) {
    const clientId = String(ctx.config.clientId ?? "").trim();
    const clientSecret = String(ctx.config.clientSecret ?? "").trim();

    if (input.disconnect) {
      await ctx.saveConfig({ accessToken: "", refreshToken: "" });
      return { message: "Disconnected from Trakt." };
    }

    const pin = String(input.pin ?? "").trim();
    if (!clientId || !clientSecret)
      throw new Error("Add your Trakt Client ID and Client Secret, then save, before connecting.");
    if (!pin) throw new Error("Paste the PIN Trakt gave you to connect.");

    const tok = await traktExchangePin(clientId, clientSecret, pin);
    await ctx.saveConfig({
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? "",
    });
    return { message: "Connected to Trakt." };
  },
  async sync(ctx) {
    const clientId = String(ctx.config.clientId ?? "").trim();
    const clientSecret = String(ctx.config.clientSecret ?? "").trim();
    let token = String(ctx.config.accessToken ?? "").trim();
    let refreshToken = String(ctx.config.refreshToken ?? "").trim();

    if (!clientId)
      throw new Error(
        "Add your Trakt Client ID. Create an app at https://trakt.tv/oauth/applications with redirect URI urn:ietf:wg:oauth:2.0:oob.",
      );
    if (!token)
      throw new Error("Connect Trakt first: add your app credentials, authorize, and paste the PIN.");

    let headers = traktHeaders(clientId, token);

    // Probe the session; if the stored token expired, refresh it once.
    const probe = await fetch(`${TRAKT}/users/settings`, { headers });
    if (probe.status === 401) {
      if (!refreshToken || !clientSecret)
        throw new Error("Trakt session expired. Reconnect with a fresh PIN.");
      const tok = await traktRefresh(clientId, clientSecret, refreshToken);
      token = tok.access_token;
      refreshToken = tok.refresh_token ?? refreshToken;
      await ctx.saveConfig({ accessToken: token, refreshToken });
      headers = traktHeaders(clientId, token);
    }

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
  connectors: [trakt],
  widgets: [
    {
      id: "watched-summary",
      title: "Watched",
      type: "statpanel",
      size: "md",
      featured: true,
      async query(ctx) {
        const stats = await ctx.db.query<{ metric: string; value: number }>(
          `SELECT metric, value FROM watch_stats FINAL
           WHERE metric IN ('movies_minutes','movies_watched','episodes_minutes','episodes_watched')`,
        );
        const sv = (k: string) => Number(stats.find((r) => r.metric === k)?.value ?? 0);

        const allTime = await ctx.db.query<{ kind: string; minutes: number; plays: number }>(
          `SELECT kind, toInt64(sum(runtime)) AS minutes, toInt64(count()) AS plays
           FROM watch_history FINAL GROUP BY kind`,
        );
        const recent = await ctx.db.query<{ kind: string; minutes: number; plays: number }>(
          `SELECT kind, toInt64(sum(runtime)) AS minutes, toInt64(count()) AS plays
           FROM watch_history FINAL WHERE watched_day >= today() - INTERVAL 30 DAY GROUP BY kind`,
        );
        const pick = (
          rows: { kind: string; minutes: number; plays: number }[],
          kind: string,
        ) => rows.find((r) => r.kind === kind) ?? { minutes: 0, plays: 0 };

        // Prefer Trakt's profile totals for all-time; fall back to local history.
        const allEpMin = sv("episodes_minutes") || Number(pick(allTime, "episode").minutes);
        const allEpCnt = sv("episodes_watched") || Number(pick(allTime, "episode").plays);
        const allMvMin = sv("movies_minutes") || Number(pick(allTime, "movie").minutes);
        const allMvCnt = sv("movies_watched") || Number(pick(allTime, "movie").plays);
        const recEp = pick(recent, "episode");
        const recMv = pick(recent, "movie");

        return {
          segments: [
            {
              label: "Last 30 days",
              rows: [
                { kind: "Shows", minutes: Number(recEp.minutes), count: Number(recEp.plays), countUnit: "eps" },
                { kind: "Movies", minutes: Number(recMv.minutes), count: Number(recMv.plays), countUnit: "movies" },
              ],
            },
            {
              label: "All time",
              rows: [
                { kind: "Shows", minutes: allEpMin, count: allEpCnt, countUnit: "eps" },
                { kind: "Movies", minutes: allMvMin, count: allMvCnt, countUnit: "movies" },
              ],
            },
          ],
        };
      },
    },
    {
      id: "unique",
      title: "Unique titles",
      subtitle: "All time",
      type: "split",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query<{ series: number; movies: number }>(
          `SELECT
             toInt32(uniqExactIf(title, kind = 'episode')) AS series,
             toInt32(uniqExactIf(title, kind = 'movie')) AS movies
           FROM watch_history FINAL`,
        );
        const r = rows[0] ?? { series: 0, movies: 0 };
        return {
          parts: [
            { label: "Series", value: r.series, unit: "series" },
            { label: "Movies", value: r.movies, unit: "movies" },
          ],
        };
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
      subtitle: "This year",
      type: "bar",
      size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT formatDateTime(months.mm, '%b') AS label, toInt32(ifNull(plays.c, 0)) AS value
           FROM (
             SELECT addMonths(toStartOfYear(today()), number) AS mm
             FROM numbers(toMonth(today()))
           ) AS months
           LEFT JOIN (
             SELECT toStartOfMonth(watched_day) AS m, count() AS c
             FROM watch_history FINAL
             WHERE watched_day >= toStartOfYear(today())
             GROUP BY m
           ) AS plays ON months.mm = plays.m
           ORDER BY months.mm`,
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
      id: "watchlist-count",
      title: "Watchlist total",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(count()) AS v FROM watch_watchlist FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "items" };
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
