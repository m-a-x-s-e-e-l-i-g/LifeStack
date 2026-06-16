<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import ConnectorCard from "$lib/components/ConnectorCard.svelte";
  import { action } from "$lib/api";

  let { data }: { data: PageData } = $props();

  let busyModule = $state<string | null>(null);

  async function toggleModule(id: string, enabled: boolean) {
    busyModule = id;
    try {
      await action(`/modules/${id}/${enabled ? "disable" : "enable"}`);
      await invalidateAll();
    } finally {
      busyModule = null;
    }
  }
</script>

<svelte:head><title>LifeStack — Settings</title></svelte:head>

<header class="head">
  <p class="eyebrow">Configuration</p>
  <h1>Modules &amp; connectors</h1>
  <p class="intro">
    Each module owns a domain. Connectors feed it data: API sources sync automatically, while CSV and
    manual connectors accept imports. Enable what you use, wire up credentials, and trigger a sync.
  </p>
</header>

<div class="modules">
  {#each data.modules as m (m.id)}
    <section class="module" style="--accent: {m.accent}">
      <div class="mhead">
        <div class="mident">
          <span class="badge">{m.icon}</span>
          <div>
            <div class="mname">
              <h2>{m.name}</h2>
              <a class="open" href="/m/{m.id}">Open →</a>
            </div>
            <p class="mdesc">{m.description}</p>
          </div>
        </div>
        <button
          class="switch"
          role="switch"
          aria-checked={m.enabled}
          aria-label={`${m.enabled ? "Disable" : "Enable"} ${m.name} module`}
          onclick={() => toggleModule(m.id, m.enabled)}
          disabled={busyModule === m.id}
        >
          <span class="knob"></span>
        </button>
      </div>

      <div class="conns">
        {#each m.connectors as c (c.id)}
          {#key `${c.id}-${c.enabled}-${c.lastSync}`}
            <ConnectorCard moduleId={m.id} connector={c} accent={m.accent} />
          {/key}
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .head {
    margin-bottom: var(--s6);
  }
  h1 {
    font-size: clamp(1.8rem, 1.4rem + 2vw, 2.6rem);
    letter-spacing: -0.03em;
    margin: 4px 0 var(--s3);
  }
  .intro {
    color: var(--text-dim);
    max-width: 70ch;
    margin: 0;
  }

  .modules {
    display: flex;
    flex-direction: column;
    gap: var(--s5);
  }
  .module {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    padding: var(--s5);
  }
  .mhead {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--s4);
    margin-bottom: var(--s4);
  }
  .mident {
    display: flex;
    gap: var(--s4);
    align-items: center;
  }
  .badge {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: var(--r);
    font-size: 21px;
    background: color-mix(in oklab, var(--accent) 16%, var(--surface-2));
    border: 1px solid color-mix(in oklab, var(--accent) 28%, var(--border));
  }
  .mname {
    display: flex;
    align-items: baseline;
    gap: var(--s3);
  }
  .mname h2 {
    font-size: 1.2rem;
    letter-spacing: -0.02em;
  }
  .open {
    font-size: 12.5px;
    color: var(--text-faint);
    transition: color 140ms ease;
  }
  .open:hover {
    color: var(--accent);
  }
  .mdesc {
    margin: 2px 0 0;
    font-size: 13px;
    color: var(--text-dim);
  }

  .conns {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }

  .switch {
    flex: none;
    width: 46px;
    height: 26px;
    border-radius: 99px;
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    padding: 2px;
    transition: background 180ms ease;
  }
  .switch[aria-checked="true"] {
    background: var(--accent);
    border-color: transparent;
  }
  .knob {
    display: block;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--text);
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .switch[aria-checked="true"] .knob {
    transform: translateX(20px);
    background: oklch(0.2 0.02 70);
  }
</style>
