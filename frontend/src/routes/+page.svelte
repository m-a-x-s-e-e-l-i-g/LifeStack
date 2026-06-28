<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import type { PageData } from "./$types";
  import { page } from "$app/stores";
  import { onMount, tick } from "svelte";
  import { action } from "$lib/api";
  import { display } from "$lib/format";
  import type { ChatResponse, ChatStep, ModuleSummary, PendingChange } from "$lib/types";

  let { data }: { data: PageData } = $props();

  type UploadAttachment = { name: string; mime: string; dataUrl: string; text?: string };
  const CHAT_STORAGE_KEY = "lifestack:assistant:thread:v1";
  const MAX_PENDING_ATTACHMENTS = 50;
  const MAX_IMAGE_SIDE_PX = 1280;
  const IMAGE_QUALITY = 0.72;
  const MAX_ATTACHMENT_TEXT_CHARS = 24000;
  const ATTACHMENT_ACCEPT =
    "image/*,.csv,text/csv,application/csv,text/plain,.txt,text/tab-separated-values,.tsv,application/json,.json,application/pdf,.pdf,text/xml,application/xml,.xml";
  type Turn = {
    role: "user" | "assistant";
    content: string;
    steps?: ChatStep[];
    attachmentCount?: number;
    pendingActions?: PendingChange[];
  };
  type PendingRequest = {
    content: string;
    attachments: UploadAttachment[];
    turnIndex: number;
  };
  type ArmedApproval = {
    turnIndex: number;
    changeId: string;
  };

  let thread = $state<Turn[]>([]);
  let input = $state("");
  let busy = $state(false);
  let errorText = $state<string | null>(null);
  let scroller: HTMLDivElement | null = $state(null);
  let box: HTMLTextAreaElement | null = $state(null);
  let picker: HTMLInputElement | null = $state(null);
  let pendingAttachments = $state<UploadAttachment[]>([]);
  let persistenceReady = $state(false);
  let pendingRequest = $state<PendingRequest | null>(null);
  let canRetry = $state(false);
  let armedApproval = $state<ArmedApproval | null>(null);

  function isTurn(value: unknown): value is Turn {
    return (
      !!value &&
      typeof value === "object" &&
      ((value as { role?: unknown }).role === "user" ||
        (value as { role?: unknown }).role === "assistant") &&
      typeof (value as { content?: unknown }).content === "string"
    );
  }

  onMount(() => {
    try {
      const raw = localStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          thread = parsed.filter(isTurn);
        }
      }
    } catch {
      // Ignore malformed local state and start with an empty thread.
    } finally {
      persistenceReady = true;
    }
  });

  $effect(() => {
    if (!persistenceReady) return;
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(thread));
  });

  const modules = $derived((($page.data.modules ?? []) as ModuleSummary[]).filter((m) => m.enabled));

  const promptFor: Record<string, string> = {
    watching: "How many films and episodes have I watched this year?",
    observations: "Show my top observed species and monthly observation trend.",
    finance: "What were my biggest spending categories last month?",
    energy: "Show my electricity cost by month this year.",
    fuel: "What is my average fuel economy in L/100km?",
    mobility: "I uploaded ride receipts. Extract them and save them as mobility data.",
    food: "I uploaded a food receipt. Extract the order and save it as food_order data.",
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
      reader.onerror = () => reject(new Error("Could not read file"));
      reader.readAsDataURL(file);
    });
  }

  function readAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Could not read text file"));
      reader.readAsText(file);
    });
  }

  function inferMimeFromName(name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith(".csv")) return "text/csv";
    if (lower.endsWith(".tsv")) return "text/tab-separated-values";
    if (lower.endsWith(".txt")) return "text/plain";
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".xml")) return "application/xml";
    if (lower.endsWith(".pdf")) return "application/pdf";
    return "application/octet-stream";
  }

  function normalizeAttachmentMime(file: File): string {
    const raw = file.type?.trim();
    return raw || inferMimeFromName(file.name);
  }

  function isTextLikeMime(mime: string): boolean {
    const lower = mime.toLowerCase();
    return (
      lower.startsWith("text/") ||
      lower === "application/json" ||
      lower === "application/csv" ||
      lower === "text/csv" ||
      lower === "text/tab-separated-values" ||
      lower === "application/xml" ||
      lower === "text/xml"
    );
  }

  function textToDataUrl(text: string, mime: string): string {
    return `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  }

  function clipAttachmentText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "";
    if (trimmed.length <= MAX_ATTACHMENT_TEXT_CHARS) return trimmed;
    return `${trimmed.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n...[truncated]`;
  }

  function imageNameAsJpeg(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "upload.jpg";
    return /\.[^./\\]+$/.test(trimmed) ? trimmed.replace(/\.[^./\\]+$/, ".jpg") : `${trimmed}.jpg`;
  }

  function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode image"));
      img.src = dataUrl;
    });
  }

  async function optimizeImage(file: File): Promise<UploadAttachment> {
    const originalDataUrl = await readAsDataUrl(file);
    const img = await loadImage(originalDataUrl);
    const srcWidth = img.naturalWidth || img.width;
    const srcHeight = img.naturalHeight || img.height;
    const maxSide = Math.max(srcWidth, srcHeight);
    const scale = maxSide > MAX_IMAGE_SIDE_PX ? MAX_IMAGE_SIDE_PX / maxSide : 1;
    const width = Math.max(1, Math.round(srcWidth * scale));
    const height = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { name: file.name, mime: file.type || "image/*", dataUrl: originalDataUrl };
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
    return { name: imageNameAsJpeg(file.name), mime: "image/jpeg", dataUrl };
  }

  async function toAttachment(file: File): Promise<UploadAttachment> {
    const mime = normalizeAttachmentMime(file);
    if (mime.startsWith("image/")) return optimizeImage(file);
    if (isTextLikeMime(mime)) {
      const text = clipAttachmentText(await readAsText(file));
      return {
        name: file.name,
        mime,
        dataUrl: textToDataUrl(text, mime),
        text,
      };
    }
    return {
      name: file.name,
      mime,
      dataUrl: await readAsDataUrl(file),
    };
  }

  async function addAttachments(list: FileList | null) {
    if (!list || !list.length || busy) return;
    const files = [...list];
    if (files.length === 0) return;
    const remaining = MAX_PENDING_ATTACHMENTS - pendingAttachments.length;
    if (remaining <= 0) {
      if (picker) picker.value = "";
      return;
    }
    const loaded: UploadAttachment[] = [];
    for (const file of files.slice(0, remaining)) {
      loaded.push(await toAttachment(file));
    }
    pendingAttachments = [...pendingAttachments, ...loaded];
    if (picker) picker.value = "";
  }

  function clearAttachments() {
    pendingAttachments = [];
    if (picker) picker.value = "";
  }

  function classifyFailure(error: unknown): { message: string; retryable: boolean } {
    const raw = error instanceof Error ? error.message : "";
    const lower = raw.toLowerCase();
    if (
      /failed to fetch|network|econn|enotfound|backend unreachable|offline|502|503|504/.test(lower)
    ) {
      return {
        message: "Backend is unreachable right now. Check your backend service, then retry.",
        retryable: true,
      };
    }
    if (/timeout|timed out|etimedout/.test(lower)) {
      return {
        message: "The model timed out before responding. Retry in a few seconds.",
        retryable: true,
      };
    }
    if (/401|403|unauthorized|forbidden|api key|credential/.test(lower)) {
      return {
        message: "Model credentials were rejected. Check the assistant settings and try again.",
        retryable: false,
      };
    }
    if (raw.trim()) {
      return { message: raw, retryable: true };
    }
    return {
      message: "The assistant could not respond. Retry in a moment.",
      retryable: true,
    };
  }

  function serializeHistory(turns: Turn[]): { role: Turn["role"]; content: string }[] {
    return turns.map((t) => ({ role: t.role, content: t.content }));
  }

  async function send(text: string) {
    const content = text.trim();
    if ((!content && pendingAttachments.length === 0) || busy) return;
    errorText = null;
    canRetry = false;
    armedApproval = null;
    const attachments = [...pendingAttachments];
    const previousThread = thread;
    const turnIndex = previousThread.length;
    const userTurn: Turn = { role: "user", content, attachmentCount: attachments.length };
    thread = [...previousThread, userTurn];
    pendingRequest = { content, attachments, turnIndex };
    input = "";
    pendingAttachments = [];
    if (box) box.style.height = "auto";
    busy = true;
    scrollDown();
    try {
      const payload = [
        ...serializeHistory(previousThread),
        {
          role: "user",
          content,
          ...(attachments.length ? { attachments } : {}),
        },
      ];
      const res = await action<ChatResponse>("/chat", "POST", { messages: payload });
      thread = [...thread, { role: "assistant", content: res.reply, steps: res.steps, pendingActions: res.pendingActions }];
      pendingRequest = null;
    } catch (e) {
      const failure = classifyFailure(e);
      errorText = failure.message;
      canRetry = failure.retryable;
    } finally {
      busy = false;
      scrollDown();
    }
  }

  async function retryLast() {
    if (busy || !pendingRequest) return;
    errorText = null;
    canRetry = false;
    busy = true;
    scrollDown();
    const request = pendingRequest;
    try {
      const baseTurns = thread.slice(0, request.turnIndex);
      const payload = [
        ...serializeHistory(baseTurns),
        {
          role: "user",
          content: request.content,
          ...(request.attachments.length ? { attachments: request.attachments } : {}),
        },
      ];
      const res = await action<ChatResponse>("/chat", "POST", { messages: payload });
      const hasUserTurn = thread[request.turnIndex]?.role === "user";
      const nextThread = hasUserTurn
        ? thread
        : [
            ...baseTurns,
            {
              role: "user",
              content: request.content,
              attachmentCount: request.attachments.length,
            } satisfies Turn,
          ];
      thread = [
        ...nextThread,
        {
          role: "assistant",
          content: res.reply,
          steps: res.steps,
          pendingActions: res.pendingActions,
        },
      ];
      pendingRequest = null;
    } catch (e) {
      const failure = classifyFailure(e);
      errorText = failure.message;
      canRetry = failure.retryable;
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
    canRetry = false;
    input = "";
    pendingAttachments = [];
    pendingRequest = null;
    armedApproval = null;
  }

  function columns(rows: Record<string, unknown>[]): string[] {
    return rows.length ? Object.keys(rows[0]) : [];
  }
  function cell(v: unknown): string {
    if (typeof v === "number") return display(v);
    if (v === null || v === undefined) return "—";
    return String(v);
  }

  function escapeHtml(text: string): string {
    return text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function renderMarkdown(text: string): string {
    const escaped = escapeHtml(text);
    const linked = escaped.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    const code = linked.replace(/`([^`]+)`/g, "<code>$1</code>");
    const bold = code.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    const italic = bold.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    return italic
      .split(/\n{2,}/)
      .map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  function approvalPreview(change: PendingChange): {
    title: string;
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
  } | null {
    if (change.kind === "write_records") {
      const rows = (Array.isArray(change.rows) ? change.rows : []).filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === "object" && !Array.isArray(row),
      );
      if (!rows.length) return null;
      const preview = rows.slice(0, 5);
      const cols = [...new Set(preview.flatMap((row) => Object.keys(row)))];
      return { title: "Rows to add", columns: cols, rows: preview, total: rows.length };
    }
    if (change.kind === "delete_records" && change.where && typeof change.where === "object") {
      const where = change.where as Record<string, unknown>;
      const rows = Object.entries(where).map(([field, value]) => ({
        field,
        value: Array.isArray(value) ? value.join(", ") : value,
      }));
      if (!rows.length) return null;
      return { title: "Delete filters", columns: ["field", "value"], rows, total: rows.length };
    }
    return null;
  }

  function approvalMessage(result: unknown, fallback: string): string {
    if (result && typeof result === "object") {
      const msg = (result as { message?: unknown }).message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    }
    return fallback;
  }

  function isApprovalArmed(turnIndex: number, changeId: string): boolean {
    return armedApproval?.turnIndex === turnIndex && armedApproval?.changeId === changeId;
  }

  function armApproval(turnIndex: number, changeId: string) {
    armedApproval = { turnIndex, changeId };
  }

  function clearArmedApproval() {
    armedApproval = null;
  }

  function approvalRiskLabel(change: PendingChange): string {
    return change.kind === "delete_records" ? "Delete request" : "Write request";
  }

  function approvalConfirmCopy(change: PendingChange): string {
    if (change.kind === "delete_records") {
      return `This will delete records in ${change.target} that match the shown filters.`;
    }
    const total = Array.isArray(change.rows) ? change.rows.length : 0;
    return total > 0
      ? `This will add ${total} row${total === 1 ? "" : "s"} to ${change.target}.`
      : `This will write data to ${change.target}.`;
  }

  async function approveChange(turnIndex: number, change: PendingChange) {
    if (busy) return;
    busy = true;
    errorText = null;
    try {
      const res = await action<{ ok: boolean; result?: unknown; error?: string }>("/chat/approve", "POST", {
        change,
      });
      if (!res.ok) throw new Error(res.error ?? "Approval failed");
      thread = thread.map((turn, i) =>
        i === turnIndex
          ? { ...turn, pendingActions: (turn.pendingActions ?? []).filter((c) => c.id !== change.id) }
          : turn,
      );
      const applied = approvalMessage(
        res.result,
        change.kind === "write_records"
          ? `Approved and applied changes to ${change.target}.`
          : `Approved and scheduled deletion on ${change.target}.`,
      );
      thread = [...thread, { role: "assistant", content: applied }];
      await invalidateAll();
      armedApproval = null;
    } catch (e) {
      errorText = e instanceof Error ? e.message : "Could not approve change.";
    } finally {
      busy = false;
    }
  }

  function declineChange(turnIndex: number, changeId: string) {
    if (isApprovalArmed(turnIndex, changeId)) armedApproval = null;
    thread = thread.map((turn, i) =>
      i === turnIndex
        ? { ...turn, pendingActions: (turn.pendingActions ?? []).filter((c) => c.id !== changeId) }
        : turn,
    );
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
            One assistant over every module. Ask questions, or upload receipts, CSV files, and
            screenshots to extract entries and save them directly into your local data stack.
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
                {#if t.attachmentCount}
                  <p class="attach-summary">
                    {t.attachmentCount} file{t.attachmentCount === 1 ? "" : "s"} attached
                  </p>
                {/if}
              </div>
            {:else}
              <div class="turn bot">
                <p class="who">Assistant</p>
                <div class="reply">{@html renderMarkdown(t.content)}</div>
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
                {#if t.pendingActions && t.pendingActions.length}
                  <div class="approvals">
                    <p class="approvals-title">Awaiting approval</p>
                    {#each t.pendingActions as change, ci (change.id)}
                      <div class="approval" class:approval--danger={change.kind === "delete_records"}>
                        <div class="approval-text">
                          <strong>{change.summary}</strong>
                          <p>{change.kind === "write_records" ? "Import" : "Delete"} proposal for {change.target}</p>
                          <p class="approval-risk" class:approval-risk--danger={change.kind === "delete_records"}>
                            {approvalRiskLabel(change)}
                          </p>
                          {#if approvalPreview(change)}
                            {@const preview = approvalPreview(change) ?? { title: "", columns: [], rows: [], total: 0 }}
                            <details class="approval-preview">
                              <summary>
                                {preview.title} ({preview.rows.length} of {preview.total})
                              </summary>
                              <div class="approval-preview-wrap">
                                <table class="approval-preview-table">
                                  <thead>
                                    <tr>
                                      {#each preview.columns as c (c)}<th>{c}</th>{/each}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {#each preview.rows as row, ri (ri)}
                                      <tr>
                                        {#each preview.columns as c (c)}<td>{cell(row[c])}</td>{/each}
                                      </tr>
                                    {/each}
                                  </tbody>
                                </table>
                              </div>
                              {#if change.kind === "write_records" && preview.total > preview.rows.length}
                                <p class="approval-preview-more">
                                  +{preview.total - preview.rows.length} more row{preview.total - preview.rows.length === 1 ? "" : "s"}
                                </p>
                              {/if}
                            </details>
                          {/if}
                        </div>
                        <div class="approval-actions">
                          {#if isApprovalArmed(i, change.id)}
                            <p class="approval-confirm-copy">{approvalConfirmCopy(change)}</p>
                            {#if change.kind === "delete_records"}
                              <button class="btn btn--danger" type="button" onclick={() => approveChange(i, change)} disabled={busy}>
                                Confirm delete
                              </button>
                            {:else}
                              <button class="btn btn--primary" type="button" onclick={() => approveChange(i, change)} disabled={busy}>
                                Confirm import
                              </button>
                            {/if}
                            <button class="btn" type="button" onclick={clearArmedApproval} disabled={busy}>Cancel</button>
                          {:else}
                            {#if change.kind === "delete_records"}
                              <button class="btn btn--danger" type="button" onclick={() => armApproval(i, change.id)} disabled={busy}>
                                Review delete
                              </button>
                            {:else}
                              <button class="btn btn--primary" type="button" onclick={() => armApproval(i, change.id)} disabled={busy}>
                                Review import
                              </button>
                            {/if}
                            <button class="btn" type="button" onclick={() => declineChange(i, change.id)} disabled={busy}>
                              Decline
                            </button>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
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
              {#if canRetry && pendingRequest}
                <button class="btn btn--ghost retry" type="button" onclick={retryLast} disabled={busy}>
                  Retry last request
                </button>
              {/if}
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
      {#if pendingAttachments.length}
        <div class="pending-summary">
          <span>{pendingAttachments.length} file{pendingAttachments.length === 1 ? "" : "s"} selected</span>
          <button class="clear-pending" type="button" onclick={clearAttachments} disabled={busy}>
            Clear
          </button>
        </div>
      {/if}
      <details class="hint">
        <summary>Import help</summary>
        <p>
          Upload files (up to {MAX_PENDING_ATTACHMENTS} per prompt), ask for extraction, and the assistant
          can save or delete records in your local database when you explicitly request it. CSV and text
          files are parsed directly; images are sent to vision-capable models. Enter to send, Shift+Enter
          for a new line.
        </p>
      </details>
      <div class="field">
        <input
          bind:this={picker}
          class="picker"
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          onchange={(e) => addAttachments((e.currentTarget as HTMLInputElement).files)}
        />
        <button
          class="attach"
          type="button"
          onclick={() => picker?.click()}
          disabled={busy || pendingAttachments.length >= MAX_PENDING_ATTACHMENTS}
          aria-label="Upload files"
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
          disabled={busy || (!input.trim() && pendingAttachments.length === 0)}
          aria-label="Send message"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 11 12 6l5 5" /><path d="M12 6v12" />
          </svg>
        </button>
      </div>
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
  .reply {
    font-size: 15.5px;
    line-height: 1.62;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .reply :global(p) {
    margin: 0 0 10px;
  }
  .reply :global(p:last-child) {
    margin-bottom: 0;
  }
  .reply :global(code) {
    font-family: var(--font-mono);
    font-size: 0.9em;
    padding: 1px 5px;
    border-radius: 6px;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
  }
  .fail {
    margin: 0;
    color: var(--neg);
    font-size: 14.5px;
  }
  .retry {
    margin-top: var(--s3);
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
    background: color-mix(in oklab, var(--surface) 98%, var(--bg));
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
    margin: 0 0 var(--s2);
    max-width: 60ch;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: color-mix(in oklab, var(--surface) 92%, var(--bg));
    overflow: hidden;
  }
  .hint summary {
    list-style: none;
    cursor: pointer;
    padding: 7px 10px;
    font-size: 12px;
    line-height: 1.3;
    color: var(--text-faint);
    user-select: none;
  }
  .hint summary::-webkit-details-marker {
    display: none;
  }
  .hint summary::before {
    content: "›";
    display: inline-block;
    margin-right: 6px;
    transition: transform 140ms ease;
  }
  .hint[open] summary::before {
    transform: rotate(90deg);
  }
  .hint summary:hover {
    color: var(--text-dim);
  }
  .hint p {
    margin: 0;
    padding: 0 10px 9px 22px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--text-dim);
  }
  .attach-summary {
    margin: var(--s2) 0 0;
    font-size: 12px;
    color: var(--text-faint);
  }
  .approvals {
    margin-top: var(--s4);
    padding: var(--s4);
    border: 1px solid var(--border);
    border-radius: var(--r);
    background: var(--bg-sunken);
  }
  .approvals-title {
    margin: 0 0 var(--s3);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .approval {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s4);
    padding-top: var(--s3);
  }
  .approval--danger {
    background: color-mix(in oklab, var(--neg) 7%, var(--bg-sunken));
    border-radius: var(--r-sm);
    padding: var(--s3);
  }
  .approval + .approval {
    border-top: 1px solid var(--border);
  }
  .approval + .approval.approval--danger {
    margin-top: var(--s3);
  }
  .approval-text strong {
    display: block;
    font-size: 13.5px;
  }
  .approval-text p {
    margin: 4px 0 0;
    font-size: 12.5px;
    color: var(--text-dim);
  }
  .approval-risk {
    display: inline-flex;
    margin-top: var(--s2);
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--text-faint);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .approval-risk--danger {
    color: var(--neg);
    border-color: color-mix(in oklab, var(--neg) 38%, var(--border));
    background: color-mix(in oklab, var(--neg) 10%, var(--surface));
  }
  .approval-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--s2);
    flex: none;
    align-self: flex-start;
  }
  .approval-confirm-copy {
    margin: 0;
    max-width: 30ch;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-dim);
    text-align: right;
  }
  .btn--danger {
    background: color-mix(in oklab, var(--neg) 18%, var(--surface-2));
    border-color: color-mix(in oklab, var(--neg) 52%, var(--border));
    color: var(--text);
  }
  .btn--danger:hover {
    background: color-mix(in oklab, var(--neg) 26%, var(--surface-2));
    border-color: color-mix(in oklab, var(--neg) 62%, var(--border));
  }
  .approval-preview {
    margin-top: var(--s3);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
    overflow: hidden;
  }
  .approval-preview summary {
    list-style: none;
    cursor: pointer;
    padding: 7px 10px;
    font-size: 11.5px;
    color: var(--text-faint);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: var(--bg-sunken);
  }
  .approval-preview summary::-webkit-details-marker {
    display: none;
  }
  .approval-preview summary::before {
    content: "›";
    display: inline-block;
    margin-right: 6px;
    transition: transform 140ms ease;
  }
  .approval-preview[open] summary::before {
    transform: rotate(90deg);
  }
  .approval-preview-wrap {
    overflow-x: auto;
  }
  .approval-preview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;
  }
  .approval-preview-table th,
  .approval-preview-table td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    text-align: left;
    white-space: nowrap;
  }
  .approval-preview-table tbody tr:last-child td {
    border-bottom: none;
  }
  .approval-preview-more {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--text-faint);
  }
  .pending-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    margin: 0 0 var(--s2);
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-sunken);
    font-size: 12.5px;
    color: var(--text-dim);
  }
  .clear-pending {
    flex: none;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-dim);
    padding: 4px 10px;
    font-size: 11.5px;
  }
  .clear-pending:hover:not(:disabled) {
    border: 1px solid var(--border);
    color: var(--text);
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
