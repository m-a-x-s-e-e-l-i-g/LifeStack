<script lang="ts">
  import type { ConnectorView } from "$lib/types";
  import { invalidateAll } from "$app/navigation";
  import { action } from "$lib/api";
  import { providerLogoUrl } from "$lib/branding";
  import { syncLabel, syncFailed } from "$lib/format";

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

  const fuelioAuthorizeUrl = $derived.by(() => {
    if (connector.id === "fuelio-dropbox") {
      const id = String(values.clientId ?? "").trim();
      if (!id) return null;
      const u = new URL("https://www.dropbox.com/oauth2/authorize");
      u.searchParams.set("response_type", "code");
      u.searchParams.set("token_access_type", "offline");
      u.searchParams.set("no_redirect", "1");
      u.searchParams.set("client_id", id);
      return u.toString();
    }
    if (connector.id === "fuelio-google-drive") {
      const id = String(values.clientId ?? "").trim();
      if (!id) return null;
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", id);
      u.searchParams.set("redirect_uri", "http://localhost");
      u.searchParams.set("scope", "https://www.googleapis.com/auth/drive.readonly");
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      return u.toString();
    }
    return null;
  });

  const showGmailAppPasswordHelp = $derived.by(() => {
    const host = String(values.imapHost ?? "").trim().toLowerCase();
    const user = String(values.imapUser ?? "").trim().toLowerCase();
    return host.includes("gmail") || user.endsWith("@gmail.com");
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

  // --- Trakt staged connect flow -------------------------------------------
  const cfgField = (key: string) => connector.config.find((f) => f.key === key);
  const connected = $derived(!!cfgField("accessToken")?.hasValue);
  const credsReady = $derived(
    !!cfgField("clientId")?.hasValue && !!cfgField("clientSecret")?.hasValue,
  );
  const secretSet = $derived(!!cfgField("clientSecret")?.hasValue);

  let pin = $state("");
  let authCode = $state("");
  let editCreds = $state(false);
  let reauth = $state(false);
  let failedIcons = $state<Record<string, boolean>>({});

  const iconForField = (iconKey: string, label: string, fallback?: string) =>
    failedIcons[iconKey] ? null : (providerLogoUrl(label) ?? fallback ?? null);

  const fieldIconFallbackText = (label: string) =>
    label
      .replace(/^scan\s+/i, "")
      .replace(/\s+(rides|orders|receipts)$/i, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "•";

  const saveCreds = () =>
    run(async () => {
      const config: Record<string, unknown> = {};
      if (typeof values.clientId === "string") config.clientId = values.clientId;
      if (typeof values.clientSecret === "string" && values.clientSecret !== "")
        config.clientSecret = values.clientSecret;
      await action(`/modules/${moduleId}/connectors/${connector.id}/config`, "PUT", { config });
      editCreds = false;
      status = "Saved";
    }, "Saving…");

  const connect = () =>
    run(async () => {
      await action(`/modules/${moduleId}/connectors/${connector.id}/authorize`, "POST", { pin });
      if (!connector.enabled)
        await action(`/modules/${moduleId}/connectors/${connector.id}/enable`);
      pin = "";
      reauth = false;
      status = "Connected";
    }, "Connecting…");

  const disconnect = () =>
    run(async () => {
      await action(`/modules/${moduleId}/connectors/${connector.id}/authorize`, "POST", {
        disconnect: true,
      });
      if (connector.enabled)
        await action(`/modules/${moduleId}/connectors/${connector.id}/disable`);
      status = "Disconnected";
    }, "Disconnecting…");

  const connectFuelio = () =>
    run(async () => {
      await action(`/modules/${moduleId}/connectors/${connector.id}/authorize`, "POST", { code: authCode });
      if (!connector.enabled)
        await action(`/modules/${moduleId}/connectors/${connector.id}/enable`);
      authCode = "";
      status = "Connected";
    }, "Connecting…");

  const disconnectFuelio = () =>
    run(async () => {
      await action(`/modules/${moduleId}/connectors/${connector.id}/authorize`, "POST", {
        disconnect: true,
      });
      status = "Disconnected";
    }, "Disconnecting…");
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

  {#if !connector.enabled}
    <p class="disabled-note">Enable this connector to show configuration and connection details.</p>
  {:else if connector.id === "trakt"}
    <div class="tk">
      {#snippet authLink()}
        {#if traktAuthorizeUrl}
          <a class="authlink" href={traktAuthorizeUrl} target="_blank" rel="noopener noreferrer">
            Authorize on Trakt
            <span class="go" aria-hidden="true">&rarr;</span>
          </a>
        {/if}
      {/snippet}
      {#snippet pinRow()}
        <div class="tk-pin">
          <input
            class="tk-pininput"
            placeholder="Paste PIN here"
            bind:value={pin}
            autocomplete="off"
            spellcheck="false"
          />
          <button class="btn" onclick={connect} disabled={busy || !pin.trim()}>Connect</button>
        </div>
      {/snippet}

      {#if connected && !editCreds}
        <div class="tk-state">
          <span class="tk-dot" aria-hidden="true"></span>
          <span class="tk-statetext">Connected to Trakt</span>
        </div>
        {#if reauth}
          <p class="tk-hint">
            Authorize again on Trakt and paste a fresh PIN. The new token replaces the current one,
            even if you set one through the environment.
          </p>
          <div class="tk-authrow">
            {@render authLink()}
            <button class="linklike" type="button" onclick={() => { reauth = false; pin = ""; }}>
              Cancel
            </button>
          </div>
          {@render pinRow()}
        {:else}
          <p class="tk-hint">
            Your account is linked. LifeStack syncs your watch history, ratings, watchlist,
            collection and stats automatically.
          </p>
          <div class="tk-actions">
            <button class="btn btn--ghost" onclick={() => (reauth = true)} disabled={busy}>
              Reconnect
            </button>
            <button class="btn btn--ghost" onclick={() => (editCreds = true)} disabled={busy}>
              App credentials
            </button>
            <button class="btn btn--ghost tk-danger" onclick={disconnect} disabled={busy}>
              Disconnect
            </button>
          </div>
        {/if}
      {:else if credsReady && !editCreds}
        <p class="tk-hint">Authorize LifeStack on Trakt, then paste the PIN it shows you.</p>
        <div class="tk-authrow">
          {@render authLink()}
          <button class="linklike" type="button" onclick={() => (editCreds = true)}>
            Edit credentials
          </button>
        </div>
        {@render pinRow()}
      {:else}
        <p class="tk-hint">
          Create an app at
          <a href="https://trakt.tv/oauth/applications" target="_blank" rel="noopener noreferrer">
            trakt.tv/oauth/applications
          </a>, set its Redirect URI to <code>urn:ietf:wg:oauth:2.0:oob</code>, then paste its Client
          ID and Secret.
        </p>
        <div class="fields">
          <label class="field">
            <span class="flabel">Client ID</span>
            <input type="text" bind:value={values.clientId} autocomplete="off" spellcheck="false" />
          </label>
          <label class="field">
            <span class="flabel">Client secret</span>
            <input
              type="password"
              placeholder={secretSet ? "•••••••• (set)" : "not set"}
              bind:value={values.clientSecret}
              autocomplete="off"
            />
          </label>
        </div>
        <div class="tk-actions">
          <button class="btn" onclick={saveCreds} disabled={busy}>Save credentials</button>
          {#if connected || credsReady}
            <button class="btn btn--ghost" onclick={() => (editCreds = false)} disabled={busy}>
              Cancel
            </button>
          {/if}
        </div>
      {/if}
    </div>
  {:else if connector.hasAuthorize && (connector.id === "fuelio-dropbox" || connector.id === "fuelio-google-drive")}
    <div class="tk">
      <p class="tk-hint">
        Save credentials and file location first. Then authorize access and paste the returned code to connect.
        Sync supports CSV and CSV.ZIP files, including multiple vehicle backups.
      </p>
      <div class="fields">
        {#each connector.config as f (f.key)}
          {#if f.type === "section"}
            <div class="section-header">{f.label}</div>
          {:else}
            <label class="field" class:field--icon={f.type === "boolean" && f.icon}>
              {#if f.type === "boolean"}
                {@const iconKey = `icon:${connector.id}:${f.key}`}
                {#if iconForField(iconKey, f.label, f.icon)}
                  <img
                    src={iconForField(iconKey, f.label, f.icon) ?? ""}
                    alt={f.label}
                    class="field-icon"
                    onerror={() => (failedIcons = { ...failedIcons, [iconKey]: true })}
                  />
                {:else}
                  <span class="field-icon-fallback" aria-hidden="true">{fieldIconFallbackText(f.label)}</span>
                {/if}
              {/if}
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
          {/if}
        {/each}
      </div>
      {#if fuelioAuthorizeUrl}
        <div class="tk-authrow">
          <a class="authlink" href={fuelioAuthorizeUrl} target="_blank" rel="noopener noreferrer">
            Authorize
            <span class="go" aria-hidden="true">&rarr;</span>
          </a>
          <button class="btn btn--ghost" onclick={save} disabled={busy}>Save config</button>
        </div>
      {/if}
      <div class="tk-pin">
        <input
          class="tk-pininput"
          placeholder="Paste authorization code"
          bind:value={authCode}
          autocomplete="off"
          spellcheck="false"
        />
        <button class="btn" onclick={connectFuelio} disabled={busy || !authCode.trim()}>Connect</button>
        <button class="btn btn--ghost tk-danger" onclick={disconnectFuelio} disabled={busy}>Disconnect</button>
      </div>
    </div>
  {:else if connector.config.length}
    <div class="fields">
      {#each connector.config as f (f.key)}
       {#if f.type === "section"}
         <div class="section-header">{f.label}</div>
       {:else}
         <label class="field" class:field--icon={f.type === "boolean" && f.icon}>
           {#if f.type === "boolean"}
             {@const iconKey = `icon:${connector.id}:${f.key}`}
             {#if iconForField(iconKey, f.label, f.icon)}
               <img
                 src={iconForField(iconKey, f.label, f.icon) ?? ""}
                 alt={f.label}
                 class="field-icon"
                 onerror={() => (failedIcons = { ...failedIcons, [iconKey]: true })}
               />
             {:else}
               <span class="field-icon-fallback" aria-hidden="true">{fieldIconFallbackText(f.label)}</span>
             {/if}
           {/if}
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
       {/if}
     {/each}
   </div>
    {#if showGmailAppPasswordHelp}
      <p class="tk-hint">
        Gmail requires an App Password for IMAP.
        <a
          href="https://support.google.com/accounts/answer/185833"
          target="_blank"
          rel="noopener noreferrer"
        >
          How to create an App Password
        </a>
      </p>
    {/if}
  {/if}

  <div class="row">
    <div class="left">
      {#if connector.enabled &&
        connector.id !== "trakt" &&
        connector.id !== "fuelio-dropbox" &&
        connector.id !== "fuelio-google-drive"}
        {#if connector.config.length}
          <button class="btn btn--ghost" onclick={save} disabled={busy}>Save config</button>
        {/if}
      {/if}
    </div>
    <div class="right">
      {#if status}<span class="status">{status}</span>{/if}
      {#if connector.hasSync}
        <span class="last" class:failed={syncFailed(connector.lastSync)}>
          {syncLabel(connector.lastSync)}
        </span>
      {/if}
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
  .disabled-note {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-dim);
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
  .field--icon {
    flex-direction: row;
    align-items: center;
    gap: var(--s2);
    padding: 8px 10px;
    border-radius: var(--r-sm);
    background: var(--surface);
    border: 1px solid var(--border-strong);
  }
  .field--icon .field-icon {
    width: 22px;
    height: 22px;
    object-fit: contain;
    flex-shrink: 0;
    opacity: 1;
  }
  .field--icon .field-icon-fallback {
    width: 22px;
    height: 22px;
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: color-mix(in oklab, var(--accent) 18%, var(--surface-2));
    color: var(--text);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .field--icon .flabel {
    flex: 1;
    margin: 0;
    font-size: 13px;
  }
  .field--icon input[type="checkbox"] {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    cursor: pointer;
  }
  .section-header {
    grid-column: 1 / -1;
    margin-top: var(--s2);
    margin-bottom: var(--s1);
    font-size: 11.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
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

  .tk {
    display: flex;
    flex-direction: column;
    gap: var(--s3);
  }
  .tk-state {
    display: flex;
    align-items: center;
    gap: var(--s2);
  }
  .tk-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 22%, transparent);
  }
  .tk-statetext {
    font-weight: 600;
    font-size: 13.5px;
  }
  .tk-hint {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-faint);
    max-width: 64ch;
    line-height: 1.5;
  }
  .tk-hint a {
    color: var(--accent);
  }
  .tk-hint code {
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--surface-2);
    color: var(--text-dim);
  }
  .tk-authrow,
  .tk-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s3);
  }
  .tk-pin {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }
  .tk-pininput {
    flex: 1 1 180px;
    min-width: 0;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    padding: 8px 10px;
    color: var(--text);
    font: inherit;
    font-size: 13.5px;
    letter-spacing: 0.06em;
  }
  .tk-pininput:focus-visible {
    border-color: var(--accent);
    outline: none;
  }
  .linklike {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 12px;
    color: var(--text-dim);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .linklike:hover {
    color: var(--text);
  }
  .tk-danger {
    color: oklch(0.7 0.13 25);
  }
  .tk-danger:hover {
    border-color: color-mix(in oklab, oklch(0.7 0.13 25) 45%, var(--border-strong));
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
  .last.failed {
    color: oklch(0.7 0.13 25);
  }
</style>
