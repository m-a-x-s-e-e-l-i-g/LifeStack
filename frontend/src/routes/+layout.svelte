<script lang="ts">
  import "@fontsource-variable/inter";
  import "@fontsource-variable/space-grotesk";
  import "@fontsource-variable/jetbrains-mono";
  import "../app.css";
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import type { LayoutData } from "./$types";

  let { data, children }: { data: LayoutData; children: import("svelte").Snippet } = $props();

  let theme = $state<"dark" | "light">("dark");
  let navOpen = $state(false);

  onMount(() => {
    const saved = localStorage.getItem("lifestack-theme");
    if (saved === "light" || saved === "dark") {
      theme = saved;
      document.documentElement.dataset.theme = saved;
    }
  });

  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("lifestack-theme", theme);
  }

  const path = $derived($page.url.pathname);
  const onChat = $derived(path === "/");
  const onOverview = $derived(path === "/overview");
  const onSettings = $derived(path.startsWith("/settings"));
</script>

<div class="shell">
  <aside class="rail" class:open={navOpen}>
    <a href="/" class="brand" onclick={() => (navOpen = false)}>
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="6" y="17" width="5" height="9" rx="1.5" fill="var(--neg)" />
        <rect x="13.5" y="11" width="5" height="15" rx="1.5" fill="oklch(0.8 0.15 100)" />
        <rect x="21" y="6" width="5" height="20" rx="1.5" fill="var(--brand)" />
      </svg>
      <span>LifeStack</span>
    </a>

    <nav>
      <a href="/" class="item" class:active={onChat} onclick={() => (navOpen = false)}>
        <span class="glyph">✦</span>
        <span class="label">Assistant</span>
      </a>
      <a href="/overview" class="item" class:active={onOverview} onclick={() => (navOpen = false)}>
        <span class="glyph">◆</span>
        <span class="label">Overview</span>
      </a>

      <p class="group">Modules</p>
      {#each data.modules as m (m.id)}
        <a
          href="/m/{m.id}"
          class="item"
          class:active={path === `/m/${m.id}`}
          class:dim={!m.enabled}
          style="--dot: {m.accent}"
          onclick={() => (navOpen = false)}
        >
          <span class="dot" aria-hidden="true"></span>
          <span class="label">{m.name}</span>
          {#if !m.enabled}<span class="off">off</span>{/if}
        </a>
      {/each}
    </nav>

    <div class="rail-foot">
      <a href="/settings" class="item" class:active={onSettings} onclick={() => (navOpen = false)}>
        <span class="glyph">⚙</span>
        <span class="label">Settings</span>
      </a>
      <button class="item theme" onclick={toggleTheme} aria-label="Toggle theme">
        <span class="glyph">{theme === "dark" ? "☾" : "☀"}</span>
        <span class="label">{theme === "dark" ? "Dark" : "Light"}</span>
      </button>
    </div>
  </aside>

  <button class="scrim" class:show={navOpen} onclick={() => (navOpen = false)} aria-label="Close navigation"></button>

  <header class="topbar">
    <button class="burger" onclick={() => (navOpen = !navOpen)} aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
    <a href="/" class="topbrand">LifeStack</a>
  </header>

  <main>
    {#if !data.backendUp}
      <div class="offline">
        <strong>Backend unreachable.</strong> The dashboard is up, but the aggregation service at the
        backend URL is not responding yet. It may still be starting.
      </div>
    {/if}
    {@render children()}
  </main>
</div>

<style>
  .shell {
    min-height: 100vh;
  }

  .rail {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--rail);
    display: flex;
    flex-direction: column;
    gap: var(--s2);
    padding: var(--s5) var(--s3) var(--s4);
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
    z-index: 40;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: 0 var(--s3) var(--s5);
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 19px;
    letter-spacing: -0.02em;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    flex: 1;
  }

  .group {
    margin: var(--s4) var(--s3) var(--s2);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--s3);
    padding: 9px var(--s3);
    border-radius: var(--r-sm);
    color: var(--text-dim);
    font-weight: 500;
    font-size: 14.5px;
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
    transition:
      color 140ms ease,
      background 140ms ease;
  }
  .item:hover {
    color: var(--text);
    background: var(--surface);
  }
  .item.active {
    color: var(--text);
    background: var(--surface-2);
  }
  .item.dim .label {
    color: var(--text-faint);
  }
  .label {
    flex: 1;
  }

  .glyph {
    width: 18px;
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
  }
  .item.active .glyph {
    color: var(--brand);
  }

  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--dot);
    margin: 0 4.5px;
    transition: transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .item.active .dot,
  .item:hover .dot {
    transform: scale(1.35);
  }
  .item.dim .dot {
    opacity: 0.4;
  }

  .off {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-faint);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 1px 5px;
  }

  .rail-foot {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: var(--s2);
    border-top: 1px solid var(--border);
  }
  .theme {
    cursor: pointer;
  }

  .topbar,
  .scrim {
    display: none;
  }

  main {
    margin-left: var(--rail);
    padding: var(--s6) var(--s6) var(--s7);
    max-width: 1280px;
  }

  .offline {
    background: color-mix(in oklab, var(--neg) 12%, var(--surface));
    border: 1px solid color-mix(in oklab, var(--neg) 35%, var(--border));
    border-radius: var(--r);
    padding: var(--s3) var(--s4);
    margin-bottom: var(--s5);
    font-size: 14px;
    color: var(--text);
  }
  .offline strong {
    color: var(--neg);
  }

  @media (max-width: 900px) {
    .rail {
      transform: translateX(-100%);
      transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: var(--shadow);
    }
    .rail.open {
      transform: translateX(0);
    }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 30;
      border: none;
      background: oklch(0.1 0.01 70 / 0.5);
      opacity: 0;
      pointer-events: none;
      transition: opacity 200ms ease;
    }
    .scrim.show {
      opacity: 1;
      pointer-events: auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      gap: var(--s3);
      position: sticky;
      top: 0;
      z-index: 20;
      padding: var(--s3) var(--s4);
      background: color-mix(in oklab, var(--bg) 88%, transparent);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
    }
    .topbrand {
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 17px;
    }
    .burger {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: none;
      border: none;
      padding: 4px;
    }
    .burger span {
      width: 20px;
      height: 2px;
      border-radius: 2px;
      background: var(--text);
    }
    main {
      margin-left: 0;
      padding: var(--s5) var(--s4) var(--s7);
    }
  }
</style>
