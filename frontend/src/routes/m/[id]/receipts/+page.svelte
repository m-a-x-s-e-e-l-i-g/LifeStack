<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import { action } from "$lib/api";
  import type { InboxReceiptKind } from "$lib/types";

  let { data }: { data: PageData } = $props();

  const moduleDetail = $derived(data.detail);
  const queue = $derived(data.inboxReview);
  const receipts = $derived(queue.receipts ?? []);

  let reviewBusyId = $state<string | null>(null);
  let reviewBulkBusy = $state(false);
  let reviewStatusMsg = $state<string | null>(null);

  function receiptKindLabel(kind: InboxReceiptKind): string {
    if (kind === "mobility") return "Ride";
    if (kind === "mobility_pass") return "Pass";
    if (kind === "food") return "Food";
    if (kind === "groceries") return "Grocery";
    if (kind === "parking") return "Parking";
    if (kind === "flights") return "Flight";
    return "Reservation";
  }

  async function approveReceipt(id: string) {
    reviewBusyId = id;
    reviewStatusMsg = null;
    try {
      await action("/inbox/receipts/approve", "POST", { id });
      await invalidateAll();
    } catch (e) {
      reviewStatusMsg = e instanceof Error ? e.message : "Failed to approve receipt";
    } finally {
      reviewBusyId = null;
    }
  }

  async function declineReceipt(id: string) {
    reviewBusyId = id;
    reviewStatusMsg = null;
    try {
      await action("/inbox/receipts/decline", "POST", { id });
      await invalidateAll();
    } catch (e) {
      reviewStatusMsg = e instanceof Error ? e.message : "Failed to decline receipt";
    } finally {
      reviewBusyId = null;
    }
  }

  async function bulkReview(actionKind: "approve" | "decline") {
    const ids = receipts.map((r) => r.id);
    if (!ids.length) return;
    reviewBulkBusy = true;
    reviewStatusMsg = null;
    try {
      await action(`/inbox/receipts/${actionKind}`, "POST", { ids });
      await invalidateAll();
    } catch (e) {
      reviewStatusMsg = e instanceof Error ? e.message : `Failed to ${actionKind} receipts`;
    } finally {
      reviewBulkBusy = false;
    }
  }
</script>

<svelte:head><title>LifeStack — Receipt review</title></svelte:head>

<div class="page" style="--accent: {moduleDetail.accent}">
  <header class="head">
    <div class="ident">
      <span class="badge">{moduleDetail.icon}</span>
      <div>
        <h1>Receipt review</h1>
        <p class="desc">Approve or decline staged inbox receipts before they reach module data.</p>
      </div>
    </div>
    <div class="actions">
      <a class="btn" href="/m/inbox">Back to receipts overview</a>
      <button class="btn btn--ghost" onclick={() => invalidateAll()} disabled={reviewBulkBusy || reviewBusyId !== null}>
        Refresh
      </button>
    </div>
  </header>

  <section class="panel review">
    <header class="review-head">
      <div class="review-counts">
        <span>{queue.totals.pending} pending</span>
        <span>{queue.totals.approved} approved</span>
        <span>{queue.totals.declined} declined</span>
      </div>
      <div class="review-tools">
        <button class="btn btn--primary" onclick={() => bulkReview("approve")} disabled={reviewBulkBusy || reviewBusyId !== null || receipts.length === 0}>
          {reviewBulkBusy ? "Saving…" : "Approve all shown"}
        </button>
        <button class="btn btn--ghost" onclick={() => bulkReview("decline")} disabled={reviewBulkBusy || reviewBusyId !== null || receipts.length === 0}>
          Decline all shown
        </button>
      </div>
    </header>

    {#if reviewStatusMsg}
      <p class="status">{reviewStatusMsg}</p>
    {/if}

    {#if receipts.length === 0}
      <p class="empty">No pending receipts.</p>
    {:else}
      <ul class="list">
        {#each receipts as receipt (receipt.id)}
          <li class="item">
            <div class="main">
              <div class="top">
                <strong>{receipt.summary}</strong>
                <span class="kind">{receiptKindLabel(receipt.kind)}</span>
              </div>
              <div class="meta">
                <span>{receipt.day}</span>
                <span>{receipt.amountLabel}</span>
              </div>
              {#if receipt.details}
                <p class="details">{receipt.details}</p>
              {/if}
              {#if receipt.emailExcerpt}
                <p class="preview-label">Email text preview</p>
                <p class="preview">{receipt.emailExcerpt}</p>
              {/if}
            </div>
            <div class="row-actions">
              <button
                class="btn btn--primary"
                onclick={() => approveReceipt(receipt.id)}
                disabled={reviewBulkBusy || reviewBusyId !== null}
              >
                Approve
              </button>
              <button
                class="btn btn--ghost"
                onclick={() => declineReceipt(receipt.id)}
                disabled={reviewBulkBusy || reviewBusyId !== null}
              >
                Decline
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
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
    display: inline-flex;
    gap: var(--s2);
    flex-wrap: wrap;
  }
  .review {
    padding: var(--s4);
  }
  .review-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--s3);
    flex-wrap: wrap;
    margin-bottom: var(--s3);
  }
  .review-counts {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .review-counts span {
    font-size: 11px;
    color: var(--text-faint);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 8px;
  }
  .review-tools {
    display: inline-flex;
    gap: var(--s2);
    flex-wrap: wrap;
  }
  .status {
    margin: 0 0 var(--s3);
    color: oklch(0.7 0.13 25);
    font-size: 12px;
  }
  .empty {
    margin: 0;
    color: var(--text-dim);
    font-size: 13px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s2);
  }
  .item {
    border: 1px solid var(--border);
    border-radius: var(--r);
    background: var(--surface-2);
    padding: var(--s3);
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--s3);
  }
  .main {
    min-width: 0;
  }
  .top {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
    margin-bottom: 2px;
  }
  .kind {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 7px;
  }
  .meta {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--s2);
    font-size: 12px;
    color: var(--text-dim);
  }
  .details {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--text-faint);
  }
  .preview-label {
    margin: 8px 0 2px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-faint);
  }
  .preview {
    margin: 0;
    font-size: 12px;
    color: var(--text-dim);
    line-height: 1.35;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    overflow: hidden;
  }
  .row-actions {
    display: inline-flex;
    gap: var(--s2);
    flex-wrap: wrap;
  }
  @media (max-width: 760px) {
    .item {
      flex-direction: column;
    }
  }
</style>
