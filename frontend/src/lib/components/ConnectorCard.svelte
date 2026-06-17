<script lang="ts">
  import type { ConnectorView } from "$lib/types";
  import { invalidateAll } from "$app/navigation";
  import { action } from "$lib/api";
  import { relativeTime } from "$lib/format";

  let { moduleId, connector, accent }: { moduleId: string; connector: ConnectorView; accent: string } =
    $props();

  function initValues() {
    const v: Record<string, string | boolean> = {};
    for (const f of connector.config) {
      if (f.secret) v[f.key] = "";
      else if (f.type === "boolean") v[f.key] = !!f.value;
      else v[f.key] = f.value === undefined || f.value === null ? "" : String(f.value);
    }
    return v;
  }

  let values = $state(initValues());
  let busy = $state(false);
  let status = $state<string | null>(null);

  // Trakt connects via an out-of-band PIN: once a Client ID is present we can
  // build the authorize link the user opens to approve access and get the PIN.
  const traktAuthorizeUrl = $derived.by(() => {
    if (connector.id !== "trakt") return null;
    const id = String(values.clientId ?? "").trim();
    if (!id) return null;
    const u = new URL("https://trakt.tv/oauth/authorize");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", id);
    u.searchParams.set("redirect_uri", "urn:ietf:wg:oauth:2.0:oob");
    return u.toString();
  });

  async function run(fn: () => Promise<void>, working = "Working…") {
    busy = true;
    status = working;
    try {
      await fn();
      await invalidateAll();
    } catch (e) {
      status = e instanceof Error ? e.message : "Failed";
      busy = false;
      return;
    }
    busy = false;
  }

  const toggle = () =>
    run(async () => {
      await action(`/modules/${moduleId}/connectors/${connector.id}/${connector.enabled ? "disable" : "enable"}`);
      status = null;
    });

  const sync = () =>
    run(async () => {
      const r = await action<{ inserted?: number; updated?: number }>(
        `/modules/${moduleId}/connectors/${connector.id}/sync`,
      );
      status = `Synced (+${r.inserted ?? 0} new)`;
    }, "Syncing…");

  const save = () =>
    run(async () => {
      const config: Record<string, unknown> = {};
      for (const f of connector.config) {
        const val = values[f.key];
        if (f.secret) {
          if (val !== "") config[f.key] = val;
        } else if (f.type === "number") {
          if (val !== "") config[f.key] = Number(val);
        } else {
          config[f.key] = val;
        }
      }
      await action(`/modules/${moduleId}/connectors/${connector.id}/config`, "PUT", { config });
      status = "Saved";
    }, "Saving…");
</script>

<div class="conn" class:on={connector.enabled} style="--accent: {accent}">
  <div class="top">
    <div class="meta">
      <div class="name-row">
        {#if connector.icon}<span class="cicon">{@html connector.icon}</span>{/if}
        <span class="name">{connector.name}</span>
        <span class="kind kind--{connector.kind}">{connector.kind}</span>
      </div>
      <p class="desc">{connector.description}</p>
    </div>
    <button
      class="switch"
      role="switch"
      aria-checked={connector.enabled}
      aria-label={`${connector.enabled ? "Disable" : "Enable"} ${connector.name} connector`}
      onclick={toggle}
      disabled={busy}
    >
      <span class="knob"></span>
    </button>
  </div>

  {#if connector.config.length}
    <div class="fields">
      {#each connector.config as f (f.key)}
        <label class="field">
          <span class="flabel">{f.label}</span>
          {#if f.type === "boolean"}
            <input type="checkbox" bind:checked={values[f.key] as boolean} />
          {:else if f.secret}
            <input
              type="password"
              placeholder={f.hasValue ? "•••••••• (set)" : "not set"}
              bind:value={values[f.key]}
              autocomplete="off"
            />
          {:else}
            <input type={f.type === "number" ? "number" : "text"} bind:value={values[f.key]} />
          {/if}
          {#if f.help}<span class="help">{f.help}</span>{/if}
        </label>
      {/each}
    </div>
  {/if}

  {#if connector.id === "trakt"}
    <p class="auth">
      {#if traktAuthorizeUrl}
        <a href={traktAuthorizeUrl} target="_blank" rel="noopener noreferrer" class="authlink">
          Authorize on Trakt
          <span class="go" aria-hidden="true">&rarr;</span>
        </a>
        <span class="authnote">Approve access, then paste the PIN below and save.</span>
      {:else}
        <span class="authnote">Enter your Client ID to reveal the authorize link.</span>
      {/if}
    </p>
  {/if}

  <div class="row">
    <div class="left">
      {#if connector.config.length}
        <button class="btn btn--ghost" onclick={save} disabled={busy}>Save config</button>
      {/if}
      {#if connector.hasSync}
        <button class="btn" onclick={sync} disabled={busy || !connector.enabled}>Sync</button>
      {/if}
      {#if connector.hasImport}
        <span class="importnote">CSV import via API</span>
      {/if}
    </div>
    <div class="right">
      {#if status}<span class="status">{status}</span>{/if}
      {#if connector.lastSync}<span class="last">last sync {relativeTime(connector.lastSync)}</span>{/if}
    </div>
  </div>
</div>

<style>
  .conn {
    border: 1px solid var(--border);
    border-radius: var(--r);
    padding: var(--s4);
    background: var(--bg-sunken);
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  .conn.on {
    border-color: color-mix(in oklab, var(--accent) 28%, var(--border));
  }
  .top {
    display: flex;
    justify-content: space-between;
    gap: var(--s4);
    align-items: flex-start;
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: var(--s2);
  }
  .cicon {
    display: inline-flex;
    width: 17px;
    height: 17px;
    color: var(--accent);
  }
  .cicon :global(svg) {
    width: 100%;
    height: 100%;
  }
  .name {
    font-weight: 600;
    font-size: 14.5px;
  }
  .kind {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 5px;
    color: var(--text-dim);
    background: var(--surface-2);
  }
  .kind--api {
    color: var(--accent);
    background: color-mix(in oklab, var(--accent) 16%, transparent);
  }
  .desc {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-faint);
    max-width: 60ch;
  }

  .switch {
    flex: none;
    width: 42px;
    height: 24px;
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
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--text);
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .switch[aria-checked="true"] .knob {
    transform: translateX(18px);
    background: oklch(0.2 0.02 70);
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--s3);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .flabel {
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .field input[type="text"],
  .field input[type="password"],
  .field input[type="number"] {
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    padding: 8px 10px;
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

  .auth {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s2) var(--s3);
  }
  .authlink {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
    padding: 6px 11px;
    border-radius: var(--r-sm);
    border: 1px solid color-mix(in oklab, var(--accent) 40%, var(--border-strong));
    background: color-mix(in oklab, var(--accent) 12%, transparent);
    transition:
      background 160ms ease,
      transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .authlink:hover {
    background: color-mix(in oklab, var(--accent) 20%, transparent);
  }
  .authlink .go {
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .authlink:hover .go {
    transform: translateX(3px);
  }
  .authnote {
    font-size: 11.5px;
    color: var(--text-faint);
  }

  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s3);
    flex-wrap: wrap;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }
  .importnote,
  .last {
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .status {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--accent);
  }
  .last {
    font-family: var(--font-mono);
  }
</style>
