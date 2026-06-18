<script lang="ts">
  import type { CardsData } from "$lib/types";
  import { providerLogoUrl } from "$lib/branding";
  import { display } from "$lib/format";

  let { data, accent }: { data: CardsData; accent: string } = $props();
</script>

<div class="cards" style="--accent: {accent}">
  {#each data.cards as card, i (card.label)}
    <article class="card" style="--delay: {i * 40}ms">
      <h4>
        {#if providerLogoUrl(card.label)}
          <img
            class="provider-logo"
            src={providerLogoUrl(card.label) ?? ""}
            alt={`${card.label} logo`}
            loading="lazy"
          />
        {/if}
        <span>{card.label}</span>
      </h4>
      <div class="big mono">{display(card.rides)} <span>rides</span></div>
      <div class="meta">
        <span>{display(card.distance_km, "number")} km</span>
        <span>{display(card.cost, "currency")}</span>
        {#if card.avg_cost !== undefined}<span>{display(card.avg_cost, "currency")} avg</span>{/if}
      </div>
      <div class="breakdown">
        <div><span>Bike</span><strong>{display(card.bike_rides ?? 0)} rides</strong><em>{display(card.bike_km ?? 0, "number")} km</em></div>
        <div><span>Scooter</span><strong>{display(card.scooter_rides ?? 0)} rides</strong><em>{display(card.scooter_km ?? 0, "number")} km</em></div>
        <div><span>Taxi</span><strong>{display(card.taxi_rides ?? 0)} rides</strong><em>{display(card.taxi_km ?? 0, "number")} km</em></div>
      </div>
    </article>
  {/each}
</div>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--s3);
  }
  .card {
    border: 1px solid var(--border);
    border-radius: var(--r);
    background: color-mix(in oklab, var(--accent) 7%, var(--surface));
    padding: var(--s4);
    animation: rise 480ms cubic-bezier(0.16, 1, 0.3, 1) both;
    animation-delay: var(--delay);
  }
  h4 {
    margin: 0 0 var(--s3);
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .provider-logo {
    width: 18px;
    height: 18px;
    object-fit: contain;
    flex: none;
  }
  .big {
    font-size: 1.7rem;
    line-height: 1;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
  .big span {
    font-size: 0.8rem;
    color: var(--text-faint);
    font-family: var(--font-body);
    margin-left: 4px;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin-top: var(--s3);
    font-size: 12px;
    color: var(--text-dim);
  }
  .meta span {
    padding: 4px 8px;
    border-radius: 999px;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
  }
  .breakdown {
    display: grid;
    gap: 6px;
    margin-top: var(--s4);
    font-size: 12px;
  }
  .breakdown div {
    display: grid;
    grid-template-columns: 68px 1fr auto;
    gap: 8px;
    align-items: baseline;
  }
  .breakdown span {
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
  }
  .breakdown strong {
    font-weight: 600;
    color: var(--text);
  }
  .breakdown em {
    color: var(--text-dim);
    font-style: normal;
    font-family: var(--font-mono);
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
