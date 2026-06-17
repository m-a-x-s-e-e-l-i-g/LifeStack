<script lang="ts">
  import type { WidgetResult } from "$lib/types";
  import Metric from "./Metric.svelte";
  import StatPanel from "./StatPanel.svelte";
  import SplitMetric from "./SplitMetric.svelte";
  import BarChart from "./BarChart.svelte";
  import LineChart from "./LineChart.svelte";
  import DonutChart from "./DonutChart.svelte";
  import CalendarHeatmap from "./CalendarHeatmap.svelte";
  import ListWidget from "./ListWidget.svelte";
  import TableWidget from "./TableWidget.svelte";

  let { widget, accent }: { widget: WidgetResult; accent: string } = $props();

  const d = $derived(widget.data as any);

  const empty = $derived(
    (() => {
      if (widget.error || d == null) return widget.error ? false : true;
      switch (widget.type) {
        case "metric":
          return d.value === undefined || d.value === null;
        case "statpanel":
          return (
            !d.segments?.length ||
            d.segments.every((s: any) => s.rows?.every((r: any) => !r.minutes && !r.count))
          );
        case "split":
          return (
            !d.parts?.length ||
            d.parts.every((p: any) => p.value === undefined || p.value === null)
          );
        case "bar":
        case "line":
          return !d.series?.length;
        case "donut":
          return !d.slices?.length || d.slices.every((s: any) => !s.value);
        case "calendar":
          return !d.days?.length;
        case "list":
          return !d.items?.length;
        case "table":
          return !d.rows?.length;
        default:
          return true;
      }
    })(),
  );
</script>

<section class="panel widget" style="--accent: {accent}">
  <header>
    <h3>{widget.title}</h3>
    {#if widget.subtitle}<p class="subtitle">{widget.subtitle}</p>{/if}
  </header>

  <div class="body">
    {#if widget.error}
      <p class="note err">Could not load: {widget.error}</p>
    {:else if empty}
      <p class="note">No data yet. Connect a source or add records via the assistant.</p>
    {:else if widget.type === "metric"}
      <Metric data={d} {accent} />
    {:else if widget.type === "statpanel"}
      <StatPanel data={d} {accent} />
    {:else if widget.type === "split"}
      <SplitMetric data={d} {accent} />
    {:else if widget.type === "bar"}
      <BarChart data={d} {accent} />
    {:else if widget.type === "line"}
      <LineChart data={d} {accent} />
    {:else if widget.type === "donut"}
      <DonutChart data={d} {accent} />
    {:else if widget.type === "calendar"}
      <CalendarHeatmap data={d} {accent} />
    {:else if widget.type === "list"}
      <ListWidget data={d} {accent} />
    {:else if widget.type === "table"}
      <TableWidget data={d} {accent} />
    {/if}
  </div>
</section>

<style>
  .widget {
    display: flex;
    flex-direction: column;
    gap: var(--s4);
    padding: var(--s4) var(--s5) var(--s5);
  }
  header {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  h3 {
    font-size: 15px;
    font-weight: 600;
    color: var(--text);
  }
  .subtitle {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .note {
    margin: 0;
    color: var(--text-faint);
    font-size: 13px;
    padding: var(--s4) 0;
    max-width: 42ch;
  }
  .note.err {
    color: var(--neg);
  }
</style>
