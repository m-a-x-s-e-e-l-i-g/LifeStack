<script lang="ts">
  import type { StatPanelData } from "$lib/types";
  import { formatDuration, formatNumber } from "$lib/format";

  let { data, accent }: { data: StatPanelData; accent: string } = $props();
</script>

<div class="sp" style="--accent: {accent}">
  {#each data.segments as seg (seg.label)}
    <div class="seg">
      <span class="seg-label">{seg.label}</span>
      <div class="rows">
        {#each seg.rows as r (r.kind)}
          <div class="row">
            <span class="kind">{r.kind}</span>
            <span class="dur">{formatDuration(r.minutes)}</span>
            {#if r.count}<span class="count">{formatNumber(r.count)} {r.countUnit}</span>{/if}
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .sp {
    display: flex;
    flex-direction: column;
    gap: var(--s4);
    height: 100%;
    justify-content: center;
  }
  .seg {
    display: flex;
    flex-direction: column;
    gap: var(--s2);
  }
  .seg-label {
    align-self: flex-start;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: color-mix(in oklab, var(--accent) 80%, var(--text));
    background: color-mix(in oklab, var(--accent) 14%, transparent);
    border-radius: 5px;
    padding: 3px 7px;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .row {
    display: flex;
    align-items: baseline;
    gap: var(--s3);
  }
  .kind {
    flex: none;
    width: 4.2rem;
    font-size: 13px;
    color: var(--text-dim);
  }
  .dur {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 1.15rem;
    letter-spacing: -0.01em;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .count {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-faint);
  }
</style>
