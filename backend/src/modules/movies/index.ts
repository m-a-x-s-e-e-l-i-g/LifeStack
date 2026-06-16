import type { Connector, LifeStackModule, ModuleContext } from "../../core/types";
import { alreadySeeded, daysAgo, insertMany, iso, pick, randInt } from "../_demo";

const CATALOG: [string, number, number, string][] = [
  ["Dune: Part Two", 2024, 166, "Sci-Fi"],
  ["Oppenheimer", 2023, 180, "Drama"],
  ["Sicario", 2015, 121, "Thriller"],
  ["Blade Runner 2049", 2017, 164, "Sci-Fi"],
  ["Parasite", 2019, 132, "Drama"],
  ["Mad Max: Fury Road", 2015, 120, "Action"],
  ["The Grand Budapest Hotel", 2014, 99, "Comedy"],
  ["Whiplash", 2014, 106, "Drama"],
  ["Arrival", 2016, 116, "Sci-Fi"],
  ["Knives Out", 2019, 130, "Comedy"],
  ["Interstellar", 2014, 169, "Sci-Fi"],
  ["The Batman", 2022, 176, "Action"],
  ["Everything Everywhere All at Once", 2022, 139, "Sci-Fi"],
  ["Past Lives", 2023, 105, "Drama"],
  ["John Wick", 2014, 101, "Action"],
  ["Her", 2013, 126, "Drama"],
  ["Prisoners", 2013, 153, "Thriller"],
  ["The Social Network", 2010, 120, "Drama"],
  ["Drive", 2011, 100, "Thriller"],
  ["Nightcrawler", 2014, 117, "Thriller"],
];

const WATCH_COLUMNS = ["source", "source_id", "watched_at", "title", "year", "runtime", "genre"];

async function seed(ctx: ModuleContext): Promise<void> {
  if (await alreadySeeded(ctx, "movie_watch")) return;
  const rows: unknown[][] = [];
  for (let i = 0; i < 120; i++) {
    const [title, year, runtime, genre] = pick(CATALOG);
    const day = daysAgo(randInt(0, 280));
    rows.push(["demo", `demo-${i}`, iso(day), title, year, runtime, genre]);
  }
  await insertMany(ctx, "movie_watch", WATCH_COLUMNS, rows);
}

const trakt: Connector = {
  id: "trakt",
  name: "Trakt",
  description: "Sync your watched movies from Trakt. Films only.",
  kind: "api",
  syncIntervalMinutes: 720,
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
    const res = await fetch(
      "https://api.trakt.tv/sync/history/movies?extended=full&limit=100",
      {
        headers: {
          "Content-Type": "application/json",
          "trakt-api-version": "2",
          "trakt-api-key": clientId,
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!res.ok) throw new Error(`Trakt API error ${res.status}`);
    const items = (await res.json()) as Array<{
      id: number | string;
      watched_at: string;
      movie?: { title: string; year?: number; runtime?: number; genres?: string[] };
    }>;
    let inserted = 0;
    for (const it of items) {
      const movie = it.movie;
      if (!movie) continue;
      const r = await ctx.db.query(
        `INSERT INTO movie_watch (source, source_id, watched_at, title, year, runtime, genre)
         VALUES ('trakt', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (source, source_id) DO NOTHING`,
        [
          String(it.id),
          String(it.watched_at).slice(0, 10),
          movie.title,
          movie.year ?? null,
          movie.runtime ?? 0,
          movie.genres?.[0] ?? null,
        ],
      );
      inserted += r.rowCount ?? 0;
    }
    return { inserted, message: `fetched ${items.length} plays from Trakt` };
  },
};

const csv: Connector = {
  id: "csv",
  name: "CSV / JSON import",
  description: "Import watches. Rows: {watched_at, title, year, runtime, genre}.",
  kind: "import",
  async import(ctx, rows) {
    const values = rows
      .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
      .map((r) => {
        const title = String(r.title ?? "Untitled");
        const watchedAt = String(r.watched_at ?? r.date ?? iso(new Date())).slice(0, 10);
        return [
          "csv",
          String(r.id ?? `${title}@${watchedAt}`),
          watchedAt,
          title,
          r.year != null ? Number(r.year) : null,
          Number(r.runtime ?? 0),
          r.genre != null ? String(r.genre) : null,
        ];
      });
    await insertMany(ctx, "movie_watch", WATCH_COLUMNS, values);
    return { inserted: values.length };
  },
};

const movies: LifeStackModule = {
  id: "movies",
  name: "Movies",
  description: "Films you have watched, with runtime, genres, and a watch calendar.",
  icon: "🎬",
  accent: "oklch(0.66 0.18 25)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS movie_watch (
       id serial PRIMARY KEY,
       source text NOT NULL,
       source_id text NOT NULL,
       watched_at date NOT NULL,
       title text NOT NULL,
       year integer,
       runtime integer NOT NULL DEFAULT 0,
       genre text,
       UNIQUE (source, source_id)
     )`,
    `CREATE INDEX IF NOT EXISTS movie_watch_day_idx ON movie_watch (watched_at)`,
  ],
  connectors: [trakt, csv],
  seed,
  widgets: [
    {
      id: "plays-year",
      title: "Films watched",
      subtitle: "Last 12 months",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT count(*)::int AS v FROM movie_watch WHERE watched_at >= now() - interval '12 months'`,
        );
        return { value: rows[0].v, unit: "films" };
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
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT round(coalesce(sum(runtime), 0) / 60.0)::int AS v
           FROM movie_watch WHERE watched_at >= now() - interval '12 months'`,
        );
        return { value: rows[0].v, unit: "h" };
      },
    },
    {
      id: "unique",
      title: "Unique films",
      type: "metric",
      size: "sm",
      async query(ctx) {
        const { rows } = await ctx.db.query<{ v: number }>(
          `SELECT count(DISTINCT title)::int AS v FROM movie_watch`,
        );
        return { value: rows[0].v, unit: "titles" };
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
        const { rows } = await ctx.db.query(
          `SELECT to_char(watched_at, 'YYYY-MM-DD') AS date, count(*)::int AS value
           FROM movie_watch WHERE watched_at >= now() - interval '180 days'
           GROUP BY watched_at ORDER BY watched_at`,
        );
        return { days: rows, unit: "films" };
      },
    },
    {
      id: "genres",
      title: "Top genres",
      type: "donut",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT coalesce(genre, 'Unknown') AS label, count(*)::int AS value
           FROM movie_watch GROUP BY genre ORDER BY value DESC`,
        );
        return { slices: rows, unit: "films" };
      },
    },
    {
      id: "monthly",
      title: "Films per month",
      type: "bar",
      size: "lg",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT to_char(date_trunc('month', watched_at), 'Mon') AS label, count(*)::int AS value
           FROM movie_watch WHERE watched_at >= date_trunc('month', now()) - interval '11 months'
           GROUP BY date_trunc('month', watched_at) ORDER BY date_trunc('month', watched_at)`,
        );
        return { series: rows, unit: "films" };
      },
    },
    {
      id: "recent",
      title: "Recently watched",
      type: "list",
      size: "md",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          `SELECT title AS label, to_char(watched_at, 'Mon DD') AS sub, year AS value
           FROM movie_watch ORDER BY watched_at DESC, id DESC LIMIT 8`,
        );
        return { items: rows };
      },
    },
  ],
};

export default movies;
