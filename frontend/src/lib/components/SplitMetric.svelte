<script lang="ts">
  import type { SplitData } from "$lib/types";
  import { display } from "$lib/format";

  let { data, accent }: { data: SplitData; accent: string } = $props();
</script>

<div class="split" style="--accent: {accent}">
  {#each data.parts as part, i (part.label)}
    {#if i > 0}<span class="divider" aria-hidden="true"></span>{/if}
    <div class="part">
      <span class="label">{part.label}</span>
      <div class="value">
        <span class="num">{display(part.value, part.format)}</span>
        {#if part.unit}<span class="unit">{part.unit}</span>{/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .split {
    display: flex;
    align-items: stretch;
    gap: var(--s4);
    height: 100%;
    min-height: 96px;
  }
  .part {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--s2);
    flex: 1;
    min-width: 0;
    animation: rise 480ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .part:nth-child(3) {
    animation-delay: 70ms;
  }
  .label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .value {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .num {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: clamp(1.7rem, 1.2rem + 2vw, 2.5rem);
    line-height: 1;
    letter-spacing: -0.025em;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .unit {
    font-size: 0.85rem;
    color: var(--text-faint);
    font-weight: 500;
  }
  .divider {
    flex: none;
    width: 1px;
    align-self: stretch;
    background: var(--border);
    margin: var(--s2) 0;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
