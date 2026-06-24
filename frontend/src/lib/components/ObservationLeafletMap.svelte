<script lang="ts">
  import { onMount } from "svelte";
  import "leaflet/dist/leaflet.css";

  export interface ObservationMapPoint {
    lat: number;
    lon: number;
    species: string;
    country: string;
    date: string;
  }

  let { points, accent }: { points: ObservationMapPoint[]; accent: string } = $props();

  let host: HTMLDivElement | null = $state(null);
  let error = $state<string | null>(null);

  function esc(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  onMount(() => {
    let map: import("leaflet").Map | null = null;
    let disposed = false;

    async function init() {
      if (!host) return;
      try {
        const L = await import("leaflet");
        if (disposed || !host) return;

        map = L.map(host, {
          zoomControl: true,
          scrollWheelZoom: false,
          worldCopyJump: true,
          attributionControl: true,
        });

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors",
        }).addTo(map);

        const bounds = L.latLngBounds([]);
        const markerPoints = points.slice(0, 2500);

        for (const point of markerPoints) {
          if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
          const marker = L.circleMarker([point.lat, point.lon], {
            radius: 4.5,
            stroke: true,
            weight: 1,
            color: "oklch(0.2 0 0 / 0.32)",
            fillColor: accent,
            fillOpacity: 0.74,
          });
          marker.bindPopup(
            `<strong>${esc(point.species)}</strong><br>${esc(point.country)}<br>${esc(point.date)}`,
          );
          marker.addTo(map);
          bounds.extend([point.lat, point.lon]);
        }

        if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
        else map.setView([20, 0], 2);
      } catch (e) {
        error = e instanceof Error ? e.message : "Could not render map";
      }
    }

    void init();

    return () => {
      disposed = true;
      map?.remove();
      map = null;
    };
  });
</script>

<div class="map-frame" style="--accent: {accent}">
  {#if error}
    <p class="map-error">{error}</p>
  {:else}
    <div class="map" bind:this={host}></div>
  {/if}
</div>

<style>
  .map-frame {
    border: 1px solid color-mix(in oklab, var(--accent) 36%, var(--border));
    border-radius: var(--r);
    overflow: hidden;
    background: var(--surface);
    min-height: 320px;
  }
  .map {
    width: 100%;
    min-height: 320px;
    height: clamp(320px, 44vh, 520px);
  }
  .map-error {
    margin: 0;
    padding: var(--s5);
    color: var(--neg);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .map-frame :global(.leaflet-container) {
    font-family: var(--font-body);
    background: var(--bg-sunken);
  }
  .map-frame :global(.leaflet-control-zoom a) {
    color: var(--text);
    background: var(--surface);
    border-color: var(--border) !important;
  }
  .map-frame :global(.leaflet-control-attribution) {
    background: color-mix(in oklab, var(--surface) 92%, transparent);
    color: var(--text-faint);
    font-size: 10px;
  }
</style>
