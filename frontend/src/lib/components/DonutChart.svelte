<script lang="ts">
  import { onMount } from "svelte";
  import type { DonutData } from "$lib/types";
  import { display } from "$lib/format";
  import { seriesColors } from "$lib/colors";

  let { data, accent }: { data: DonutData; accent: string } = $props();

  let mounted = $state(false);
  onMount(() => requestAnimationFrame(() => (mounted = true)));

  const slices = $derived((data.slices ?? []).filter((s) => s.value > 0));
  const total = $derived(slices.reduce((a, s) => a + s.value, 0));
  const colors = $derived(seriesColors(accent, slices.length));

  const R = 70;
  const C = 2 * Math.PI * R;

  const arcs = $derived(
    (() => {
      let cum = 0;
      return slices.map((s, i) => {
        const len = total > 0 ? (s.value / total) * C : 0;
        const offset = -cum;
        cum += len;
        return { s, i, len, rest: C - len, offset, pct: total > 0 ? s.value / total : 0 };
      });
    })(),
  );
</script>

<div class="donut" class:mounted style="--accent: {accent}">
  <svg viewBox="0 0 180 180" width="180" height="180" role="img">
    <circle class="track" cx="90" cy="90" r={R} />
    <g transform="rotate(-90 90 90)">
      {#each arcs as a (a.s.label + a.i)}
        <circle
          class="slice"
          cx="90"
          cy="90"
          r={R}
          stroke={colors[a.i]}
          stroke-dashoffset={a.offset}
          style="--len: {a.len}; --rest: {a.rest}; --c: {C}; transition-delay: {a.i * 70}ms"
        >
          <title>{a.s.label}: {display(a.s.value, data.format)} ({Math.round(a.pct * 100)}%)</title>
        </circle>
      {/each}
    </g>
    <text class="total" x="90" y="86" text-anchor="middle">{display(total, data.format, true)}</text>
    <text class="totlabel" x="90" y="104" text-anchor="middle">{data.unit ?? "total"}</text>
  </svg>

  <ul class="legend">
    {#each arcs as a (a.s.label + a.i)}
      <li>
        <span class="swatch" style="background: {colors[a.i]}"></span>
        <span class="lab">{a.s.label}</span>
        <span class="val mono">{display(a.s.value, data.format)}</span>
        <span class="pct mono">{Math.round(a.pct * 100)}%</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .donut {
    display: flex;
    align-items: center;
    gap: var(--s5);
    flex-wrap: wrap;
  }
  svg {
    flex: none;
  }
  .track {
    fill: none;
    stroke: var(--surface-2);
    stroke-width: 22;
  }
  .slice {
    fill: none;
    stroke-width: 22;
    stroke-dasharray: 0 var(--c);
    transition: stroke-dasharray 720ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .slice:hover {
    stroke-width: 25;
  }
  .mounted .slice {
    stroke-dasharray: var(--len) var(--rest);
  }
  .total {
    fill: var(--text);
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 24px;
  }
  .totlabel {
    fill: var(--text-faint);
    font-size: 11px;
    letter-spacing: 0.04em;
  }
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
    flex: 1;
    min-width: 160px;
  }
  .legend li {
    display: grid;
    grid-template-columns: 12px 1fr auto auto;
    align-items: center;
    gap: var(--s3);
    font-size: 13.5px;
  }
  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  .lab {
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .val {
    color: var(--text);
    font-size: 12.5px;
  }
  .pct {
    color: var(--text-faint);
    font-size: 12px;
    width: 38px;
    text-align: right;
  }
  @media (prefers-reduced-motion: reduce) {
    .slice {
      stroke-dasharray: var(--len) var(--rest);
      transition: none;
    }
  }
</style>
