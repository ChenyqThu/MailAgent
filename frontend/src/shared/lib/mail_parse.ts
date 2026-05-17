// EmailRow rendering helpers. Two jobs:
//   1. parseSender — backend stores `email_metadata.sender` as the raw RFC 822
//      string `"Display Name" <addr@domain>` (sender_name is mostly empty in
//      production data). Mockup §5.1 row pattern is `Name · addr@domain`,
//      so we split here and let EmailRow render both halves.
//   2. cleanSnippet — `email_body.body_markdown` is produced by markdownify
//      from HTML emails. The first 100 chars often land on Outlook safety-
//      banner tables ("| --- | --- |"), data: image references, or markdown
//      separator runs — which the mockup snippet line does NOT contain. We
//      strip markdown syntax and table noise here to pick the first real
//      prose line.
//
// Both functions are pure; tested in tests/shared/mail_parse.test.ts.

export interface ParsedSender {
  /** "Display Name" portion, trimmed and unquoted. Empty string if absent. */
  name: string
  /** Email address part. Empty string if the raw was not parseable. */
  email: string
}

/**
 * Parse the `"Name" <email@domain>` / `Name <email@domain>` / plain-email
 * shapes that mail-sync writes to `email_metadata.sender`. Falls back to
 * the raw string if neither pattern matches.
 */
export function parseSender(raw: string | null | undefined): ParsedSender {
  if (!raw) return { name: '', email: '' }
  const s = raw.trim()
  if (s === '') return { name: '', email: '' }

  // Pattern: optional quoted name, then `<email>`. The greedy non-quote
  // bracket character classes cover Chinese names + dots + spaces.
  const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s)
  if (angle && angle[2].includes('@')) {
    return { name: angle[1].trim(), email: angle[2].trim() }
  }

  // Pure email — no display name.
  if (s.includes('@') && !s.includes(' ')) {
    return { name: '', email: s }
  }

  // Couldn't parse cleanly — surface the raw value as the name so the row
  // doesn't go blank.
  return { name: s, email: '' }
}

/**
 * Strip markdown syntax + table noise from a body_markdown snippet, return
 * the first ~100 chars of readable prose. Returns null if no real text was
 * found (e.g. an all-attachments email).
 */
export function cleanSnippet(md: string | null | undefined, maxLen = 100): string | null {
  if (!md) return null

  const lines = md.split(/\r?\n/)
  const pieces: string[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue

    // Table separator: `| --- | :---: |`
    if (/^\|?\s*(:?-+:?\s*\|?\s*)+$/.test(line)) continue
    // Empty pipe row: `| | | |`
    if (/^\|(\s*\|)+$/.test(line)) continue
    // Horizontal rule
    if (/^([-*=_]\s*){3,}$/.test(line)) continue
    // Image-only line: `![alt](url)`
    if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(line)) continue
    // HTML comment artifacts
    if (/^<!--.*-->$/.test(line)) continue

    let text = line
    // Strip leading markdown markup
    text = text.replace(/^#+\s+/, '') // heading markers
    text = text.replace(/^>\s*/, '') // blockquote
    text = text.replace(/^[-*+]\s+/, '') // list bullet

    // Strip inline image refs
    text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Markdown link → keep visible text
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Bold / italic markers
    text = text.replace(/\*+([^*]+)\*+/g, '$1')
    text = text.replace(/_+([^_]+)_+/g, '$1')
    // Inline code: keep contents
    text = text.replace(/`([^`]+)`/g, '$1')

    // Pipes inside tables → spaces; trim outer pipes
    text = text.replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '')
    text = text.replace(/\s*\|\s*/g, ' ')

    // Collapse whitespace
    text = text.replace(/\s+/g, ' ').trim()

    // Drop residual empty lines and lines that only had separator chars
    if (text === '' || /^[-=_*|·•]+$/.test(text)) continue

    pieces.push(text)
    if (pieces.join(' ').length >= maxLen) break
  }

  const joined = pieces.join(' ').trim()
  if (joined === '') return null
  if (joined.length <= maxLen) return joined
  return joined.slice(0, maxLen).trimEnd() + '…'
}
