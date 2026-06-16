<div align="center">

# LifeStack

**Your life, in numbers. Self-hosted, modular, and yours alone.**

LifeStack is a Docker-first personal statistics platform. Plug in modules for the things
you do (watch movies, spend money, burn fuel, use energy, take scooter rides) and get a
dashboard of statistics that actually fit each domain. No cloud, no telemetry, no account.
Just `docker compose up`.

[Quick start](#quick-start) · [Modules](#modules) · [Write a module](#writing-a-module) · [Architecture](#architecture)

![License: MIT](https://img.shields.io/badge/license-MIT-amber)
![Docker](https://img.shields.io/badge/docker-compose-blue)
![Backend](https://img.shields.io/badge/backend-Node%20%2B%20Fastify-green)
![Frontend](https://img.shields.io/badge/frontend-SvelteKit-orange)

</div>

---

## Why

Your data is scattered across a dozen apps that each show you one slice and keep the rest.
LifeStack pulls those slices onto one machine you control and turns them into a quiet,
beautiful almanac of your own life. It is modular by design: the **backend aggregates**,
and each **module** owns its own sync, storage, and a set of statistics tailored to its
domain. A fuel module shows L/100km and price-per-liter trends; a finance module shows
cash flow and category breakdowns. Same platform, domain-appropriate stats.

- **Local / self-hosted first.** Runs entirely on your hardware. Postgres is the only state.
- **Modular.** Enable, disable, and configure modules at runtime. Write your own in one file.
- **Docker-first.** Three services, one command, sensible defaults.
- **Demo data included.** First boot is a populated dashboard, not an empty shell.

## Quick start

```bash
git clone <your-fork-url> LifeStack
cd LifeStack
cp .env.example .env        # tweak ports/secrets if you like
docker compose up -d --build
```

Then open **http://localhost:3000**.

By default `SEED_DEMO=true`, so you land on a fully populated dashboard with five demo
modules. Head to **Settings** to enable/disable modules, drop in API tokens, or trigger a
sync. Set `SEED_DEMO=false` in `.env` for a clean, empty install.

```
frontend  →  http://localhost:3000      (SvelteKit dashboard)
backend   →  http://localhost:4000      (aggregator REST API)
postgres  →  localhost:5432             (state)
```

## Modules

Each module is a **domain** that owns its schema, statistics, and accent color. Data flows
in through **connectors** (pluggable sources). Ships with five modules:

| Module      | Domain            | Connectors                       | Sample statistics |
|-------------|-------------------|----------------------------------|-------------------|
| **Movies**  | Films watched     | Trakt (API), CSV import          | Films watched, hours, watch calendar, top genres, monthly history |
| **Finance** | Bank transfers    | CSV / JSON import                | Monthly cash flow, spend by category, balance trend, top categories |
| **Energy**  | Home electricity  | Tibber (API), CSV import         | kWh per month, day vs night split, cost, usage calendar |
| **Fuel**    | Fuel consumption  | CSV / JSON import                | L/100km economy, price/L trend, cost per month, distance |
| **Mobility**| Scooter & rides   | CSV / JSON import                | Rides per provider, spend, distance, monthly trend |

**Trakt** and **Tibber** are real, working API connectors. The roadmap adds more
(Letterboxd and Plex for movies, GoCardless for finance, Strava, and others). Every module
runs in **demo mode** out of the box (synthetic but realistic data) so you can see the
dashboard before wiring up real sources.

### Modules and connectors

The platform separates the **what** from the **where**:

- A **module** is a domain. It defines the database tables, the widgets (statistics), and
  an accent color. It does not care where data comes from.
- A **connector** is a data source attached to a module. It has its own config (API keys),
  its own enable switch, and either a `sync` (for APIs) or an `import` (for CSV / JSON).

So the Movies module can pull from Trakt today and Letterboxd tomorrow, into the same
stats. Everything is API-first; CSV / manual import is always available as a fallback.

### Feeding real data

- **API sync** (e.g. Trakt, Tibber): enable the connector in Settings, add a token, then
  sync on a schedule or on demand from the UI, or
  `POST /api/modules/<id>/connectors/<connector>/sync`.
- **CSV / JSON import**: `POST /api/modules/<id>/connectors/csv/import` with
  `{ "rows": [ ... ] }`. Each module documents its row shape in the connector description.

## Architecture

```
                       ┌────────────────────────────┐
   browser  ──────────▶│  frontend (SvelteKit)      │
                       │  · dashboard + charts      │
                       │  · /api/* proxy ───────────┼──┐
                       └────────────────────────────┘  │  internal docker network
                                                        ▼
                       ┌────────────────────────────────────────────┐
                       │  backend (Fastify aggregator)              │
                       │                                            │
                       │   core/                                    │
                       │    ├─ registry   enable·config·discover    │
                       │    ├─ scheduler  periodic module sync      │
                       │    ├─ db         pool + migration runner   │
                       │    └─ routes     REST API                  │
                       │                                            │
                       │   modules/                                 │
                       │    ├─ movies  ├─ finance  ├─ fuel          │
                       │    ├─ energy  └─ mobility                  │
                       │       module: migrations · widgets         │
                       │       connectors: trakt · tibber · csv     │
                       └───────────────────────┬────────────────────┘
                                               ▼
                                      ┌──────────────────┐
                                      │  postgres        │
                                      └──────────────────┘
```

- The **frontend** never talks to the backend directly from the browser. It proxies through
  its own server (`/api/[...path]`), so the only origin a browser sees is the frontend.
- The **backend** discovers modules at boot, runs their migrations, exposes their widgets,
  and schedules each enabled connector's sync. Module/connector state lives in Postgres.
- A **module** owns a domain (tables + widgets). Its **connectors** bring the data in.

## Writing a module

A module is one file. Drop it in `backend/src/modules/<id>/index.ts`, register it, done.
The module owns the schema and widgets; connectors bring the data in.

```ts
import type { Connector, LifeStackModule } from "../../core/types";

// A connector is a data source. APIs implement `sync`; imports implement `import`.
const phoneExport: Connector = {
  id: "csv",
  name: "CSV import",
  description: "Import a step export. Rows: {day, steps}.",
  kind: "import",
  async import(ctx, rows) {
    // map rows -> INSERT; return how many landed
    return { inserted: rows.length };
  },
};

const steps: LifeStackModule = {
  id: "steps",
  name: "Steps",
  description: "Daily step count.",
  icon: "🚶",
  accent: "oklch(0.74 0.14 320)",            // this module's color, used in its charts

  migrations: [
    `CREATE TABLE IF NOT EXISTS steps_day (
       day date PRIMARY KEY,
       steps integer NOT NULL
     )`,
  ],

  connectors: [phoneExport],                 // add an `api` connector with sync() later

  async seed(ctx) { /* insert realistic sample rows for demo mode */ },

  // Widgets are the dashboard. Each returns data for a typed chart.
  widgets: [
    {
      id: "total", title: "Steps this month", type: "metric", size: "sm",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          "SELECT coalesce(sum(steps),0)::int AS v FROM steps_day WHERE day >= date_trunc('month', now())"
        );
        return { value: rows[0].v, unit: "steps" };
      },
    },
    {
      id: "daily", title: "Daily steps", type: "bar", size: "lg",
      async query(ctx) {
        const { rows } = await ctx.db.query(
          "SELECT to_char(day,'Mon DD') AS label, steps AS value FROM steps_day ORDER BY day DESC LIMIT 30"
        );
        return { series: rows.reverse() };
      },
    },
  ],
};

export default steps;
```

Then add it to `backend/src/modules/index.ts`:

```ts
import steps from "./steps";
export const modules = [movies, finance, energy, fuel, mobility, steps];
```

Restart the backend. The module appears in Settings, ready to enable. Widget `type`s map to
bespoke chart components on the frontend: `metric`, `bar`, `line`, `donut`, `calendar`,
`list`, `table`.

## Configuration

All configuration is environment variables (see `.env.example`):

| Variable          | Default                          | Purpose |
|-------------------|----------------------------------|---------|
| `SEED_DEMO`       | `true`                           | Seed demo data on first boot |
| `DATABASE_URL`    | `postgres://lifestack:...`       | Postgres connection |
| `BACKEND_PORT`    | `4000`                           | Backend API port |
| `FRONTEND_PORT`   | `3000`                           | Frontend port |
| `BACKEND_URL`     | `http://backend:4000`            | Internal URL frontend uses |
| `ORIGIN`          | `http://localhost:3000`          | Public origin (CSRF) |
| `TRAKT_*`         | empty                            | Movies module: Trakt connector credentials |
| `TIBBER_TOKEN`    | empty                            | Energy module: Tibber connector token |

Connector secrets can also be set at runtime in the Settings UI, which persists them in
Postgres (env values are the fallback default).

## Project structure

```
LifeStack/
├─ docker-compose.yml        three services, one command
├─ .env.example
├─ backend/                  Fastify aggregator + module system
│  └─ src/
│     ├─ core/               types · db · registry · scheduler · routes · seed
│     └─ modules/            movies · finance · energy · fuel · mobility
│                            (each module owns connectors + widgets)
├─ frontend/                 SvelteKit dashboard
│  └─ src/
│     ├─ app.css             OKLCH design tokens
│     ├─ lib/components/     bespoke SVG charts + widgets
│     └─ routes/             overview · module pages · settings · api proxy
├─ PRODUCT.md / DESIGN.md    design context & visual system
└─ README.md
```

## Local development (without Docker)

```bash
# 1. Postgres (any local instance, or just the compose one)
docker compose up -d postgres

# 2. Backend
cd backend && npm install && npm run dev      # http://localhost:4000

# 3. Frontend
cd frontend && npm install && npm run dev     # http://localhost:5173
```

Set `DATABASE_URL` and `BACKEND_URL` in your shell to point at the local services.

## Roadmap

- [ ] OAuth helper flow for API modules (Trakt, Strava, etc.)
- [ ] Cross-module "year in review" overview
- [ ] Module marketplace / external module loading
- [ ] Per-widget date-range controls
- [ ] Export and backup of aggregated data

## Contributing

Modules are the easiest contribution: copy an existing one, change the queries, open a PR.
Keep widgets domain-appropriate and respect the design laws in `DESIGN.md`.

## License

MIT. See [LICENSE](./LICENSE).
