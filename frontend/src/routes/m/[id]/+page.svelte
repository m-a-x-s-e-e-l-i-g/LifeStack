<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import Widget from "$lib/components/Widget.svelte";
  import { action } from "$lib/api";
  import { relativeTime } from "$lib/format";

  let { data }: { data: PageData } = $props();

  const m = $derived(data.stats.module);
  const detail = $derived(data.detail);
  const widgets = $derived(data.stats.widgets ?? []);

  let busy = $state(false);
  let status = $state<string | null>(null);

  const spanFor: Record<string, string> = {
    sm: "span 3",
    md: "span 6",
    lg: "span 8",
    xl: "span 12",
  };

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

<svelte:head><title>LifeStack — {m.name}</title></svelte:head>

<div class="page" style="--accent: {m.accent}">
  <header class="head">
    <div class="ident">
      <span class="badge">{m.icon}</span>
      <div>
        <h1>{m.name}</h1>
        <p class="desc">{m.description}</p>
      </div>
    </div>
    <div class="actions">
      {#if !data.stats.enabled}
        <button class="btn btn--primary" onclick={enable} disabled={busy}>Enable module</button>
      {:else if status}
        <span class="status">{status}</span>
      {/if}
    </div>
  </header>

  {#if detail.connectors.length}
    <div class="connectors">
      {#each detail.connectors as c (c.id)}
        <a class="conn" class:on={c.enabled} href="/settings">
          {#if c.icon}<span class="cicon">{@html c.icon}</span>{:else}<span class="cdot"></span>{/if}
          {c.name}
          <span class="kind">{c.kind}</span>
          {#if c.lastSync?.at}<span class="cwhen">{relativeTime(c.lastSync.at)}</span>{/if}
        </a>
      {/each}
    </div>
  {/if}

  {#if !data.stats.enabled}
    <div class="disabled panel">
      <h2>This module is off</h2>
      <p>Enable it, then connect a source or add records via the assistant to populate its stats.</p>
      <button class="btn btn--primary" onclick={enable} disabled={busy}>Enable {m.name}</button>
    </div>
  {:else if !widgets.length}
    <div class="disabled panel">
      <h2>No widgets</h2>
      <p>This module has no stats defined yet.</p>
    </div>
  {:else}
    <div class="grid">
      {#each widgets as w (w.id)}
        <div style="grid-column: {spanFor[w.size] ?? 'span 6'}">
          <Widget widget={w} accent={m.accent} />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--s4);
    flex-wrap: wrap;
    margin-bottom: var(--s4);
  }
  .ident {
    display: flex;
    gap: var(--s4);
    align-items: center;
  }
  .badge {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: var(--r);
    font-size: 24px;
    background: color-mix(in oklab, var(--accent) 16%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--accent) 30%, var(--border));
  }
  h1 {
    font-size: clamp(1.7rem, 1.3rem + 1.8vw, 2.4rem);
    letter-spacing: -0.03em;
  }
  .desc {
    color: var(--text-dim);
    margin: 3px 0 0;
    max-width: 60ch;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  .status {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text-faint);
  }

  .connectors {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    margin-bottom: var(--s6);
  }
  .conn {
    display: inline-flex;
    align-items: center;
    gap: var(--s2);
    font-size: 12.5px;
    color: var(--text-dim);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 5px 12px;
    transition: border-color 140ms ease;
  }
  .conn:hover {
    border-color: var(--accent);
  }
  .cdot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .cicon {
    display: inline-flex;
    width: 14px;
    height: 14px;
    color: var(--text-faint);
  }
  .cicon :global(svg) {
    width: 100%;
    height: 100%;
  }
  .conn.on .cicon {
    color: var(--accent);
  }
  .conn.on .cdot {
    background: var(--accent);
  }
  .kind {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .cwhen {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-faint);
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
    max-width: 520px;
    margin: 0 auto;
  }
  .disabled h2 {
    font-size: 1.3rem;
    margin-bottom: var(--s3);
  }
  .disabled p {
    color: var(--text-dim);
    margin: 0 auto var(--s5);
    max-width: 44ch;
  }

  @media (max-width: 760px) {
    .grid > div {
      grid-column: span 12 !important;
    }
  }
</style>
