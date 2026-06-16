<script lang="ts">
  import { onMount } from "svelte";
  import type { SeriesData } from "$lib/types";
  import { display } from "$lib/format";
  import { niceMax, ticks, linePath, labelStride } from "$lib/chart";

  let { data, accent }: { data: SeriesData; accent: string } = $props();

  let w = $state(600);
  let mounted = $state(false);
  onMount(() => requestAnimationFrame(() => (mounted = true)));

  const H = 232;
  const padL = 40,
    padR = 14,
    padT = 14,
    padB = 26;

  const series = $derived(data.series ?? []);
  const values = $derived(series.map((p) => p.value));
  const top = $derived(niceMax(Math.max(0, ...values)));
  const plotW = $derived(w - padL - padR);
  const plotH = $derived(H - padT - padB);
  const baseY = $derived(padT + plotH);
  const stride = $derived(labelStride(series.length));

  function px(i: number) {
    return series.length <= 1 ? padL + plotW / 2 : padL + (plotW * i) / (series.length - 1);
  }
  function py(v: number) {
    return baseY - (v / (top || 1)) * plotH;
  }

  const pts = $derived(series.map((p, i) => ({ x: px(i), y: py(p.value), p })));
  const line = $derived(linePath(pts));
  const area = $derived(
    pts.length ? `${line} L${pts[pts.length - 1].x.toFixed(2)} ${baseY} L${pts[0].x.toFixed(2)} ${baseY} Z` : "",
  );
</script>

<div class="wrap" bind:clientWidth={w} class:mounted style="--accent: {accent}">
  <svg width={w} height={H} viewBox="0 0 {w} {H}" role="img">
    {#each ticks(top, 4) as g}
      {@const gy = baseY - (g / (top || 1)) * plotH}
      <line class="grid" x1={padL} x2={w - padR} y1={gy} y2={gy} />
      <text class="tick" x={padL - 7} y={gy + 3.5} text-anchor="end">{display(g, data.format, true)}</text>
    {/each}

    <path class="area" d={area} />
    <path class="line" d={line} pathLength="1" />

    {#each pts as pt, i (pt.p.label + i)}
      <circle class="dot" cx={pt.x} cy={pt.y} r="3.4" style="transition-delay: {620 + i * 14}ms">
        <title>{pt.p.label}: {display(pt.p.value, data.format)}{data.unit ? " " + data.unit : ""}</title>
      </circle>
      {#if i % stride === 0}
        <text class="xlabel" x={pt.x} y={H - 8} text-anchor="middle">{pt.p.label}</text>
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
  .tick,
  .xlabel {
    fill: var(--text-faint);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .area {
    fill: var(--accent);
    opacity: 0;
    transition: opacity 700ms ease 220ms;
  }
  .mounted .area {
    opacity: 0.1;
  }
  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    transition: stroke-dashoffset 760ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .mounted .line {
    stroke-dashoffset: 0;
  }
  .dot {
    fill: var(--bg);
    stroke: var(--accent);
    stroke-width: 2.2;
    opacity: 0;
    transition: opacity 240ms ease;
  }
  .mounted .dot {
    opacity: 1;
  }
  .dot:hover {
    fill: var(--accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .area {
      opacity: 0.1;
      transition: none;
    }
    .line {
      stroke-dashoffset: 0;
      transition: none;
    }
    .dot {
      opacity: 1;
      transition: none;
    }
  }
</style>
