<script lang="ts">
  import type { PageData } from "./$types";
  import Widget from "$lib/components/Widget.svelte";
  import { relativeTime } from "$lib/format";
  import type { OverviewFeatured } from "$lib/types";

  let { data }: { data: PageData } = $props();

  const spanFor: Record<string, string> = {
    sm: "span 3",
    md: "span 6",
    lg: "span 6",
    xl: "span 12",
  };

  type Group = {
    id: string;
    name: string;
    icon: string;
    accent: string;
    lastSync: string | null;
    widgets: OverviewFeatured["widget"][];
  };

  const groups = $derived(
    (() => {
      const byId = new Map<string, Group>();
      for (const m of data.overview.modules) {
        if (!m.enabled) continue;
        byId.set(m.id, {
          id: m.id,
          name: m.name,
          icon: m.icon,
          accent: m.accent,
          lastSync: m.lastSync,
          widgets: [],
        });
      }
      for (const f of data.overview.featured) {
        byId.get(f.id)?.widgets.push(f.widget);
      }
      return [...byId.values()].filter((g) => g.widgets.length);
    })(),
  );

  const enabledCount = $derived(data.overview.modules.filter((m) => m.enabled).length);
</script>

<svelte:head><title>LifeStack — Overview</title></svelte:head>

<header class="head">
  <div>
    <p class="eyebrow">Your data, aggregated</p>
    <h1>Overview</h1>
  </div>
  <div class="chips">
    <span class="chip"><b>{enabledCount}</b> active {enabledCount === 1 ? "module" : "modules"}</span>
    <span class="chip"><b>{groups.reduce((a, g) => a + g.widgets.length, 0)}</b> live stats</span>
  </div>
</header>

{#if !groups.length}
  <div class="empty panel">
    <h2>Nothing to show yet</h2>
    <p>
      No modules are enabled, or the backend has not aggregated any data. Enable a module and connect
      a source to start building your stack.
    </p>
    <a class="btn btn--primary" href="/settings">Open settings</a>
  </div>
{:else}
  <div class="strips">
    {#each groups as g (g.id)}
      <section class="strip" style="--accent: {g.accent}">
        <div class="strip-head">
          <a href="/m/{g.id}" class="title">
            <span class="dot"></span>
            <span class="icon">{g.icon}</span>
            <h2>{g.name}</h2>
          </a>
          <a href="/m/{g.id}" class="view">
            {#if g.lastSync}<span class="synced">synced {relativeTime(g.lastSync)}</span>{/if}
            View module →
          </a>
        </div>
        <div class="strip-grid">
          {#each g.widgets as w (w.id)}
            <div style="grid-column: {spanFor[w.size] ?? 'span 6'}">
              <Widget widget={w} accent={g.accent} />
            </div>
          {/each}
        </div>
      </section>
    {/each}
  </div>
{/if}

<style>
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: var(--s4);
    margin-bottom: var(--s6);
    flex-wrap: wrap;
  }
  h1 {
    font-size: clamp(2rem, 1.4rem + 2.5vw, 2.9rem);
    letter-spacing: -0.03em;
    margin-top: 4px;
  }
  .chips {
    display: flex;
    gap: var(--s2);
  }
  .chip {
    font-size: 13px;
    color: var(--text-dim);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 6px 13px;
  }
  .chip b {
    color: var(--text);
    font-family: var(--font-mono);
  }

  .strips {
    display: flex;
    flex-direction: column;
    gap: var(--s7);
  }
  .strip-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s3);
    padding-bottom: var(--s4);
    margin-bottom: var(--s4);
    border-bottom: 1px solid var(--border);
  }
  .title {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  .dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--accent);
  }
  .icon {
    font-size: 18px;
  }
  .title h2 {
    font-size: 1.25rem;
    letter-spacing: -0.02em;
  }
  .view {
    display: inline-flex;
    align-items: center;
    gap: var(--s3);
    font-size: 13px;
    color: var(--text-faint);
    transition: color 140ms ease;
  }
  .view:hover {
    color: var(--accent);
  }
  .synced {
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .strip-grid {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: var(--s4);
  }
  .strip-grid > div {
    min-width: 0;
  }

  .empty {
    text-align: center;
    padding: var(--s7) var(--s5);
    max-width: 560px;
    margin: 0 auto;
  }
  .empty h2 {
    font-size: 1.4rem;
    margin-bottom: var(--s3);
  }
  .empty p {
    color: var(--text-dim);
    margin: 0 auto var(--s5);
    max-width: 46ch;
  }

  @media (max-width: 760px) {
    .strip-grid > div {
      grid-column: span 12 !important;
    }
  }
</style>
