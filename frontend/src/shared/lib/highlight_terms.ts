// Search-module 1:1 mockup-search.html — frontend `<mark>` highlighter for
// the palette EmailHitRow subject/snippet.
//
// Why we need this even though the backend already emits FTS5 `snippet()`:
//   - SQLite snippet() only applies to the column passed as `colno` (we use
//     column 0 = `body_markdown`). The hit's subject + sender are NOT
//     re-highlighted by the backend, so the palette has to do it client-
//     side. Snippet bodies still come pre-marked from the SQL — those rows
//     skip this util and go through DOMPurify directly.
//   - The function is purely textual + tightly scoped to a known whitelist
//     (`<mark>` only) so it's safe to interpolate via dangerouslySetInnerHTML
//     when wrapped with DOMPurify on the caller side.
//
// Test surface lives in tests/shared/highlight_terms.test.ts.

const FTS5_OP_RE = /^(AND|OR|NOT|NEAR)$/i

/**
 * Extract the matchable terms from a user FTS5 query string. Strips wildcards
 * (`*`), quote markers (`"`), and FTS5 operators (AND / OR / NOT / NEAR) so
 * a query like `"redis timeout" AND notion*` yields `['redis', 'timeout',
 * 'notion']`. Returns an empty array when there's nothing usable.
 */
export function extractTerms(rawQuery: string): string[] {
  if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) return []
  // Strip quotes (treat phrase as multi-word) + wildcard suffix.
  const cleaned = rawQuery.replace(/["()]/g, ' ').replace(/\*/g, ' ')
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !FTS5_OP_RE.test(t))
}

// Regex escape — must precede the alternation so user-typed `.`/`?`/`(` etc.
// match literally.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Escape user text for safe HTML insertion. We re-emit `<mark>` ourselves
// after the replace pass; everything else gets entity-encoded.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Highlight `terms` inside `text` by wrapping matches in `<mark>...</mark>`.
 *
 * - Case-insensitive (mockup line 820+ wraps "Notion" in both subject and
 *   snippet regardless of capitalisation).
 * - CJK characters match directly — unicode61 tokenisation only affects FTS5
 *   indexing, here we're doing pure substring on Unicode codepoints.
 * - Returns an HTML string with everything else entity-encoded, safe to pass
 *   to DOMPurify with `ALLOWED_TAGS: ['mark']`.
 * - Empty terms / empty text → returns the entity-encoded text unchanged
 *   (so a row with no usable query still renders correctly).
 */
export function highlightTerms(
  text: string | null | undefined,
  terms: ReadonlyArray<string>
): string {
  if (!text) return ''
  const escaped = escapeHtml(text)
  if (terms.length === 0) return escaped

  // De-dupe + sort by length DESC so longer matches win over shorter ones
  // that share a prefix (e.g. "notion" should match before "no" if both are
  // somehow in the term list).
  const unique = Array.from(new Set(terms.filter((t) => t.length > 0)))
  if (unique.length === 0) return escaped
  unique.sort((a, b) => b.length - a.length)

  // Build one combined regex — single pass over the string. Each alt is
  // escaped so user-typed regex metacharacters match literally.
  const pattern = unique.map(escapeRegex).join('|')
  const re = new RegExp(`(${pattern})`, 'gi')
  return escaped.replace(re, '<mark>$1</mark>')
}
