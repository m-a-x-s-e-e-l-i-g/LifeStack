# DESIGN.md — LifeStack

> The visual system. Tokens live in `frontend/src/app.css` as CSS custom properties.
> This file is the source of truth for *why*; the CSS is the source of truth for *values*.

## Theme

Scene: a self-hoster glancing at their own life data in a dimly lit room at night, on a
laptop, relaxed. That forces a **dark** canvas, but a **warm inky** one, not the cold
slate-blue of server dashboards. Neutrals are tinted toward amber (hue ~70) at very low
chroma so the surface reads like aged paper under lamplight rather than gunmetal.

A light theme ships too (same tokens, inverted lightness) but dark is the default because
the scene forces it.

## Color strategy: full palette

LifeStack is multi-domain, so color is **information**, not decoration. The base is
restrained tinted neutrals. Each module owns one named accent role, used for its data viz,
its glyph, and the thin spine of identity on its cards. This is the legitimate
"full palette / data viz" strategy, not accent confetti.

All colors are OKLCH. No `#000`, no `#fff`. Chroma drops as lightness approaches the
extremes.

| Role            | Token              | OKLCH                  | Use |
|-----------------|--------------------|------------------------|-----|
| Canvas          | `--bg`             | `0.175 0.012 70`       | App background |
| Surface         | `--surface`        | `0.215 0.013 70`       | Panels |
| Surface raised  | `--surface-2`      | `0.255 0.015 70`       | Hover, inputs |
| Border          | `--border`         | `0.305 0.014 70`       | Hairlines |
| Text            | `--text`           | `0.945 0.008 80`       | Primary |
| Text dim        | `--text-dim`       | `0.74 0.012 80`        | Secondary |
| Text faint      | `--text-faint`     | `0.58 0.012 80`        | Labels, axes |
| Brand (amber)   | `--brand`          | `0.81 0.13 78`         | Logo, primary action |
| Trakt           | `--accent-trakt`   | `0.66 0.18 25`         | Movies/TV |
| Finance         | `--accent-finance` | `0.74 0.15 155`        | Money |
| Fuel            | `--accent-fuel`    | `0.73 0.16 55`         | Fuel |
| Energy          | `--accent-energy`  | `0.80 0.15 100`        | Energy |
| Mobility        | `--accent-mobility`| `0.68 0.15 250`        | Rides |
| Positive        | `--pos`            | `0.74 0.15 155`        | Inflow, good |
| Negative        | `--neg`            | `0.64 0.16 25`         | Outflow, alert |

## Typography

- Display / data: a grotesque with real character. We use **Space Grotesk** for headings
  and big numbers (it has a numeric personality that suits an almanac), **Inter** for body
  and UI, and a mono (**JetBrains Mono**) for raw values and axis ticks.
- Scale ratio 1.25 minimum between steps. Big numbers are big: hero stats at 2.5–3.5rem.
- Tabular numerals everywhere numbers align (`font-variant-numeric: tabular-nums`).
- Body line length capped at 70ch.

## Layout

- A 12-column fluid grid for the dashboard; widgets declare span (sm=4, md=6, lg=8/12).
- Spacing scale is non-uniform on purpose (4 / 8 / 12 / 16 / 24 / 40 / 64) to create
  rhythm. Section gaps are larger than intra-widget gaps.
- Widgets are panels, not "cards with shadows." One hairline border, generous padding,
  no nested panels. The widget header is quiet; the data is loud.
- A persistent left rail lists modules with their accent glyphs. It is narrow and calm.

## Motion

- Entrances ease-out (cubic-bezier expo/quart), 180–320ms, staggered for widget grids.
- Charts draw in (bars grow, lines sweep) once, then stay still. No idle animation.
- Never animate layout properties; transform/opacity only.

## Bans (from the impeccable shared laws, enforced here)
No side-stripe borders, no gradient text, no decorative glassmorphism, no hero-metric
template grids, no identical icon-heading-text card grids, no modal-first flows, no em
dashes in copy.
