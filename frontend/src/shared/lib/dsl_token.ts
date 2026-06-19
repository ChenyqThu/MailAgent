// G-B3 — facet chips toggle helper. Pure string ops on the ⌘K search query.
//
// A "DSL token" is one whitespace-delimited unit of the Search Query DSL
// (docs/reference/search/search-query-syntax.md), e.g. `is:unread`,
// `has:attachment`, `in:收件箱`, `in:"Sent Items"`. Toggling = add the token
// (space-separated append) if absent, remove it if present. Idempotent.
//
// Word-boundary discipline: the token must match a *complete* whitespace
// unit — `is:unread` must NOT be removed from `is:unreadx` (substring) nor
// from a different token that merely contains it. We split on whitespace and
// compare units verbatim so substrings can never false-match.

/** Split a query into whitespace-delimited units, treating a double-quoted
 *  segment as part of a single unit so `in:"Sent Items"` stays whole (the DSL
 *  allows quoted values that contain spaces). Collapses runs of space. */
function splitUnits(query: string): string[] {
  const units: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of query) {
    if (ch === '"') {
      inQuote = !inQuote
      cur += ch
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (cur.length > 0) {
        units.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur.length > 0) units.push(cur)
  return units
}

/**
 * Toggle a DSL token in the query string.
 * - present (as a full whitespace unit) → remove every occurrence
 * - absent → append (space-separated) to the end
 * - trims surrounding whitespace; returns '' when the result is empty
 */
export function toggleDslToken(query: string, token: string): string {
  const tok = token.trim()
  if (tok.length === 0) return query.trim()
  const units = splitUnits(query)
  const idx = units.indexOf(tok)
  if (idx >= 0) {
    // Remove every exact-match unit (idempotent even if duplicated).
    const next = units.filter((u) => u !== tok)
    return next.join(' ')
  }
  units.push(tok)
  return units.join(' ')
}

/** Whether the query currently contains the token as a complete unit. */
export function hasDslToken(query: string, token: string): boolean {
  const tok = token.trim()
  if (tok.length === 0) return false
  return splitUnits(query).includes(tok)
}
