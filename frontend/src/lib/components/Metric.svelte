<script lang="ts">
  import type { MetricData } from "$lib/types";
  import { display } from "$lib/format";

  let { data, accent }: { data: MetricData; accent: string } = $props();

  const valueText = $derived(display(data.value, data.format));
  const hasDelta = $derived(typeof data.delta === "number" && Number.isFinite(data.delta));
  const positive = $derived((data.delta ?? 0) >= 0);
</script>

<div class="metric" style="--accent: {accent}">
  <div class="value">
    <span class="num">{valueText}</span>
    {#if data.unit}<span class="unit">{data.unit}</span>{/if}
  </div>
  {#if hasDelta}
    <div class="delta" class:neg={!positive}>
      <span class="arrow">{positive ? "▲" : "▼"}</span>
      <span>{display(Math.abs(data.delta ?? 0), data.format)}</span>
      {#if data.deltaLabel}<span class="dlabel">{data.deltaLabel}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .metric {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
    justify-content: center;
    height: 100%;
    min-height: 96px;
  }
  .value {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    animation: rise 480ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .num {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: clamp(2rem, 1.4rem + 2.6vw, 3.1rem);
    line-height: 1;
    letter-spacing: -0.025em;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .unit {
    font-size: 0.95rem;
    color: var(--text-faint);
    font-weight: 500;
  }
  .delta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--pos);
  }
  .delta.neg {
    color: var(--neg);
  }
  .arrow {
    font-size: 10px;
  }
  .dlabel {
    color: var(--text-faint);
    font-family: var(--font-body);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
