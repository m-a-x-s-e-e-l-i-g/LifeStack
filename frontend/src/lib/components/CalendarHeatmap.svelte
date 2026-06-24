<script lang="ts">
  import { onMount } from "svelte";
  import type { CalendarData } from "$lib/types";
  import { display } from "$lib/format";
  import { heatOpacity } from "$lib/colors";

  let { data, accent }: { data: CalendarData; accent: string } = $props();

  let mounted = $state(false);
  onMount(() => requestAnimationFrame(() => (mounted = true)));

  const cell = 13,
    gap = 4,
    step = cell + gap,
    padL = 30,
    padT = 18;
  const oneDay = 86400000;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dowLabels = ["Mon", "", "Wed", "", "Fri", "", ""];

  function iso(ms: number) {
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  }

  const model = $derived(
    (() => {
      const days = (data.days ?? []).filter((d) => d.date);
      if (!days.length) return { cells: [], labels: [], weeks: 0, max: 1 };
      const map = new Map(
        days.map((d) => [String(d.date).slice(0, 10), Number(d.value ?? 0)]),
      );

      // Always render a complete trailing 365-day window.
      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      const endMs = end.getTime();
      const startMs = endMs - 364 * oneDay;

      const startDow = new Date(startMs).getUTCDay();
      const alignedMs = startMs - ((startDow + 6) % 7) * oneDay;
      const totalDays = Math.round((endMs - alignedMs) / oneDay) + 1;
      const weeks = Math.ceil(totalDays / 7);
      const max = Math.max(1, ...[...map.values()].map((v) => Number(v) || 0));

      const cells = [];
      for (let i = 0; i < totalDays; i++) {
        const ms = alignedMs + i * oneDay;
        const key = iso(ms);
        const v = map.get(key) ?? 0;
        cells.push({
          x: padL + Math.floor(i / 7) * step,
          y: padT + (i % 7) * step,
          v,
          op: heatOpacity(v, max),
          wk: Math.floor(i / 7),
          key,
        });
      }

      const labels: { x: number; text: string }[] = [];
      let prev = -1;
      for (let wk = 0; wk < weeks; wk++) {
        const dt = new Date(alignedMs + wk * 7 * oneDay);
        if (dt.getUTCMonth() !== prev) {
          labels.push({ x: padL + wk * step, text: months[dt.getUTCMonth()] });
          prev = dt.getUTCMonth();
        }
      }
      return { cells, labels, weeks, max };
    })(),
  );

  const svgW = $derived(padL + model.weeks * step + 4);
  const svgH = padT + 7 * step + 4;
</script>

<div class="cal" class:mounted style="--accent: {accent}">
  <div class="scroll">
    <svg width={svgW} height={svgH} viewBox="0 0 {svgW} {svgH}" role="img">
      {#each model.labels as l}
        <text class="mlabel" x={l.x} y={12}>{l.text}</text>
      {/each}
      {#each dowLabels as d, i}
        {#if d}<text class="dlabel" x={padL - 7} y={padT + i * step + cell - 3} text-anchor="end">{d}</text>{/if}
      {/each}
      {#each model.cells as c (c.key)}
        <rect
          class="day"
          x={c.x}
          y={c.y}
          width={cell}
          height={cell}
          rx="3"
          style="--op: {c.op}; transition-delay: {c.wk * 11}ms"
        >
          <title>{c.key}: {display(c.v)}{data.unit ? " " + data.unit : ""}</title>
        </rect>
      {/each}
    </svg>
  </div>

  <div class="key">
    <span>less</span>
    {#each [0.12, 0.3, 0.5, 0.72, 0.96] as o}
      <span class="kcell" style="--op: {o}"></span>
    {/each}
    <span>more</span>
  </div>
</div>

<style>
  .cal {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  .scroll {
    overflow-x: auto;
    padding-bottom: 2px;
  }
  svg {
    display: block;
  }
  .mlabel,
  .dlabel {
    fill: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .day {
    fill: var(--accent);
    fill-opacity: 0;
    stroke: var(--border);
    stroke-width: 1;
    transition:
      fill-opacity 460ms ease,
      transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .mounted .day {
    fill-opacity: var(--op);
  }
  .day:hover {
    stroke: var(--text-dim);
  }
  .key {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--text-faint);
    align-self: flex-end;
  }
  .kcell {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    background: var(--accent);
    opacity: var(--op);
  }
  @media (prefers-reduced-motion: reduce) {
    .day {
      fill-opacity: var(--op);
      transition: none;
    }
  }
</style>
