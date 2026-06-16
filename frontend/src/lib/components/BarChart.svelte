<script lang="ts">
  import { onMount } from "svelte";
  import type { SeriesData } from "$lib/types";
  import { display } from "$lib/format";
  import { niceMax, ticks, labelStride } from "$lib/chart";

  let { data, accent }: { data: SeriesData; accent: string } = $props();

  let w = $state(600);
  let mounted = $state(false);
  onMount(() => {
    requestAnimationFrame(() => (mounted = true));
  });

  const H = 232;
  const padL = 40,
    padR = 12,
    padT = 14,
    padB = 26;

  const series = $derived(data.series ?? []);
  const values = $derived(series.map((p) => p.value));
  const top = $derived(niceMax(Math.max(0, ...values)));
  const bot = $derived(niceMax(Math.max(0, ...values.map((v) => -v))));
  const signed = $derived(!!data.signed && bot > 0);

  const plotW = $derived(w - padL - padR);
  const plotH = $derived(H - padT - padB);
  const total = $derived(signed ? top + bot : top);
  const unit = $derived(plotH / (total || 1));
  const zeroY = $derived(padT + (signed ? top : top) * unit);

  const band = $derived(plotW / Math.max(1, series.length));
  const barW = $derived(Math.min(46, band * 0.62));
  const stride = $derived(labelStride(series.length));

  const gridVals = $derived(signed ? [top, 0, -bot] : ticks(top, 4));

  function x(i: number) {
    return padL + band * i + (band - barW) / 2;
  }
</script>

<div class="wrap" bind:clientWidth={w} class:mounted style="--accent: {accent}">
  <svg width={w} height={H} viewBox="0 0 {w} {H}" role="img">
    {#each gridVals as g}
      {@const gy = zeroY - g * unit}
      <line class="grid" class:zero={g === 0} x1={padL} x2={w - padR} y1={gy} y2={gy} />
      <text class="tick" x={padL - 7} y={gy + 3.5} text-anchor="end">{display(g, data.format, true)}</text>
    {/each}

    {#each series as p, i (p.label + i)}
      {@const h = Math.abs(p.value) * unit}
      {@const y = p.value >= 0 ? zeroY - h : zeroY}
      <rect
        class="bar {p.value >= 0 ? 'pos' : 'neg'}"
        class:signed
        x={x(i)}
        y={y}
        width={barW}
        height={Math.max(0.5, h)}
        rx="3"
        style="transition-delay: {i * 22}ms"
      >
        <title>{p.label}: {display(p.value, data.format)}{data.unit ? " " + data.unit : ""}</title>
      </rect>
      {#if i % stride === 0}
        <text class="xlabel" x={x(i) + barW / 2} y={H - 8} text-anchor="middle">{p.label}</text>
      {/if}
    {/each}
  </svg>
</div>

<style>
  .wrap {
    width: 100%;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .grid {
    stroke: var(--border);
    stroke-width: 1;
  }
  .grid.zero {
    stroke: var(--border-strong);
  }
  .tick,
  .xlabel {
    fill: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .bar {
    fill: var(--accent);
    transform: scaleY(0);
    transform-box: fill-box;
    transition: transform 640ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .bar.pos {
    transform-origin: bottom;
  }
  .bar.neg {
    transform-origin: top;
  }
  .bar.signed.pos {
    fill: var(--pos);
  }
  .bar.signed.neg {
    fill: var(--neg);
  }
  .bar:hover {
    fill: color-mix(in oklab, var(--accent) 80%, white);
  }
  .mounted .bar {
    transform: scaleY(1);
  }
  @media (prefers-reduced-motion: reduce) {
    .bar {
      transform: scaleY(1);
      transition: none;
    }
  }
</style>
