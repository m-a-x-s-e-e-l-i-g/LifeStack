# PRODUCT.md — LifeStack

> Design context for the project. Read before any UI work.

## Register
product

## Product purpose
LifeStack is a self-hosted, Docker-first "personal data warehouse" that turns the
exhaust of everyday life into statistics worth looking at. It is modular: each domain
(movies and TV, money, fuel, energy, mobility) is a pluggable module that owns its own
sync, storage, and dashboard. The backend aggregates into ClickHouse; the frontend
visualizes. A built-in assistant sits at the front door and answers questions about your
data by writing read-only SQL against it.

It is not a SaaS, not a quantified-self guilt machine, and not a budgeting nag. It is a
private almanac you run on your own box and browse because the numbers are genuinely
interesting.

## Users
One primary persona: the **self-hoster**. Technically capable, owns a homelab or a small
VPS, already runs a handful of containers, and resents handing personal data to cloud
analytics. They value: data ownership, a clean `docker compose up`, extensibility, and
charts that respect their intelligence. They browse in the evening, at home, on a laptop,
relaxed and exploratory, not under deadline.

Secondary: the **tinkerer** who wants to write their own module for a niche data source.

## Tone
Calm, precise, a little bit almanac. Confident numbers, quiet chrome. The data is the
star; the interface is the matte frame around it. Never playful-to-the-point-of-noise,
never enterprise-sterile.

## Anti-references
- Generic admin-template dashboards (sidebar + KPI cards + Chart.js defaults).
- Cold slate-blue "observability" dark mode. We are warm, not a server rack.
- Budgeting apps that moralize spending with red warnings.
- Gradient-soaked crypto dashboards.
- Anything that screams "AI generated this in one shot."

## Strategic principles
1. **Modules are first-class.** Every screen should make the modular nature legible. A
   module owns an accent color, an icon, and a set of widgets that fit *its* domain. A
   fuel module shows L/100km; it does not get a generic "records" table.
2. **Empty is a state, not a failure.** There is no mock data. A fresh install with a
   module enabled but no data should still feel intentional, with a clear path to import
   or sync.
3. **Self-host ergonomics win ties.** One command up, sensible defaults, nothing seeded.
   The user controls when real data arrives, and the assistant works against whatever
   they bring.
4. **Numbers first, chrome second.** Spend the contrast budget on data, not navigation.
5. **The assistant is the front door.** Chat is the home surface. It must feel like a
   native part of the almanac, not a bolted-on chatbot: quiet, grounded in real queries,
   and always honest about what it ran. It never invents numbers.
