<script lang="ts">
  import type { PageData } from "./$types";
  import { page } from "$app/stores";
  import { tick } from "svelte";
  import { action } from "$lib/api";
  import { display } from "$lib/format";
  import type { ChatResponse, ChatStep, ModuleSummary } from "$lib/types";

  let { data }: { data: PageData } = $props();

  type UploadImage = { name: string; mime: string; dataUrl: string };
  type Turn = {
    role: "user" | "assistant";
    content: string;
    steps?: ChatStep[];
    attachments?: UploadImage[];
  };

  let thread = $state<Turn[]>([]);
  let input = $state("");
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let scroller: HTMLDivElement | null = $state(null);
  let box: HTMLTextAreaElement | null = $state(null);
  let picker: HTMLInputElement | null = $state(null);
  let pendingImages = $state<UploadImage[]>([]);

  const modules = $derived((($page.data.modules ?? []) as ModuleSummary[]).filter((m) => m.enabled));

  const promptFor: Record<string, string> = {
    watching: "How many films and episodes have I watched this year?",
    finance: "What were my biggest spending categories last month?",
    energy: "Show my electricity cost by month this year.",
    fuel: "What is my average fuel economy in L/100km?",
    mobility: "I uploaded an Uber receipt screenshot. Extract it and save it as mobility data.",
    food: "I uploaded an Uber Eats screenshot. Extract the order and save it as food_order data.",
  };

  const suggestions = $derived(
    (() => {
      const fromModules = modules.map((m) => promptFor[m.id]).filter(Boolean) as string[];
      const generic = ["What can you tell me about my data?", "Which tables can you query?"];
      return [...fromModules, ...generic].slice(0, 4);
    })(),
  );

  function resize() {
    if (!box) return;
    box.style.height = "auto";
    box.style.height = Math.min(box.scrollHeight, 200) + "px";
  }

  async function scrollDown() {
    await tick();
    scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Could not read image"));
      reader.readAsDataURL(file);
    });
  }

  async function addImages(list: FileList | null) {
    if (!list || !list.length || busy) return;
    const files = [...list].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    const loaded: UploadImage[] = [];
    for (const file of files.slice(0, 6)) {
      const dataUrl = await readAsDataUrl(file);
      loaded.push({ name: file.name, mime: file.type, dataUrl });
    }
    pendingImages = [...pendingImages, ...loaded].slice(0, 6);
    if (picker) picker.value = "";
  }

  function removeImage(ix: number) {
    pendingImages = pendingImages.filter((_, i) => i !== ix);
  }

  async function send(text: string) {
    const content = text.trim();
    if ((!content && pendingImages.length === 0) || busy) return;
    errorText = null;
    const userTurn: Turn = { role: "user", content, attachments: pendingImages };
    thread = [...thread, userTurn];
    input = "";
    pendingImages = [];
    if (box) box.style.height = "auto";
    busy = true;
    scrollDown();
    try {
      const payload = thread.map((t) => ({
        role: t.role,
        content: t.content,
        ...(t.role === "user" && t.attachments?.length ? { attachments: t.attachments } : {}),
      }));
      const res = await action<ChatResponse>("/chat", "POST", { messages: payload });
      thread = [...thread, { role: "assistant", content: res.reply, steps: res.steps }];
    } catch (e) {
      errorText = e instanceof Error ? e.message : "The assistant could not respond.";
    } finally {
      busy = false;
      scrollDown();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function reset() {
    thread = [];
    errorText = null;
    input = "";
    pendingImages = [];
  }

  function columns(rows: Record<string, unknown>[]): string[] {
    return rows.length ? Object.keys(rows[0]) : [];
  }
  function cell(v: unknown): string {
    if (typeof v === "number") return display(v);
    if (v === null || v === undefined) return "—";
    return String(v);
  }
</script>

<svelte:head><title>LifeStack — Assistant</title></svelte:head>

<div class="chat">
  <div class="stream" bind:this={scroller}>
    <div class="col">
      {#if !data.ai.configured}
        <div class="setup">
          <div class="setup-mark" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 32 32">
              <rect x="6" y="17" width="5" height="9" rx="1.5" fill="var(--neg)" />
              <rect x="13.5" y="11" width="5" height="15" rx="1.5" fill="oklch(0.8 0.15 100)" />
              <rect x="21" y="6" width="5" height="20" rx="1.5" fill="var(--brand)" />
            </svg>
          </div>
          <div class="setup-body">
            <strong>The assistant is not connected yet.</strong>
            <p>
              Point LifeStack at any OpenAI-compatible endpoint: a local Ollama, LM Studio, or a hosted
              provider. You can still send a message to see how it responds.
            </p>
          </div>
          <a class="btn btn--primary" href="/settings#assistant">Connect a model</a>
        </div>
      {/if}

      {#if thread.length === 0}
        <div class="hero">
          <h1>Ask your data anything</h1>
          <p class="lede">
            One assistant over every module. Ask questions, or upload screenshots from apps like Uber,
            Bolt, and Lime to extract entries and save them directly into your local data stack.
          </p>
          {#if suggestions.length}
            <div class="suggest">
              {#each suggestions as s (s)}
                <button class="seed" onclick={() => send(s)} disabled={busy}>{s}</button>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="turns">
          {#each thread as t, i (i)}
            {#if t.role === "user"}
              <div class="turn user">
                <p class="who">You</p>
                <div class="said">{t.content}</div>
                {#if t.attachments?.length}
                  <div class="thumbs">
                    {#each t.attachments as img, ii (img.dataUrl + ii)}
                      <img class="thumb" src={img.dataUrl} alt={img.name || "Uploaded screenshot"} />
                    {/each}
                  </div>
                {/if}
              </div>
            {:else}
              <div class="turn bot">
                <p class="who">Assistant</p>
                <div class="reply">{t.content}</div>
                {#if t.steps && t.steps.length}
                  <details class="work" open={t.steps.some((s) => s.error)}>
                    <summary>{t.steps.length} {t.steps.length === 1 ? "step" : "steps"}</summary>
                    {#each t.steps as step, si (si)}
                      <div class="step">
                        <pre class="sql">{step.sql}</pre>
                        {#if step.error}
                          <p class="step-err">{step.error}</p>
                        {:else if step.rows && step.rows.length}
                          <div class="tablewrap">
                            <table>
                              <thead>
                                <tr>{#each columns(step.rows) as c (c)}<th>{c}</th>{/each}</tr>
                              </thead>
                              <tbody>
                                {#each step.rows.slice(0, 12) as row, ri (ri)}
                                  <tr>
                                    {#each columns(step.rows) as c (c)}<td>{cell(row[c])}</td>{/each}
                                  </tr>
                                {/each}
                              </tbody>
                            </table>
                            {#if step.rows.length > 12}
                              <p class="more">+{step.rows.length - 12} more rows</p>
                            {/if}
                          </div>
                        {:else}
                          <p class="step-empty">No rows returned.</p>
                        {/if}
                      </div>
                    {/each}
                  </details>
                {/if}
              </div>
            {/if}
          {/each}

          {#if busy}
            <div class="turn bot">
              <p class="who">Assistant</p>
              <div class="thinking" aria-label="Thinking">
                <span></span><span></span><span></span>
              </div>
            </div>
          {/if}

          {#if errorText}
            <div class="turn bot">
              <p class="who">Assistant</p>
              <p class="fail">{errorText}</p>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <div class="composer">
    <div class="col composer-col">
      {#if thread.length > 0}
        <button class="reset" onclick={reset} disabled={busy} aria-label="Start a new conversation">
          New chat
        </button>
      {/if}
      {#if pendingImages.length}
        <div class="pending">
          {#each pendingImages as img, i (img.dataUrl + i)}
            <div class="pending-item">
              <img src={img.dataUrl} alt={img.name || "Screenshot"} />
              <button
                class="pending-remove"
                type="button"
                onclick={() => removeImage(i)}
                aria-label="Remove screenshot"
              >
                ×
              </button>
            </div>
          {/each}
        </div>
      {/if}
      <div class="field">
        <input
          bind:this={picker}
          class="picker"
          type="file"
          accept="image/*"
          multiple
          onchange={(e) => addImages((e.currentTarget as HTMLInputElement).files)}
        />
        <button
          class="attach"
          type="button"
          onclick={() => picker?.click()}
          disabled={busy || pendingImages.length >= 6}
          aria-label="Upload screenshots"
        >
          +
        </button>
        <textarea
          bind:this={box}
          bind:value={input}
          oninput={resize}
          onkeydown={onKey}
          rows="1"
          placeholder="Ask about your watching, spending, energy, fuel, or trips…"
          disabled={busy}
        ></textarea>
        <button
          class="send"
          onclick={() => send(input)}
          disabled={busy || (!input.trim() && pendingImages.length === 0)}
          aria-label="Send message"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 11 12 6l5 5" /><path d="M12 6v12" />
          </svg>
        </button>
      </div>
      <p class="hint">
        Upload screenshots, ask for extraction, and the assistant can save or delete records in your local
        database when you explicitly request it. Enter to send, Shift+Enter for a new line.
      </p>
    </div>
  </div>
</div>

<style>
  .chat {
    display: flex;
    flex-direction: column;
    /* Fill the viewport minus the main padding so the composer pins to the bottom. */
    height: calc(100vh - var(--s6) - var(--s7));
    min-height: 520px;
    margin: calc(-1 * var(--s6)) calc(-1 * var(--s6)) calc(-1 * var(--s7));
  }

  .stream {
    flex: 1;
    overflow-y: auto;
    padding: var(--s6) var(--s6) var(--s5);
  }

  .col {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
  }

  /* Setup notice ---------------------------------------------------------- */
  .setup {
    display: flex;
    align-items: center;
    gap: var(--s4);
    padding: var(--s4);
    margin-bottom: var(--s5);
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: var(--r);
  }
  .setup-mark {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    flex: none;
    border-radius: var(--r-sm);
    background: var(--surface);
    border: 1px solid var(--border);
  }
  .setup-body {
    flex: 1;
    min-width: 0;
  }
  .setup-body strong {
    font-size: 14px;
  }
  .setup-body p {
    margin: 3px 0 0;
    font-size: 13px;
    color: var(--text-dim);
    max-width: 60ch;
  }
  .setup .btn {
    flex: none;
  }

  /* Empty hero ------------------------------------------------------------ */
  .hero {
    padding: clamp(var(--s5), 8vh, var(--s7)) 0 var(--s5);
  }
  .hero h1 {
    font-size: clamp(1.9rem, 1.4rem + 2.4vw, 2.7rem);
    letter-spacing: -0.03em;
  }
  .lede {
    margin: var(--s3) 0 var(--s5);
    color: var(--text-dim);
    font-size: 15.5px;
    max-width: 62ch;
  }
  .suggest {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--s2);
  }
  .seed {
    text-align: left;
    padding: 11px var(--s4);
    border-radius: var(--r);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text-dim);
    font-size: 14px;
    transition:
      border-color 150ms ease,
      color 150ms ease,
      transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .seed:hover:not(:disabled) {
    border-color: var(--brand);
    color: var(--text);
    transform: translateX(3px);
  }
  .seed:disabled {
    opacity: 0.5;
  }

  /* Turns ----------------------------------------------------------------- */
  .turns {
    display: flex;
    flex-direction: column;
    gap: var(--s6);
    padding-bottom: var(--s4);
  }
  .who {
    margin: 0 0 var(--s2);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .turn.user .who {
    color: var(--brand-dim);
  }
  .said {
    font-size: 16px;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .thumbs {
    margin-top: var(--s2);
    display: flex;
    gap: var(--s2);
    flex-wrap: wrap;
  }
  .thumb {
    width: 82px;
    height: 82px;
    object-fit: cover;
    border-radius: var(--r-sm);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .reply {
    font-size: 15.5px;
    line-height: 1.62;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .fail {
    margin: 0;
    color: var(--neg);
    font-size: 14.5px;
  }

  /* Query disclosure ------------------------------------------------------ */
  .work {
    margin-top: var(--s4);
    border: 1px solid var(--border);
    border-radius: var(--r);
    background: var(--bg-sunken);
    overflow: hidden;
  }
  .work summary {
    list-style: none;
    cursor: pointer;
    padding: 9px var(--s4);
    font-size: 12px;
    font-family: var(--font-mono);
    color: var(--text-faint);
    user-select: none;
  }
  .work summary::-webkit-details-marker {
    display: none;
  }
  .work summary::before {
    content: "›";
    display: inline-block;
    margin-right: var(--s2);
    transition: transform 160ms ease;
  }
  .work[open] summary::before {
    transform: rotate(90deg);
  }
  .work summary:hover {
    color: var(--text-dim);
  }
  .step {
    border-top: 1px solid var(--border);
    padding: var(--s3) var(--s4);
  }
  .sql {
    margin: 0 0 var(--s3);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-dim);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .step-err {
    margin: 0;
    font-size: 12.5px;
    color: var(--neg);
    font-family: var(--font-mono);
  }
  .step-empty {
    margin: 0;
    font-size: 12.5px;
    color: var(--text-faint);
  }
  .tablewrap {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12.5px;
  }
  th,
  td {
    text-align: left;
    padding: 6px var(--s3);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  th {
    font-family: var(--font-mono);
    font-weight: 500;
    color: var(--text-faint);
    font-size: 11px;
    letter-spacing: 0.04em;
  }
  td {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .more {
    margin: var(--s2) 0 0;
    font-size: 11.5px;
    color: var(--text-faint);
  }

  /* Thinking indicator ---------------------------------------------------- */
  .thinking {
    display: inline-flex;
    gap: 5px;
    padding: 4px 0;
  }
  .thinking span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-faint);
    animation: blink 1.2s infinite ease-in-out both;
  }
  .thinking span:nth-child(2) {
    animation-delay: 0.18s;
  }
  .thinking span:nth-child(3) {
    animation-delay: 0.36s;
  }
  @keyframes blink {
    0%,
    80%,
    100% {
      opacity: 0.25;
    }
    40% {
      opacity: 1;
    }
  }

  /* Composer -------------------------------------------------------------- */
  .composer {
    border-top: 1px solid var(--border);
    background: color-mix(in oklab, var(--bg) 88%, transparent);
    backdrop-filter: blur(8px);
    padding: var(--s4) var(--s6) var(--s5);
  }
  .composer-col {
    position: relative;
  }
  .reset {
    position: absolute;
    top: calc(-1 * var(--s5));
    right: 0;
    font-size: 12px;
    color: var(--text-faint);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 4px 11px;
    transition:
      color 140ms ease,
      border-color 140ms ease;
  }
  .reset:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border-strong);
  }
  .field {
    display: flex;
    align-items: flex-end;
    gap: var(--s2);
    padding: var(--s2) var(--s2) var(--s2) var(--s4);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-lg);
    transition: border-color 160ms ease;
  }
  .picker {
    display: none;
  }
  .attach {
    flex: none;
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: var(--r);
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text-dim);
    font-size: 20px;
    line-height: 1;
  }
  .attach:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--brand);
  }
  .attach:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .field:focus-within {
    border-color: var(--brand);
  }
  textarea {
    flex: 1;
    resize: none;
    border: none;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 15px;
    line-height: 1.5;
    padding: 7px 0;
    max-height: 200px;
  }
  textarea:focus {
    outline: none;
  }
  textarea::placeholder {
    color: var(--text-faint);
  }
  .send {
    flex: none;
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: var(--r);
    border: none;
    background: var(--brand);
    color: oklch(0.18 0.02 70);
    transition:
      background 160ms ease,
      transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .send:hover:not(:disabled) {
    background: color-mix(in oklab, var(--brand) 85%, white);
  }
  .send:active:not(:disabled) {
    transform: translateY(1px);
  }
  .send:disabled {
    background: var(--surface-2);
    color: var(--text-faint);
    cursor: not-allowed;
  }
  .hint {
    margin: var(--s2) 0 0;
    font-size: 11.5px;
    color: var(--text-faint);
  }
  .pending {
    display: flex;
    gap: var(--s2);
    flex-wrap: wrap;
    margin: 0 0 var(--s2);
  }
  .pending-item {
    position: relative;
    width: 58px;
    height: 58px;
  }
  .pending-item img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 7px;
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .pending-remove {
    position: absolute;
    top: -7px;
    right: -7px;
    width: 18px;
    height: 18px;
    border: 1px solid var(--border);
    border-radius: 99px;
    background: var(--bg-sunken);
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1;
    padding: 0;
  }

  @media (max-width: 900px) {
    .chat {
      height: auto;
      min-height: calc(100vh - 120px);
      margin: calc(-1 * var(--s5)) calc(-1 * var(--s4)) calc(-1 * var(--s7));
    }
    .stream {
      padding: var(--s5) var(--s4) var(--s4);
    }
    .composer {
      position: sticky;
      bottom: 0;
      padding: var(--s3) var(--s4) var(--s4);
    }
    .setup {
      flex-wrap: wrap;
    }
  }
</style>
