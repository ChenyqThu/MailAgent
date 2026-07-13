import { type HTMLElement, parse } from 'node-html-parser'

export const EMAIL_BODY_PREVIEW_THRESHOLD_BYTES = 256 * 1024
export const EMAIL_BODY_PREVIEW_CHARS = 64 * 1024
export const EMAIL_BODY_HTML_SOURCE_CHARS = 128 * 1024

function appendWithinBudget(
  target: HTMLElement,
  source: HTMLElement,
  remaining: { chars: number }
): void {
  for (const child of source.childNodes) {
    if (remaining.chars <= 0) break
    if (child.nodeType === 3) {
      const text = child.rawText
      if (text.length <= remaining.chars) {
        target.append(child.clone())
        remaining.chars -= text.length
      } else {
        target.append(text.slice(0, remaining.chars))
        remaining.chars = 0
      }
      continue
    }
    if (child.nodeType !== 1) continue

    const element = child as HTMLElement
    const clone = element.clone() as HTMLElement
    target.append(clone)
    if (element.isVoidElement) continue
    clone.set_content('')
    appendWithinBudget(clone, element, remaining)
  }
}

/**
 * Produce valid, balanced HTML without slicing through tags. The SQL layer only
 * reads a bounded source prefix; node-html-parser repairs dirty/unclosed email
 * markup, then this serializer keeps complete element boundaries and truncates
 * only an individual text node when it alone crosses the character budget.
 */
export function previewHtml(html: string, maxChars = EMAIL_BODY_PREVIEW_CHARS): string {
  if (html.length <= maxChars) return html
  const source = parse(html)
  const output = parse('')
  appendWithinBudget(output, source, { chars: maxChars })
  return output.innerHTML
}
