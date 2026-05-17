// FTS5 query normaliser. CLAUDE.md "Phase 3 FTS5 全文搜索 § 中文搜索注意":
// SQLite unicode61 tokenises consecutive CJK as a single opaque token, so a
// bare "产品" misses the token "本周产品评审". Appending `*` to the last
// whitespace-separated token enables prefix search and gives the intended
// substring-style match. English / mixed queries pass through untouched.
//
// The normaliser deliberately doesn't touch queries that already contain
// FTS5 syntax (explicit `*`, quoted phrase, AND/OR/NOT/NEAR), since the
// user clearly knows what they want and our heuristic could break it.
//
// Exported as a separate module so it has its own home (react-refresh
// `only-export-components` doesn't allow non-component exports in
// component files) and can be unit-tested directly.

const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/
const FTS5_OP_RE = /\b(AND|OR|NOT|NEAR)\b/i
const HAS_WILDCARD_RE = /[*"]/

export function normalizeFtsQuery(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  if (HAS_WILDCARD_RE.test(trimmed)) return trimmed
  if (FTS5_OP_RE.test(trimmed)) return trimmed
  if (!CJK_RE.test(trimmed)) return trimmed
  const tokens = trimmed.split(/\s+/)
  const last = tokens[tokens.length - 1] ?? ''
  if (last.length > 0 && CJK_RE.test(last.charAt(last.length - 1))) {
    tokens[tokens.length - 1] = `${last}*`
  }
  return tokens.join(' ')
}
