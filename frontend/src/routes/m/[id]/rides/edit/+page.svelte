<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { action } from "$lib/api";

  const q = $derived($page.url.searchParams);
  const moduleId = $derived($page.params.id);

  const original = $derived({
    day: q.get("day") ?? "",
    started_at: q.get("started_at") ?? "",
    provider: q.get("provider") ?? "",
    type: q.get("type") ?? "",
    distance_km: Number(q.get("distance_km") ?? 0),
    duration_min: Number(q.get("duration_min") ?? 0),
    cost: Number(q.get("cost") ?? 0),
    cost_currency: (q.get("cost_currency") ?? "EUR").toUpperCase(),
  });

  let day = $state("");
  let startedAt = $state("");
  let provider = $state("");
  let rideType = $state("");
  let distanceKm = $state(0);
  let durationMin = $state(0);
  let cost = $state(0);
  let costCurrency = $state("EUR");
  let busy = $state(false);
  let status = $state<string | null>(null);

  $effect(() => {
    day = original.day;
    startedAt = original.started_at ? original.started_at.replace(" ", "T").slice(0, 16) : "";
    provider = original.provider;
    rideType = original.type;
    distanceKm = original.distance_km;
    durationMin = original.duration_min;
    cost = original.cost;
    costCurrency = original.cost_currency;
  });

  async function save() {
    if (moduleId !== "mobility") return;
    busy = true;
    status = null;
    try {
      // Derive day from started_at
      const newDay = startedAt ? startedAt.slice(0, 10) : day;
      
      // If the date changed, we need to delete the old row and insert a new one
      // because 'day' is a key column in ClickHouse (can't be updated)
      if (newDay !== original.day) {
        // For now, prevent date changes - users should edit the timestamp instead
        status = "Cannot change the date. Edit the timestamp to change the time of day.";
        return;
      }
      
      await action<{ ok: boolean; message?: string }>(`/modules/mobility/rides/update`, "PUT", {
        original,
        patch: {
          day: newDay,
          started_at: startedAt ? startedAt.replace("T", " ") + ":00" : "",
          provider,
          type: rideType,
          distance_km: Number(distanceKm),
          duration_min: Math.round(Number(durationMin)),
          cost: Number(cost),
          cost_currency: costCurrency.toUpperCase(),
        },
      });
      await goto("/m/mobility");
    } catch (e) {
      status = e instanceof Error ? e.message : "Failed to update ride.";
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>LifeStack — Edit ride</title></svelte:head>

{#if moduleId !== "mobility"}
  <section class="panel form-wrap">
    <h1>Ride editing is only available for Mobility</h1>
  </section>
{:else}
  <section class="panel form-wrap">
    <header>
      <h1>Edit ride</h1>
      <p>Adjust provider, type, distance, duration, cost, and timestamp.</p>
    </header>

    <form
      onsubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        <span>Timestamp</span>
        <input type="datetime-local" bind:value={startedAt} required />
      </label>
      <label>
        <span>Provider</span>
        <input type="text" bind:value={provider} required />
      </label>
      <label>
        <span>Type</span>
        <select bind:value={rideType}>
          <option value="taxi">taxi</option>
          <option value="scooter">scooter</option>
          <option value="bike">bike</option>
        </select>
      </label>
      <label>
        <span>Distance (km)</span>
        <input type="number" min="0" step="0.01" bind:value={distanceKm} required />
      </label>
      <label>
        <span>Duration (min)</span>
        <input type="number" min="0" step="1" bind:value={durationMin} required />
      </label>
      <label>
        <span>Cost (original)</span>
        <input type="number" min="0" step="0.01" bind:value={cost} required />
      </label>
      <label>
        <span>Currency</span>
        <input type="text" minlength="3" maxlength="3" bind:value={costCurrency} required />
      </label>

      {#if status}<p class="status">{status}</p>{/if}

      <div class="actions">
        <a class="btn" href="/m/mobility">Cancel</a>
        <button class="btn btn--primary" type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save changes"}
        </button>
      </div>
    </form>
  </section>
{/if}

<style>
  .form-wrap {
    max-width: 720px;
    padding: var(--s5);
    display: grid;
    gap: var(--s4);
  }
  header p {
    margin: 4px 0 0;
    color: var(--text-dim);
  }
  form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s3);
  }
  label {
    display: grid;
    gap: 6px;
  }
  label span {
    font-size: 12px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  input,
  select {
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--surface);
    color: var(--text);
    padding: 10px 12px;
    font: inherit;
  }
  .status {
    margin: 0;
    color: var(--neg);
    grid-column: 1 / -1;
  }
  .actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: var(--s2);
    margin-top: var(--s2);
  }
  @media (max-width: 760px) {
    form {
      grid-template-columns: 1fr;
    }
  }
</style>
