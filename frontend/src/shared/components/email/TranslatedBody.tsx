// Sprint 3 §2.2 — translated-body display.
//
// The LLM returns markdown (per `prompts/` system message convention) so a
// full markdown→HTML pass would be the most faithful render. We deliberately
// stay minimal here: a regex pass covering the inline patterns email content
// actually uses (bold, italic, inline code, http(s) links, headings, list
// bullets, blockquote prefixes) wrapped through DOMPurify so escaped HTML
// in the source stays escaped. Block-level structure (paragraphs, lists)
// falls back to `whitespace-pre-wrap`, which keeps the source visually
// recognisable without dragging in a markdown library on Sprint 3.

import { useMemo } from 'react'
import DOMPurify from 'dompurify'

import type { TranslationSegment } from '@shared/api/types'

interface Props {
  text: string
  /** Bilingual segment pairs. When provided, renders the source paragraph
   *  followed by an italic + dimmed translation block, repeating per pair.
   *  Otherwise the legacy monolingual `text` path runs. */
  segments?: TranslationSegment[]
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(s: string): string {
  let out = escapeHtml(s)
  // Markdown link: [text](http(s)://...)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  )
  // Bare http(s) URL → linkify (skips ones already inside an <a>)
  out = out.replace(
    /(^|[\s(])((https?:\/\/[^\s<)]+))/g,
    (_m, before: string, url: string) =>
      `${before}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  )
  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  // Bold then italic — bold first so **text** doesn't trigger the italic.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
  return out
}

function renderBlock(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
  if (heading) {
    const level = heading[1].length
    return `<h${level}>${renderInline(heading[2])}</h${level}>`
  }
  if (/^>\s/.test(trimmed)) {
    const inner = trimmed.replace(/^>\s?/gm, '')
    return `<blockquote>${renderInline(inner).replace(/\n/g, '<br>')}</blockquote>`
  }
  // List block: every non-empty line begins with `- ` / `* ` / `1. `
  const lines = trimmed.split(/\n/)
  const allUnordered = lines.every((l) => /^\s*[-*]\s+/.test(l))
  const allOrdered = lines.every((l) => /^\s*\d+\.\s+/.test(l))
  if (allUnordered) {
    const items = lines.map((l) => `<li>${renderInline(l.replace(/^\s*[-*]\s+/, ''))}</li>`)
    return `<ul>${items.join('')}</ul>`
  }
  if (allOrdered) {
    const items = lines.map((l) => `<li>${renderInline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`)
    return `<ol>${items.join('')}</ol>`
  }
  // Paragraph — single newlines become <br>, double newlines split into
  // separate <p> via the splitter below.
  return `<p>${renderInline(trimmed).replace(/\n/g, '<br>')}</p>`
}

// http(s) only — drops javascript: / data: / mailto: at the sanitiser level
// even if the markdown layer let one through.
const HTTP_URI = /^https?:\/\//i

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'code',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'span'
]

function markdownToSafeHtml(md: string): string {
  const blocks = md.split(/\n\s*\n/)
  const rendered = blocks.map(renderBlock).join('\n')
  // Codex review M-4: USE_PROFILES.html *adds to* the tag set rather than
  // replacing it, so the explicit allow-list was effectively looser than
  // it read. Dropping the profile + pinning the URI scheme leaves an
  // unambiguous positive list.
  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOWED_URI_REGEXP: HTTP_URI
  })
}

export function TranslatedBody({ text, segments }: Props): React.ReactElement {
  // Bilingual path — render each {src, tgt} as a pair: source rendered as
  // normal mail body, translation rendered below in italic + dim text-fg-2
  // so visual distinction works without a leading marker.
  const pairs = useMemo(() => {
    if (!segments || segments.length === 0) return null
    return segments.map((seg, idx) => ({
      key: idx,
      src: markdownToSafeHtml(seg.src),
      tgt: markdownToSafeHtml(seg.tgt)
    }))
  }, [segments])

  const monolingualHtml = useMemo(() => (pairs === null ? markdownToSafeHtml(text) : ''), [
    pairs,
    text
  ])

  if (pairs !== null) {
    return (
      <div className="mail-body break-words">
        {pairs.map((p) => (
          <div key={p.key} className="bilingual-segment mb-4 last:mb-0">
            <div dangerouslySetInnerHTML={{ __html: p.src }} />
            <div
              className="italic text-ink-fg-2 mt-1 [&_p]:my-0 [&_li]:my-0"
              dangerouslySetInnerHTML={{ __html: p.tgt }}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="mail-body break-words" dangerouslySetInnerHTML={{ __html: monolingualHtml }} />
  )
}
