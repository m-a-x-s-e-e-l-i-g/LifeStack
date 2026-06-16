<script lang="ts">
  import { onMount } from "svelte";
  import type { ListData } from "$lib/types";
  import { display } from "$lib/format";

  let { data, accent }: { data: ListData; accent: string } = $props();

  let mounted = $state(false);
  onMount(() => requestAnimationFrame(() => (mounted = true)));

  const items = $derived(data.items ?? []);
  const max = $derived(
    Math.max(1, ...items.map((i) => (typeof i.value === "number" ? Math.abs(i.value) : 0))),
  );
</script>

<ol class="list" class:mounted style="--accent: {accent}">
  {#each items as it, i (it.label + i)}
    {@const w = typeof it.value === "number" ? Math.max(2, (Math.abs(it.value) / max) * 100) : 0}
    <li>
      <span class="rank mono">{i + 1}</span>
      <div class="main">
        <div class="row">
          <span class="label">{it.label}</span>
          <span class="value mono">{display(it.value, data.format)}</span>
        </div>
        {#if it.sub}<span class="sub">{it.sub}</span>{/if}
        <div class="track"><span class="fill" style="--w: {w}%; transition-delay: {i * 35}ms"></span></div>
      </div>
    </li>
  {/each}
</ol>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  li {
    display: grid;
    grid-template-columns: 22px 1fr;
    gap: var(--s3);
    padding: var(--s3) 2px;
    border-bottom: 1px solid var(--border);
  }
  li:last-child {
    border-bottom: none;
  }
  .rank {
    color: var(--text-faint);
    font-size: 12px;
    padding-top: 2px;
  }
  .main {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--s3);
  }
  .label {
    color: var(--text);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value {
    color: var(--text);
    font-size: 13px;
    flex: none;
  }
  .sub {
    color: var(--text-faint);
    font-size: 12px;
  }
  .track {
    height: 3px;
    border-radius: 2px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    width: 0;
    border-radius: 2px;
    background: color-mix(in oklab, var(--accent) 70%, transparent);
    transition: width 620ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .mounted .fill {
    width: var(--w);
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      width: var(--w);
      transition: none;
    }
  }
</style>
