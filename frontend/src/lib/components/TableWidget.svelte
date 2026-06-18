<script lang="ts">
  import type { TableData } from "$lib/types";
  import { providerLogoUrl } from "$lib/branding";
  import { display } from "$lib/format";

  let { data }: { data: TableData; accent: string } = $props();

  const columns = $derived(data.columns ?? []);
  const rows = $derived(data.rows ?? []);
  const hasEdit = $derived(rows.some((r) => typeof r.edit_href === "string" && String(r.edit_href).length > 0));

  function align(col: TableData["columns"][number]) {
    return col.align ?? (col.format ? "right" : "left");
  }
  function cell(value: unknown, format?: string) {
    if (format === "provider" && typeof value === "string") return value;
    if (typeof value === "number") return display(value, format);
    return value ?? "—";
  }
</script>

<div class="tablewrap">
  <table>
    <thead>
      <tr>
        {#each columns as col}
          <th style="text-align: {align(col)}">{col.label}</th>
        {/each}
        {#if hasEdit}<th class="edit-col"></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, i (i)}
        <tr>
          {#each columns as col}
            <td
              class:mono={(!!col.format && col.format !== "provider") || align(col) === "right"}
              style="text-align: {align(col)}"
            >
              {#if col.format === "provider" && typeof row[col.key] === "string"}
                {@const provider = String(row[col.key])}
                {@const logo = providerLogoUrl(provider)}
                <span class="provider-cell">
                  {#if logo}<img class="provider-logo" src={logo} alt={`${provider} logo`} loading="lazy" />{/if}
                  <span>{provider}</span>
                </span>
              {:else}
                {cell(row[col.key], col.format)}
              {/if}
            </td>
          {/each}
          {#if hasEdit}
            <td class="edit-cell">
              {#if typeof row.edit_href === "string" && row.edit_href}
                <a class="edit-link" href={String(row.edit_href)} aria-label="Edit ride entry" title="Edit entry">
                  ✎
                </a>
              {/if}
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .tablewrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  th {
    color: var(--text-faint);
    font-weight: 600;
    font-size: 11px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 0 var(--s3) var(--s2);
    border-bottom: 1px solid var(--border-strong);
    white-space: nowrap;
  }
  td {
    padding: 9px var(--s3);
    border-bottom: 1px solid var(--border);
    color: var(--text-dim);
  }
  td.mono {
    font-family: var(--font-mono);
    font-size: 12.5px;
    color: var(--text);
  }
  .provider-cell {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .provider-logo {
    width: 16px;
    height: 16px;
    object-fit: contain;
    flex: none;
  }
  .edit-col {
    width: 36px;
  }
  .edit-cell {
    text-align: right;
  }
  .edit-link {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: 1px solid var(--border);
    color: var(--text-faint);
    text-decoration: none;
    font-size: 13px;
    line-height: 1;
  }
  .edit-link:hover {
    color: var(--text);
    border-color: var(--brand);
    background: var(--surface-2);
  }
  tbody tr:last-child td {
    border-bottom: none;
  }
  tbody tr {
    transition: background 120ms ease;
  }
  tbody tr:hover {
    background: var(--surface-2);
  }
</style>
