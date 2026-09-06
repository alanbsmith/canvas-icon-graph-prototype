// This file builds a single, static HTML file (output/report.html) that a
// human can open directly in a web browser (no server needed) to eyeball
// the tagging results: each icon's picture, side by side with its old tags
// and the new ones the vision model generated.

import type { IconTaggingRecord } from './types.ts';

/**
 * Escapes text so it's safe to drop into HTML. Without this, an icon name
 * or a generated tag containing characters like `<` or `&` could break the
 * page's structure or (in the worst case) let arbitrary HTML/script run --
 * this matters here because the tag TEXT comes from a language model's
 * output, which we should treat as untrusted content, not something we
 * fully control.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders a list of strings as an HTML bullet list, or a placeholder if empty. */
function renderList(items: string[]): string {
  if (items.length === 0) {
    return '<em>(none)</em>';
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

/** Renders one icon's row in the report table. */
function renderRow(record: IconTaggingRecord): string {
  const failed = record.generated === null;

  const generatedCell = record.generated
    ? `
      <div><strong>Tags:</strong>${renderList(record.generated.tags)}</div>
      <div><strong>Synonyms:</strong>${renderList(record.generated.synonyms)}</div>
      <div><strong>Use cases:</strong>${renderList(record.generated.useCases)}</div>
      <div><strong>Description:</strong> ${escapeHtml(record.generated.shortDescription)}</div>
    `
    : `
      <p><strong>⚠️ Validation failed:</strong> ${escapeHtml(record.validationError ?? 'unknown error')}</p>
      <details>
        <summary>Raw model response</summary>
        <pre>${escapeHtml(record.rawModelResponse)}</pre>
      </details>
    `;

  return `
    <tr class="${failed ? 'failed' : ''}">
      <td><img src="${escapeHtml(record.imagePath)}" alt="${escapeHtml(record.name)}" width="96" height="96"></td>
      <td>
        <strong>${escapeHtml(record.name)}</strong><br>
        <span class="category">${escapeHtml(record.category)}</span>
      </td>
      <td>${renderList(record.existingTags)}</td>
      <td>${generatedCell}</td>
    </tr>
  `;
}

/**
 * Builds the full HTML page contents for output/report.html.
 *
 * This is plain HTML + a small amount of inline CSS -- no build step, no
 * framework, just a static file you can double-click or open with
 * `open output/report.html`.
 */
export function buildReportHtml(records: IconTaggingRecord[]): string {
  const failedCount = records.filter((r) => r.generated === null).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Icon Tagging Report</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 0.75rem; vertical-align: top; text-align: left; }
  th { background: #f5f5f5; }
  tr.failed { background: #fff4f4; }
  img { display: block; background: white; border: 1px solid #eee; }
  .category { color: #666; font-size: 0.85em; }
  ul { margin: 0.25rem 0; padding-left: 1.25rem; }
  pre { white-space: pre-wrap; word-break: break-word; background: #f7f7f7; padding: 0.5rem; }
</style>
</head>
<body>
  <h1>Icon Tagging Report</h1>
  <p>${records.length} icons processed, ${failedCount} failed validation.</p>
  <table>
    <thead>
      <tr>
        <th>Image</th>
        <th>Icon</th>
        <th>Existing tags</th>
        <th>Generated tags</th>
      </tr>
    </thead>
    <tbody>
      ${records.map(renderRow).join('')}
    </tbody>
  </table>
</body>
</html>`;
}
