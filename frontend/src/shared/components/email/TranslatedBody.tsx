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

interface Props {
  text: string
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

export function TranslatedBody({ text }: Props): React.ReactElement {
  const html = useMemo(() => {
    const blocks = text.split(/\n\s*\n/)
    const rendered = blocks.map(renderBlock).join('\n')
    // Codex review M-4: USE_PROFILES.html *adds to* the tag set rather than
    // replacing it, so the explicit allow-list was effectively looser than
    // it read. Dropping the profile + pinning the URI scheme leaves an
    // unambiguous positive list.
    return DOMPurify.sanitize(rendered, {
      ALLOWED_TAGS: [
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
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel'],
      ALLOWED_URI_REGEXP: HTTP_URI
    })
  }, [text])

  return <div className="mail-body break-words" dangerouslySetInnerHTML={{ __html: html }} />
}
