<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import Widget from "$lib/components/Widget.svelte";
  import BarChart from "$lib/components/BarChart.svelte";
  import ObservationLeafletMap from "$lib/components/ObservationLeafletMap.svelte";
  import { action } from "$lib/api";
  import { display, relativeTime } from "$lib/format";
  import type { ObservationCountryStat, SeriesData } from "$lib/types";

  type MetricData = {
    value?: number | string;
    unit?: string;
    delta?: number;
    deltaLabel?: string;
  };
  type CalendarData = {
    days?: { date: string; value: number }[];
  };
  type DonutData = {
    slices?: { label: string; value: number }[];
  };

  let { data }: { data: PageData } = $props();

  const m = $derived(data.stats.module);
  const detail = $derived(data.detail);
  const insights = $derived(data.insights);
  const widgets = $derived(data.stats.widgets ?? []);

  const spanFor: Record<string, string> = {
    sm: "span 3",
    md: "span 6",
    lg: "span 8",
    xl: "span 12",
  };

  function metricValue(id: string): number {
    const widget = widgets.find((w) => w.id === id);
    const metric = (widget?.data ?? null) as MetricData | null;
    const raw = metric?.value;
    const n = typeof raw === "number" ? raw : Number(raw ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  const totalObservations = $derived(metricValue("total-observations"));
  const speciesObserved = $derived(metricValue("species-count"));
  const thisYearCount = $derived(metricValue("this-year"));

  const thisYearData = $derived(
    ((widgets.find((w) => w.id === "this-year")?.data ?? null) as MetricData | null) ?? null,
  );

  const calendarDays = $derived(
    ((widgets.find((w) => w.id === "calendar")?.data ?? null) as CalendarData | null)?.days ?? [],
  );

  const calendarWidget = $derived(widgets.find((w) => w.id === "calendar") ?? null);

  const monthlyStats = $derived(insights.monthly ?? []);
  const countryStats = $derived((insights.countries ?? []) as ObservationCountryStat[]);
  const topSpeciesStats = $derived(insights.topSpecies ?? []);

  const monthlyObservationSeries = $derived(
    ({
      series: monthlyStats.map((point) => ({ label: point.label, value: point.observations })),
      unit: "obs",
    }) as SeriesData,
  );

  const monthlySpeciesSeries = $derived(
    ({
      series: monthlyStats.map((point) => ({ label: point.label, value: point.species })),
      unit: "species",
    }) as SeriesData,
  );

  const classSlices = $derived(
    ((widgets.find((w) => w.id === "class-split")?.data ?? null) as DonutData | null)?.slices ?? [],
  );

  const last30Days = $derived(
    (() => {
      const cutoff = new Date();
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setDate(cutoff.getDate() - 29);

      let observations = 0;
      let activeDays = 0;
      for (const day of calendarDays) {
        const d = new Date(day.date);
        if (Number.isNaN(d.valueOf()) || d < cutoff) continue;
        const v = Number(day.value ?? 0);
        if (!Number.isFinite(v) || v <= 0) continue;
        observations += v;
        activeDays += 1;
      }
      return { observations, activeDays };
    })(),
  );

  const avgMonthly = $derived(
    (() => {
      if (!monthlyStats.length) return 0;
      const values = monthlyStats
        .map((point) => Number(point.observations ?? 0))
        .filter((v) => Number.isFinite(v));
      if (!values.length) return 0;
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      return Math.round(mean * 10) / 10;
    })(),
  );

  const currentMonth = $derived(monthlyStats[monthlyStats.length - 1]?.observations ?? 0);
  const currentMonthLabel = $derived(monthlyStats[monthlyStats.length - 1]?.label ?? "current month");

  const summary = $derived(insights.summary);
  const mapInfo = $derived(insights.map);
  const mapCoverage = $derived(
    mapInfo.totalMapped > 0 ? Math.round((mapInfo.returned / mapInfo.totalMapped) * 100) : 0,
  );

  const topCountries = $derived(countryStats.slice(0, 18));
  const topSpecies = $derived(topSpeciesStats.slice(0, 12));
  const streaks = $derived(insights.streaks);
  const busiestDay = $derived(insights.busiestDay);

  const detailWidgets = $derived(
    widgets.filter(
      (w) =>
        ![
          "total-observations",
          "species-count",
          "this-year",
          "monthly-trend",
          "calendar",
          "top-species",
        ].includes(w.id),
    ),
  );

  const topClass = $derived(classSlices[0] ?? null);
  const firstSeen = $derived(summary?.firstObserved ?? calendarDays[0]?.date ?? null);
  const lastSeen = $derived(summary?.lastObserved ?? calendarDays[calendarDays.length - 1]?.date ?? null);

  const connector = $derived(detail.connectors.find((c) => c.id === "gbif-observation-org") ?? null);

  let busy = $state(false);
  let status = $state<string | null>(null);

  async function enable() {
    busy = true;
    status = null;
    try {
      await action(`/modules/${m.id}/enable`);
      await invalidateAll();
    } catch (e) {
      status = e instanceof Error ? e.message : "Failed";
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>LifeStack — Nature observations</title></svelte:head>

<div class="page" style="--accent: {m.accent}">
  <header class="head">
    <div class="ident">
      <span class="badge">{m.icon}</span>
      <div>
        <p class="eyebrow">Module route</p>
        <h1>{m.name}</h1>
        <p class="desc">{m.description}</p>
      </div>
    </div>
    <div class="meta">
      {#if connector?.lastSync?.at}
        <span class="chip">Synced {relativeTime(connector.lastSync.at)}</span>
      {/if}
      {#if connector}
        <span class="chip" class:on={connector.enabled}>{connector.enabled ? "Connector on" : "Connector off"}</span>
      {/if}
      {#if !data.stats.enabled}
        <button class="btn btn--primary" onclick={enable} disabled={busy}>Enable module</button>
      {/if}
    </div>
  </header>

  {#if !data.stats.enabled}
    <div class="disabled panel">
      <h2>Nature observations is off</h2>
      <p>Enable this module to fetch your Observation.org records and generate statistics.</p>
      {#if status}<p class="status">{status}</p>{/if}
      <button class="btn btn--primary" onclick={enable} disabled={busy}>Enable {m.name}</button>
    </div>
  {:else}
    <section class="summary-grid">
      <article class="summary panel">
        <p class="label">Total observations</p>
        <p class="value">{display(summary?.totalObservations ?? totalObservations)}</p>
      </article>
      <article class="summary panel">
        <p class="label">Species observed</p>
        <p class="value">{display(summary?.totalSpecies ?? speciesObserved)}</p>
      </article>
      <article class="summary panel">
        <p class="label">This year</p>
        <p class="value">{display(thisYearCount)}</p>
        {#if typeof thisYearData?.delta === "number"}
          <p class="sub" class:neg={(thisYearData.delta ?? 0) < 0}>
            {(thisYearData.delta ?? 0) >= 0 ? "+" : ""}{display(thisYearData.delta ?? 0)} {thisYearData.deltaLabel ?? "vs last year"}
          </p>
        {/if}
      </article>
      <article class="summary panel">
        <p class="label">Observations per month</p>
        <p class="value">{display(avgMonthly)}</p>
        <p class="sub">12-month average</p>
      </article>
      <article class="summary panel">
        <p class="label">{currentMonthLabel}</p>
        <p class="value">{display(currentMonth)}</p>
        <p class="sub">observations in month</p>
      </article>
      <article class="summary panel">
        <p class="label">Countries observed</p>
        <p class="value">{display(summary?.countriesObserved ?? 0)}</p>
        <p class="sub">with recorded sightings</p>
      </article>
      <article class="summary panel">
        <p class="label">Mapped observations</p>
        <p class="value">{display(summary?.mappedObservations ?? mapInfo.returned)}</p>
        <p class="sub">{display(mapCoverage)}% currently shown</p>
      </article>
      <article class="summary panel">
        <p class="label">Active days</p>
        <p class="value">{display(summary?.activeDays ?? last30Days.activeDays)}</p>
        <p class="sub">with at least one observation</p>
      </article>
      <article class="summary panel">
        <p class="label">Current streak</p>
        <p class="value">{display(streaks.current)}</p>
        <p class="sub">consecutive days ending today</p>
      </article>
      <article class="summary panel">
        <p class="label">Longest streak</p>
        <p class="value">{display(streaks.longest)}</p>
        <p class="sub">days in a row (last 365d)</p>
      </article>
      <article class="summary panel">
        <p class="label">Latest streak</p>
        <p class="value">{display(streaks.latest)}</p>
        <p class="sub">days in a row ending on last observation</p>
      </article>
      <article class="summary panel">
        <p class="label">Busiest day</p>
        {#if busiestDay}
          <p class="value value--small">{busiestDay.date}</p>
          <p class="sub">{display(busiestDay.observations)} observations</p>
        {:else}
          <p class="value">-</p>
          <p class="sub">No observations yet</p>
        {/if}
      </article>
      <article class="summary panel">
        <p class="label">Top observed class</p>
        {#if topClass}
          <p class="value value--small">{topClass.label}</p>
          <p class="sub">{display(topClass.value)} observations</p>
        {:else}
          <p class="value">-</p>
        {/if}
      </article>
      <article class="summary panel">
        <p class="label">First observed</p>
        <p class="value value--small">{firstSeen ?? "-"}</p>
      </article>
      <article class="summary panel">
        <p class="label">Last observed</p>
        <p class="value value--small">{lastSeen ?? "-"}</p>
      </article>
    </section>

    <section class="calendar-block">
      <div class="section-head">
        <h2>Observation calendar</h2>
        <span class="chip">Last 365 days</span>
      </div>
      {#if calendarWidget}
        <Widget widget={calendarWidget} accent={m.accent} />
      {:else}
        <div class="panel disabled-inline">
          <p>Calendar data is not available yet.</p>
        </div>
      {/if}
    </section>

    <section class="split">
      <article class="panel">
        <div class="section-head">
          <h2>Observations per month</h2>
          <span class="chip">12 months</span>
        </div>
        <BarChart data={monthlyObservationSeries} accent={m.accent} />
      </article>
      <article class="panel">
        <div class="section-head">
          <h2>Species per month</h2>
          <span class="chip">12 months</span>
        </div>
        <BarChart data={monthlySpeciesSeries} accent={m.accent} />
      </article>
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Observation Leaflet map</h2>
        <span class="chip">{display(mapInfo.returned)} shown / {display(mapInfo.totalMapped)} mapped</span>
      </div>
      <ObservationLeafletMap points={mapInfo.points} accent={m.accent} />
      <p class="map-note">
        Points are plotted where coordinates exist in GBIF records. Marker popups show species, country, and date.
      </p>
    </section>

    <section class="split">
      <article class="panel">
        <div class="section-head">
          <h2>Observations and species by country</h2>
          <span class="chip">Top {display(topCountries.length)} countries</span>
        </div>
        {#if !topCountries.length}
          <p class="empty-line">No country stats yet.</p>
        {:else}
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Country</th>
                  <th class="right">Observations</th>
                  <th class="right">Species</th>
                </tr>
              </thead>
              <tbody>
                {#each topCountries as row (row.country)}
                  <tr>
                    <td>{row.country}</td>
                    <td class="right mono">{display(row.observations)}</td>
                    <td class="right mono">{display(row.species)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </article>

      <article class="panel">
        <div class="section-head">
          <h2>Top species</h2>
          <span class="chip">Most observed</span>
        </div>
        {#if !topSpecies.length}
          <p class="empty-line">No species stats yet.</p>
        {:else}
          <ol class="species-list">
            {#each topSpecies as item}
              <li>
                <span class="species-name">{item.species}</span>
                <span class="mono">{display(item.observations)}</span>
              </li>
            {/each}
          </ol>
        {/if}
      </article>
    </section>

    <section class="widgets">
      <div class="section-head">
        <h2>Detailed widgets</h2>
        <a class="link" href="/m/observations">Open module view</a>
      </div>

      {#if !detailWidgets.length}
        <div class="disabled panel">
          <h3>No statistics yet</h3>
          <p>Sync the connector from Settings to start filling charts.</p>
        </div>
      {:else}
        <div class="grid">
          {#each detailWidgets as w (w.id)}
            <div style="grid-column: {spanFor[w.size] ?? 'span 6'}">
              <Widget widget={w} accent={m.accent} />
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--s4);
    margin-bottom: var(--s5);
    flex-wrap: wrap;
  }
  .ident {
    display: flex;
    gap: var(--s4);
    align-items: center;
  }
  .eyebrow {
    margin: 0;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .badge {
    display: grid;
    place-items: center;
    width: 54px;
    height: 54px;
    border-radius: var(--r);
    font-size: 24px;
    background: color-mix(in oklab, var(--accent) 16%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--accent) 30%, var(--border));
  }
  h1 {
    font-size: clamp(1.7rem, 1.3rem + 1.8vw, 2.5rem);
    letter-spacing: -0.03em;
  }
  .desc {
    color: var(--text-dim);
    margin: 4px 0 0;
    max-width: 66ch;
  }

  .meta {
    display: flex;
    gap: var(--s2);
    flex-wrap: wrap;
    align-items: center;
  }
  .chip {
    font-size: 12px;
    color: var(--text-dim);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 5px 11px;
  }
  .chip.on {
    border-color: color-mix(in oklab, var(--accent) 45%, var(--border));
    color: var(--accent);
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--s3);
    margin-bottom: var(--s6);
  }
  .summary {
    padding: var(--s4);
    min-height: 122px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
  }
  .label {
    margin: 0;
    font-size: 12px;
    color: var(--text-faint);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .value {
    margin: 0;
    font-family: var(--font-display);
    font-size: clamp(1.5rem, 1.1rem + 1.3vw, 2.1rem);
    letter-spacing: -0.02em;
    color: var(--accent);
  }
  .value--small {
    font-size: clamp(1.15rem, 0.95rem + 0.7vw, 1.45rem);
    color: var(--text);
  }
  .sub {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-faint);
  }
  .sub.neg {
    color: var(--neg);
  }

  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--s3);
    margin-bottom: var(--s3);
    flex-wrap: wrap;
  }
  .section-head h2 {
    margin: 0;
    font-size: 1.2rem;
    letter-spacing: -0.02em;
  }
  .link {
    font-size: 13px;
    color: var(--text-faint);
  }
  .link:hover {
    color: var(--accent);
  }

  .split {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s4);
    margin-bottom: var(--s6);
  }
  .split .panel {
    min-width: 0;
  }

  .calendar-block {
    margin-bottom: var(--s6);
  }

  .table-wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  th {
    color: var(--text-faint);
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    text-align: left;
    border-bottom: 1px solid var(--border-strong);
    padding: 0 var(--s2) var(--s2);
  }
  td {
    border-bottom: 1px solid var(--border);
    padding: 9px var(--s2);
    color: var(--text-dim);
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  .right {
    text-align: right;
  }
  .mono {
    font-family: var(--font-mono);
  }

  .species-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 6px;
  }
  .species-list li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--s3);
    align-items: baseline;
    border-bottom: 1px solid var(--border);
    padding: 7px 0;
  }
  .species-list li:last-child {
    border-bottom: none;
  }
  .species-name {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .map-note,
  .empty-line {
    margin: var(--s3) 0 0;
    color: var(--text-faint);
    font-size: 12.5px;
  }

  .disabled-inline {
    padding: var(--s4);
  }
  .disabled-inline p {
    margin: 0;
    color: var(--text-faint);
    font-size: 13px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    grid-auto-flow: dense;
    gap: var(--s4);
  }
  .grid > div {
    min-width: 0;
  }

  .disabled {
    text-align: center;
    padding: var(--s7) var(--s5);
    max-width: 560px;
    margin: 0 auto;
  }
  .disabled h2,
  .disabled h3 {
    margin: 0 0 var(--s3);
    font-size: 1.3rem;
  }
  .disabled p {
    color: var(--text-dim);
    margin: 0 auto;
    max-width: 46ch;
  }
  .status {
    margin-top: var(--s3) !important;
    color: var(--neg) !important;
    font-family: var(--font-mono);
    font-size: 12px;
  }

  @media (max-width: 760px) {
    .split {
      grid-template-columns: 1fr;
    }
    .grid > div {
      grid-column: span 12 !important;
    }
  }
</style>
