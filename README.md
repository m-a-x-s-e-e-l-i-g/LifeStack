<div align="center">

# LifeStack

**Your life, in numbers. Self-hosted, modular, AI-first, and yours alone.**

LifeStack is a Docker-first personal statistics platform. Plug in modules for the things
you do (watch movies and shows, spend money, burn fuel, use energy, take scooter rides, order food),
store everything in ClickHouse, and ask a built-in assistant questions about it in plain
language. No cloud, no telemetry, no account, no mock data. Just `docker compose up`.

[Quick start](#quick-start) · [Assistant](#the-assistant) · [Modules](#modules) · [Write a module](#writing-a-module) · [Architecture](#architecture)

![License: MIT](https://img.shields.io/badge/license-MIT-amber)
![Docker](https://img.shields.io/badge/docker-compose-blue)
![Database](https://img.shields.io/badge/database-ClickHouse-yellow)
![Assistant](https://img.shields.io/badge/assistant-OpenAI--compatible-7c3aed)
![Frontend](https://img.shields.io/badge/frontend-SvelteKit-orange)

</div>

---

## Why

Your data is scattered across a dozen apps that each show you one slice and keep the rest.
LifeStack pulls those slices onto one machine you control, stores them in a column database
built for analytics, and turns them into a quiet, beautiful almanac of your own life. It is
modular by design: the **backend aggregates**, and each **module** owns its own sync,
storage, and a set of statistics tailored to its domain. A fuel module shows L/100km and
price-per-liter trends; a finance module shows cash flow and category breakdowns. Same
platform, domain-appropriate stats.

- **Local / self-hosted first.** Runs entirely on your hardware. ClickHouse holds the state.
- **AI-first.** A chat assistant sits at the front door, answers questions with SQL, and can
  ingest records from screenshots into your local database when you ask it to.
- **Modular.** Enable, disable, and configure modules at runtime. Write your own in one file.
- **Docker-first.** Three services, one command, sensible defaults.
- **No mock data.** Modules start empty and fill up only when you connect a real source.

## Quick start

```bash
git clone <your-fork-url> LifeStack
cd LifeStack
cp .env.example .env        # tweak ports/secrets if you like
docker compose up -d --build
```

Then open **http://localhost:3000**. You land on the **assistant**. It starts unconnected,
so head to **Settings** to:

1. Point the assistant at an LLM (a local Ollama, LM Studio, or a hosted provider).
2. Enable the modules you want and connect a source (for example Trakt or Tibber). For
   apps without APIs, upload screenshots in the assistant and ask it to save the entries.

Until you connect a source, modules stay empty by design.

```
frontend   →  http://localhost:3000      (SvelteKit dashboard + chat)
backend    →  http://localhost:4000      (aggregator REST API)
clickhouse →  http://localhost:8123      (analytics database, HTTP)
```

## The assistant

LifeStack is chat-first: the home page is an assistant that can answer questions about
everything you have synced.

- **Provider-agnostic.** It speaks the OpenAI `/chat/completions` protocol, so it works with
  OpenAI, a local **Ollama** (`/v1`), **LM Studio**, **vLLM**, and anything else compatible.
  Configure it in Settings or via `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY`.
- **Grounded in your data.** The model is given your table schema and tools for analysis
  (`run_sql`) plus explicit imports (`write_records`). Every query and write action is shown
  beneath the answer.
- **Safe by construction.** SQL stays read-only (`SELECT` / `WITH` only, no table functions,
  no `system.*`, forced limits, `readonly=1`). Writes are limited to local domain tables and
  deduped by row hash, so re-uploading the same screenshot does not create double entries.

Ask things like *"How many films and episodes did I watch this year?"*, *"What did I spend
the most on last month?"*, or *"Show my electricity cost by month."*

## Modules

Each module is a **domain** that owns its schema, statistics, and accent color. Data flows
in through **connectors** (pluggable sources). Ships with six modules:

| Module          | Domain              | Connectors                  | Sample statistics |
|-----------------|---------------------|-----------------------------|-------------------|
| **Movies & TV** | Everything you watch | Trakt (API)                 | Watched summary (last 30 days and all time, shows and movies with watch time), unique series and movies, plays per month, watch calendar, top genres and shows, ratings, watchlist, collection |
| **Finance**     | Bank transfers       | Assistant screenshot import | Monthly cash flow, spend by category, balance trend, top merchants |
| **Energy**      | Home electricity     | Tibber (API), assistant     | kWh per month, day vs night split, cost, usage calendar |
| **Fuel**        | Fuel consumption     | Assistant screenshot import | L/100km economy, price/L trend, cost per month, total spend |
| **Mobility**    | Scooter & rides      | Assistant screenshot import | Rides per provider, spend, distance, monthly trend |
| **Food orders** | Delivery takeout     | Assistant screenshot import | Orders this month, spend this month, average order value, provider split, spend per month, recent orders |

The **Trakt** connector performs a **full sync**: watch history (movies and episodes),
ratings (movies, shows, seasons, episodes), watchlist, collection, and your profile stats.
**Tibber** is a real, working energy connector. For providers without APIs or export files,
upload screenshots in the assistant and ask it to import them. The backend dedupes repeated
uploads automatically.

### Modules and connectors

The platform separates the **what** from the **where**:

- A **module** is a domain. It defines the database tables, the widgets (statistics), and
  an accent color. It does not care where data comes from.
- A **connector** is a data source attached to a module. It has its own config (API keys),
  its own enable switch, an optional brand icon, and usually a `sync` function for API pulls.

So the Movies & TV module can pull from Trakt today and Letterboxd tomorrow, into the same
stats.

### Feeding real data

- **API sync** (e.g. Tibber): enable the connector in Settings, add a token, and LifeStack
  syncs automatically on a schedule (and right after you connect). You can still trigger one
  manually with `POST /api/modules/<id>/connectors/<connector>/sync`. Trakt connects with a
  one-time PIN instead of a raw token, see [Connecting Trakt](#connecting-trakt).
- **Assistant screenshot import**: upload screenshots in chat and ask the assistant to save
  them. It extracts structured rows and writes deduped records to local tables.

### Connecting Trakt

Trakt authorizes with a PIN, so there is no callback server to run.

1. Open https://trakt.tv/oauth/applications and click **New Application**.
2. Give it any name. For **Redirect URI** enter `urn:ietf:wg:oauth:2.0:oob`. That OOB
   (out of band) value is what makes Trakt show you a PIN instead of redirecting to a
   website. Leave the rest blank and save.
3. Open the app and copy its **Client ID** and **Client Secret**.
4. In LifeStack **Settings**, find the Movies & TV > Trakt connector. Paste the Client ID
   and Client Secret, then click **Save credentials**.
5. Click **Authorize on Trakt**, approve access, and copy the **PIN** Trakt gives you.
6. Paste the PIN and click **Connect**. LifeStack syncs your Trakt data automatically in the
   background from then on, no manual sync needed.

The PIN is exchanged immediately for an access token (plus a refresh token); the PIN itself is
never stored. LifeStack refreshes the token automatically afterward, so connecting is a one-time
step. Prefer environment variables? Put `TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` in `.env`,
and you only need to authorize and paste the PIN.

## Architecture

```
                       ┌────────────────────────────┐
   browser  ──────────▶│  frontend (SvelteKit)      │
                       │  · assistant (chat)        │
                       │  · dashboard + charts      │
                       │  · /api/* proxy ───────────┼──┐
                       └────────────────────────────┘  │  internal docker network
                                                        ▼
                       ┌────────────────────────────────────────────┐
                       │  backend (Fastify aggregator)              │
                       │                                            │
                       │   core/                                    │
                       │    ├─ registry   enable·config·discover    │
                       │    ├─ scheduler  periodic connector sync   │
                       │    ├─ db         ClickHouse client + DDL    │
                       │    ├─ ai         chat + SQL + local writes   │
                       │    └─ routes     REST API + /api/chat       │
                       │                                            │
                       │   modules/                                 │
                       │    ├─ watching ├─ finance  ├─ fuel         │
                       │    ├─ energy   ├─ mobility └─ food         │
                       │       module: migrations · widgets         │
                       │       connectors: trakt · tibber            │
                       └───────────────────────┬────────────────────┘
                                               ▼
                                      ┌──────────────────┐
                                      │  clickhouse      │
                                      └──────────────────┘
```

- The **frontend** never talks to the backend directly from the browser. It proxies through
  its own server (`/api/[...path]`), so the only origin a browser sees is the frontend.
- The **backend** discovers modules at boot, runs their migrations, exposes their widgets,
  schedules each enabled connector's sync, and serves the assistant. State lives in
  ClickHouse.
- A **module** owns a domain (tables + widgets). Its **connectors** bring the data in.

ClickHouse has no `UPDATE`/`UPSERT` in the usual sense, so mutable state (module and
connector toggles, deduplicated entities) uses `ReplacingMergeTree` tables read with
`FINAL`, while event-like data (sync log, transactions) is plain append-only `MergeTree`.

## Writing a module

A module is one file. Drop it in `backend/src/modules/<id>/index.ts`, register it, done.
The module owns the schema and widgets; connectors bring the data in.

```ts
import type { Connector, LifeStackModule } from "../../core/types";

// A connector is usually an API source with a sync() function.
const wearableApi: Connector = {
  id: "wearable",
  name: "Wearable API",
  description: "Sync daily steps from your wearable account.",
  kind: "api",
  syncIntervalMinutes: 360,
  async sync(ctx) {
    // fetch external data, normalize, then batch insert
    const values = [{ day: "2026-06-17", steps: 10234 }];
    await ctx.db.insert("steps_day", values); // batch insert (JSONEachRow)
    return { inserted: values.length };
  },
};

const steps: LifeStackModule = {
  id: "steps",
  name: "Steps",
  description: "Daily step count.",
  icon: "🚶",
  accent: "oklch(0.74 0.14 320)",               // this module's color, used in its charts

  migrations: [
    `CREATE TABLE IF NOT EXISTS steps_day (
       day Date,
       steps Int32
     ) ENGINE = ReplacingMergeTree ORDER BY day`,
  ],

  connectors: [wearableApi],

  // Widgets are the dashboard. Each returns data for a typed chart.
  widgets: [
    {
      id: "total", title: "Steps this month", type: "metric", size: "sm", featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          "SELECT toInt32(sum(steps)) AS v FROM steps_day FINAL WHERE day >= toStartOfMonth(today())"
        );
        return { value: rows[0]?.v ?? 0, unit: "steps" };
      },
    },
    {
      id: "daily", title: "Daily steps", type: "bar", size: "lg",
      async query(ctx) {
        const rows = await ctx.db.query(
          "SELECT formatDateTime(day, '%b %d') AS label, steps AS value FROM steps_day FINAL ORDER BY day DESC LIMIT 30"
        );
        return { series: rows.reverse() };
      },
    },
  ],
};

export default steps;
```

`ctx.db` is ClickHouse-oriented: `query(sql, params?)` returns an array of rows,
`insert(table, rows)` appends a batch, and `command(sql)` runs DDL. Then add the module to
`backend/src/modules/index.ts`:

```ts
import steps from "./steps";
export const modules = [watching, finance, energy, fuel, mobility, food, steps];
```

Restart the backend. The module appears in Settings, ready to enable, and the assistant can
immediately query its tables. Widget `type`s map to bespoke chart components on the
frontend: `metric`, `bar`, `line`, `donut`, `calendar`, `list`, `table`.

## Configuration

All configuration is environment variables (see `.env.example`):

| Variable             | Default                     | Purpose |
|----------------------|-----------------------------|---------|
| `CLICKHOUSE_DB`      | `lifestack`                 | Database name |
| `CLICKHOUSE_USER`    | `lifestack`                 | Database user |
| `CLICKHOUSE_PASSWORD`| `lifestack`                 | Database password |
| `CLICKHOUSE_HTTP_PORT`| `8123`                     | ClickHouse HTTP port (host) |
| `CLICKHOUSE_URL`     | `http://clickhouse:8123`    | Internal URL the backend uses |
| `AI_BASE_URL`        | empty                       | OpenAI-compatible base URL for the assistant |
| `AI_MODEL`           | empty                       | Model name (e.g. `gpt-4o-mini`, `llama3.1`) |
| `AI_API_KEY`         | empty                       | API key (optional for local models) |
| `BACKEND_PORT`       | `4000`                      | Backend API port |
| `FRONTEND_PORT`      | `3000`                      | Frontend port |
| `BACKEND_URL`        | `http://backend:4000`       | Internal URL frontend uses |
| `ORIGIN`             | `http://localhost:3000`     | Public origin (CSRF) |
| `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` | empty | Movies & TV: Trakt app credentials (see [Connecting Trakt](#connecting-trakt)) |
| `TRAKT_ACCESS_TOKEN` | empty                       | Movies & TV: optional, a Trakt token you already minted (skips the PIN) |
| `TIBBER_TOKEN`       | empty                       | Energy: Tibber connector token |

The assistant and connector secrets can also be set at runtime in the Settings UI, which
persists them in ClickHouse (env values are the fallback default).

## Project structure

```
LifeStack/
├─ docker-compose.yml        three services, one command
├─ .env.example
├─ backend/                  Fastify aggregator + module system
│  └─ src/
│     ├─ core/               types · db · registry · scheduler · routes · ai
│     └─ modules/            watching · finance · energy · fuel · mobility · food
│                            (each module owns connectors + widgets)
├─ frontend/                 SvelteKit dashboard + assistant
│  └─ src/
│     ├─ app.css             OKLCH design tokens
│     ├─ lib/components/     bespoke SVG charts + widgets
│     └─ routes/             assistant · overview · module pages · settings · api proxy
├─ PRODUCT.md / DESIGN.md    design context & visual system
└─ README.md
```

## Local development (without Docker)

```bash
# 1. ClickHouse (just the compose one)
docker compose up -d clickhouse

# 2. Backend
cd backend && npm install
CLICKHOUSE_URL=http://localhost:8123 npm run dev      # http://localhost:4000

# 3. Frontend
cd frontend && npm install && npm run dev             # http://localhost:5173
```

Set `BACKEND_URL` in the frontend's shell to point at the local backend.

## Roadmap

- [ ] More watching connectors: Letterboxd, Plex, Jellyfin
- [ ] OAuth helper flow for more API connectors (Strava, etc.)
- [ ] Finance and mobility API connectors (GoCardless, Strava, ride apps)
- [ ] Cross-module "year in review" overview
- [ ] Module marketplace / external module loading
- [ ] Per-widget date-range controls
- [ ] Export and backup of aggregated data

## Contributing

Modules are the easiest contribution: copy an existing one, change the queries, open a PR.
Keep widgets domain-appropriate and respect the design laws in `DESIGN.md`.

## License

MIT. See [LICENSE](./LICENSE).
