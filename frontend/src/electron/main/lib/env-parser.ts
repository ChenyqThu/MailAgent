// Sprint 18 — line-level `.env` parser preserving comments / blank lines /
// unmanaged keys.
//
// Why a custom parser instead of `dotenv.parse + serialize`:
//   - `dotenv.parse` returns `Record<string,string>` and erases everything
//     else — comments, blank lines, ordering, the original quoting style.
//     Writing it back round-trips like a meat grinder; users lose all the
//     " — Notifications" banners and the `# 飞书机器人` annotation they
//     spent time writing.
//   - We need `mergeEnv(parsed, {NOTION_TOKEN: 'new'})` to touch ONE line
//     and leave everything else byte-identical. That's only possible if we
//     keep the raw line array.
//
// Parsing rules:
//   - kv line: `^(\s*)([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*(#.*)?$`
//   - kv_commented (preserves "disabled" keys so toggling them back keeps
//     ordering): `^(\s*)#\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$`
//   - comment line: any other `^\s*#`
//   - blank line: `^\s*$`
//
// Writing rules (mergeEnv):
//   - `null` value comments out an active kv line (we prepend `# ` keeping
//     the same key=value tail, so a future write can un-comment it).
//   - String value: if active kv exists, replace the value portion only,
//     preserving leading whitespace + trailing inline comment. If only a
//     commented kv exists, un-comment + set. If neither exists, append a
//     new line after the last managed line (or at EOF).
//   - Quoting on write: any value containing whitespace, `#`, `=`, or `\n`
//     gets double-quoted; embedded `"` is escaped as `\"`. Otherwise the
//     value is emitted bare. Single-quote input is preserved on round-trip.

import { MANAGED_ENV_KEY_SET } from './env-keys'

export type EnvLine =
  | { kind: 'comment'; raw: string }
  | { kind: 'blank'; raw: string }
  | {
      kind: 'kv'
      key: string
      value: string
      indent: string
      trailingComment: string | null
      raw: string
    }
  | { kind: 'kv_commented'; key: string; value: string; raw: string }

export interface EnvParsed {
  lines: EnvLine[]
  /** key → first active kv line index */
  index: Map<string, number>
  /** key → first commented-out kv line index (no active kv exists for this key) */
  commentedIndex: Map<string, number>
  /** trailing newline preserved on round-trip (most `.env` files end with one). */
  trailingNewline: boolean
}

// Active kv match split into two passes:
//   1. KV_QUOTED_RE — value is a fully matched "..." or '...' string. # inside
//      the quotes is part of the value, NOT a trailing comment.
//   2. KV_UNQUOTED_RE — value is bare; the first `#` (with optional whitespace
//      in front) starts a trailing inline comment, which we preserve verbatim
//      so the round-trip keeps the user's annotations.
const KV_QUOTED_RE =
  /^(\s*)([A-Z_][A-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(#.*)?$/
const KV_UNQUOTED_RE = /^(\s*)([A-Z_][A-Z0-9_]*)\s*=\s*([^#]*?)\s*(#.*)?$/
const KV_COMMENTED_RE = /^(\s*)#\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/

/** Strip a surrounding pair of quotes (only if both sides match) and unescape
 *  `\"` inside the bare value. Mirrors python-dotenv's `parse_value`. */
function unquote(raw: string): string {
  const t = raw.trim()
  if (t.length === 0) return ''
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1)
  }
  return t
}

/** Quote a value if it contains characters that break shell-like parsing. */
function maybeQuote(value: string): string {
  if (value.length === 0) return ''
  if (/[\s#"=]|^['"]/.test(value) || value.includes('\n')) {
    return `"${value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
  }
  return value
}

export function parseEnv(text: string): EnvParsed {
  const trailingNewline = text.endsWith('\n')
  const body = trailingNewline ? text.slice(0, -1) : text
  const rawLines = body.split('\n')
  const lines: EnvLine[] = []
  const index = new Map<string, number>()
  const commentedIndex = new Map<string, number>()

  rawLines.forEach((raw, i) => {
    const trimmed = raw.trim()

    if (trimmed.length === 0) {
      lines.push({ kind: 'blank', raw })
      return
    }

    // Active kv? Match BEFORE comment so `# FOO=bar` doesn't get mistaken
    // for an active assignment. Try quoted-value form first — a "...#..."
    // value must NOT be parsed as bare + trailing-comment.
    if (!trimmed.startsWith('#')) {
      const mQ = raw.match(KV_QUOTED_RE)
      if (mQ) {
        const [, indent, key, rawValue, trailing] = mQ
        lines.push({
          kind: 'kv',
          key,
          value: unquote(rawValue),
          indent,
          trailingComment: trailing ?? null,
          raw
        })
        if (!index.has(key)) index.set(key, i)
        return
      }
      const mU = raw.match(KV_UNQUOTED_RE)
      if (mU) {
        const [, indent, key, rawValue, trailing] = mU
        lines.push({
          kind: 'kv',
          key,
          value: unquote(rawValue),
          indent,
          trailingComment: trailing ?? null,
          raw
        })
        if (!index.has(key)) index.set(key, i)
        return
      }
    }

    // Commented-out kv?
    if (trimmed.startsWith('#')) {
      const m = raw.match(KV_COMMENTED_RE)
      if (m) {
        const [, , key, rawValue] = m
        lines.push({ kind: 'kv_commented', key, value: unquote(rawValue), raw })
        if (!index.has(key) && !commentedIndex.has(key)) commentedIndex.set(key, i)
        return
      }
      lines.push({ kind: 'comment', raw })
      return
    }

    // Unparseable line (shouldn't happen on a sane .env) — treat as comment
    // so we don't lose it on serialize.
    lines.push({ kind: 'comment', raw })
  })

  return { lines, index, commentedIndex, trailingNewline }
}

export function serializeEnv(parsed: EnvParsed): string {
  const body = parsed.lines.map((l) => l.raw).join('\n')
  return parsed.trailingNewline ? body + '\n' : body
}

/** Build the canonical raw form of an active kv line. */
function makeKvRaw(
  key: string,
  value: string,
  indent = '',
  trailingComment: string | null = null
): string {
  const tail = trailingComment ? '  ' + trailingComment : ''
  return `${indent}${key}=${maybeQuote(value)}${tail}`
}

/** Apply `patch` to a parsed snapshot. Returns a NEW EnvParsed (no mutation of
 *  the input). Throws `Error & { code: 'E_INVALID_KEY' }` if any key in the
 *  patch isn't whitelisted. */
export function mergeEnv(parsed: EnvParsed, patch: Record<string, string | null>): EnvParsed {
  for (const key of Object.keys(patch)) {
    if (!MANAGED_ENV_KEY_SET.has(key)) {
      const err = new Error(
        `env-parser: refusing to write non-managed key "${key}". Add it to MANAGED_ENV_KEYS first.`
      ) as Error & { code: string }
      err.code = 'E_INVALID_KEY'
      throw err
    }
  }

  // Shallow copy lines so we can splice.
  const lines: EnvLine[] = parsed.lines.slice()
  const index = new Map(parsed.index)
  const commentedIndex = new Map(parsed.commentedIndex)

  for (const [key, value] of Object.entries(patch)) {
    const activeIdx = index.get(key)
    const commentedIdx = commentedIndex.get(key)

    if (value === null) {
      // Comment out the active line. Preserves the key so a future write can
      // un-comment via the commentedIndex branch.
      if (activeIdx !== undefined) {
        const cur = lines[activeIdx] as Extract<EnvLine, { kind: 'kv' }>
        const commentedRaw = `# ${makeKvRaw(key, cur.value, cur.indent, cur.trailingComment)}`
        lines[activeIdx] = { kind: 'kv_commented', key, value: cur.value, raw: commentedRaw }
        index.delete(key)
        commentedIndex.set(key, activeIdx)
      }
      // No active line → already absent, nothing to do.
      continue
    }

    if (activeIdx !== undefined) {
      const cur = lines[activeIdx] as Extract<EnvLine, { kind: 'kv' }>
      const newRaw = makeKvRaw(key, value, cur.indent, cur.trailingComment)
      lines[activeIdx] = {
        kind: 'kv',
        key,
        value,
        indent: cur.indent,
        trailingComment: cur.trailingComment,
        raw: newRaw
      }
      continue
    }

    if (commentedIdx !== undefined) {
      // Un-comment + set new value. We DON'T preserve any inline trailing
      // comment that the commented-out form might have had — the kv_commented
      // parser dropped that, and reconstructing it would surprise the user.
      const newRaw = makeKvRaw(key, value)
      lines[commentedIdx] = {
        kind: 'kv',
        key,
        value,
        indent: '',
        trailingComment: null,
        raw: newRaw
      }
      index.set(key, commentedIdx)
      commentedIndex.delete(key)
      continue
    }

    // Append a new line at EOF. We don't try to be clever about which
    // section banner to slot under — picking the wrong one is worse than
    // letting the user move it manually.
    const newRaw = makeKvRaw(key, value)
    lines.push({
      kind: 'kv',
      key,
      value,
      indent: '',
      trailingComment: null,
      raw: newRaw
    })
    index.set(key, lines.length - 1)
  }

  return { lines, index, commentedIndex, trailingNewline: parsed.trailingNewline }
}

/** Convenience: snapshot the active key/value pairs as a plain object. */
export function toRecord(parsed: EnvParsed): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, idx] of parsed.index.entries()) {
    const line = parsed.lines[idx]
    if (line.kind === 'kv') out[key] = line.value
  }
  return out
}
