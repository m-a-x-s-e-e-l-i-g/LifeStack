<script lang="ts">
  import type { TableData } from "$lib/types";
  import { display } from "$lib/format";

  let { data }: { data: TableData; accent: string } = $props();

  const columns = $derived(data.columns ?? []);
  const rows = $derived(data.rows ?? []);

  function align(col: TableData["columns"][number]) {
    return col.align ?? (col.format ? "right" : "left");
  }
  function cell(value: unknown, format?: string) {
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
      </tr>
    </thead>
    <tbody>
      {#each rows as row, i (i)}
        <tr>
          {#each columns as col}
            <td
              class:mono={col.format || align(col) === "right"}
              style="text-align: {align(col)}">{cell(row[col.key], col.format)}</td
            >
          {/each}
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
