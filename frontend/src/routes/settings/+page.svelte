<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import ConnectorCard from "$lib/components/ConnectorCard.svelte";
  import { action } from "$lib/api";

  let { data }: { data: PageData } = $props();

  let busyModule = $state<string | null>(null);
  let addingMailboxModule = $state<string | null>(null);
  let mailboxAddError = $state<string | null>(null);

  let ai = $state({ baseUrl: "", model: "", apiKey: "" });
  let aiBusy = $state(false);
  let aiStatusMsg = $state<string | null>(null);

  async function toggleModule(id: string, enabled: boolean) {
    busyModule = id;
    try {
      await action(`/modules/${id}/${enabled ? "disable" : "enable"}`);
      await invalidateAll();
    } finally {
      busyModule = null;
    }
  }

  async function addMailboxSlot(moduleId: string) {
    addingMailboxModule = moduleId;
    mailboxAddError = null;
    try {
      await action(`/modules/${moduleId}/connectors/mailbox/add`);
      await invalidateAll();
    } catch (e) {
      mailboxAddError = e instanceof Error ? e.message : "Failed to add mailbox slot";
    } finally {
      addingMailboxModule = null;
    }
  }

  async function saveAi() {
    aiBusy = true;
    aiStatusMsg = "Saving…";
    try {
      const patch: Record<string, string> = {};
      if (ai.baseUrl.trim()) patch.baseUrl = ai.baseUrl.trim();
      if (ai.model.trim()) patch.model = ai.model.trim();
      if (ai.apiKey) patch.apiKey = ai.apiKey;
      await action("/ai/config", "PUT", patch);
      ai.apiKey = "";
      await invalidateAll();
      aiStatusMsg = "Saved";
    } catch (e) {
      aiStatusMsg = e instanceof Error ? e.message : "Failed";
    } finally {
      aiBusy = false;
    }
  }

  function moduleHref(moduleId: string): string {
    return moduleId === "observations" ? "/nature-observations" : `/m/${moduleId}`;
  }
</script>

<svelte:head><title>LifeStack — Settings</title></svelte:head>

<header class="head">
  <p class="eyebrow">Configuration</p>
  <h1>Modules &amp; connectors</h1>
  <p class="intro">
    Each module owns a domain. Connectors feed it data and API sources sync automatically. You can also
    add records through the assistant by uploading screenshots and asking it to save them.
  </p>
</header>

<section class="assistant" id="assistant" style="--accent: var(--brand)">
  <div class="ahead">
    <div class="aident">
      <span class="abadge">✦</span>
      <div>
        <div class="aname">
          <h2>Assistant</h2>
          <span class="state" class:on={data.ai.configured}>
            {data.ai.configured ? "Connected" : "Not connected"}
          </span>
        </div>
        <p class="adesc">
          Connect any OpenAI-compatible endpoint. LifeStack passes your table schema and can run
          read-only analysis queries, plus write or delete deduped records in local tables when you
          explicitly ask it to modify data.
        </p>
      </div>
    </div>
  </div>

  <div class="afields">
    <label class="field">
      <span class="flabel">Base URL</span>
      <input
        type="text"
        bind:value={ai.baseUrl}
        placeholder={data.ai.baseUrl || "https://api.openai.com/v1"}
        autocomplete="off"
      />
      <span class="help">For a local Ollama, use http://host.docker.internal:11434/v1</span>
    </label>
    <label class="field">
      <span class="flabel">Model</span>
      <input type="text" bind:value={ai.model} placeholder={data.ai.model || "gpt-4o-mini, llama3.1, qwen2.5 …"} autocomplete="off" />
    </label>
    <label class="field">
      <span class="flabel">API key</span>
      <input
        type="password"
        bind:value={ai.apiKey}
        placeholder={data.ai.hasKey ? "•••••••• (set)" : "optional for local models"}
        autocomplete="off"
      />
    </label>
  </div>

  <div class="arow">
    <button class="btn btn--primary" onclick={saveAi} disabled={aiBusy}>Save assistant</button>
    {#if aiStatusMsg}<span class="astatus">{aiStatusMsg}</span>{/if}
    {#if data.ai.configured}<span class="ameta">{data.ai.baseUrl} · {data.ai.model}</span>{/if}
  </div>
</section>

<div class="modules">
  {#each data.modules as m (m.id)}
    <section class="module" style="--accent: {m.accent}">
      <div class="mhead">
        <div class="mident">
          <span class="badge">{m.icon}</span>
          <div>
            <div class="mname">
              <h2>{m.name}</h2>
              <a class="open" href={moduleHref(m.id)}>Open →</a>
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
          {#key `${c.id}-${c.enabled}-${c.lastSync?.at ?? ""}`}
            <ConnectorCard moduleId={m.id} connector={c} accent={m.accent} />
          {/key}
        {/each}
      </div>

      {#if m.id === "inbox"}
        <div class="conn-tools">
          <button
            class="btn btn--ghost"
            onclick={() => addMailboxSlot(m.id)}
            disabled={addingMailboxModule === m.id}
          >
            {addingMailboxModule === m.id ? "Adding mailbox…" : "+ Add mailbox"}
          </button>
          {#if mailboxAddError}<span class="conn-error">{mailboxAddError}</span>{/if}
        </div>
      {/if}
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

  .assistant {
    background: var(--surface);
    border: 1px solid color-mix(in oklab, var(--accent) 22%, var(--border));
    border-radius: var(--r-lg);
    padding: var(--s5);
    margin-bottom: var(--s5);
  }
  .ahead {
    margin-bottom: var(--s4);
  }
  .aident {
    display: flex;
    gap: var(--s4);
    align-items: flex-start;
  }
  .abadge {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    flex: none;
    border-radius: var(--r);
    font-size: 20px;
    color: var(--accent);
    background: color-mix(in oklab, var(--accent) 16%, var(--surface-2));
    border: 1px solid color-mix(in oklab, var(--accent) 28%, var(--border));
  }
  .aname {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  .aname h2 {
    font-size: 1.2rem;
    letter-spacing: -0.02em;
  }
  .state {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 2px 9px;
  }
  .state.on {
    color: var(--pos);
    border-color: color-mix(in oklab, var(--pos) 40%, var(--border));
  }
  .adesc {
    margin: 4px 0 0;
    font-size: 13px;
    color: var(--text-dim);
    max-width: 66ch;
  }
  .afields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--s4);
    margin-bottom: var(--s4);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .flabel {
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .field input {
    background: var(--bg-sunken);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    padding: 9px 11px;
    color: var(--text);
    font: inherit;
    font-size: 13.5px;
  }
  .field input:focus-visible {
    border-color: var(--accent);
    outline: none;
  }
  .help {
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .arow {
    display: flex;
    align-items: center;
    gap: var(--s3);
    flex-wrap: wrap;
  }
  .astatus {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent);
  }
  .ameta {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-faint);
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
  .conn-tools {
    margin-top: var(--s3);
    display: flex;
    align-items: center;
    gap: var(--s3);
    flex-wrap: wrap;
  }
  .conn-error {
    font-size: 12px;
    color: oklch(0.7 0.13 25);
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
