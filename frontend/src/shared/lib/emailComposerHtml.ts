import DOMPurify from 'dompurify'

import { EMAIL_PURIFY_OPTS } from './emailSanitize'

/* eslint-disable mailagent/no-raw-hex -- these colors are serialized into portable email content, not app chrome. */

const OFFICE_STYLE_PREFIX = /^(?:mso-|tab-stops?$)/i
const DROP_ELEMENTS = 'style, meta, link, title, xml, script, iframe, object, embed, form'

function cleanInlineStyle(element: HTMLElement): void {
  const raw = element.getAttribute('style')
  if (!raw) return
  const declarations = raw
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const separator = part.indexOf(':')
      if (separator < 0) return false
      return !OFFICE_STYLE_PREFIX.test(part.slice(0, separator).trim())
    })
  if (declarations.length === 0) element.removeAttribute('style')
  else element.setAttribute('style', declarations.join('; '))
}

function unwrapElement(element: Element): void {
  const parent = element.parentNode
  if (!parent) return
  while (element.firstChild) parent.insertBefore(element.firstChild, element)
  element.remove()
}

/**
 * Reduce Office/Outlook clipboard HTML to the subset TipTap can edit safely.
 * Structural table attributes (rowspan/colspan) and normal inline formatting
 * survive; proprietary namespaces, classes, event attributes, and mso styles do not.
 */
export function normalizeEditableEmailHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, EMAIL_PURIFY_OPTS)
  if (typeof DOMParser === 'undefined') {
    return sanitized.replace(/\bmso-[\w-]+\s*:[^;"']*;?/gi, '')
  }

  const doc = new DOMParser().parseFromString(sanitized, 'text/html')
  for (const element of Array.from(doc.body.querySelectorAll(DROP_ELEMENTS))) element.remove()

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT)
  const comments: Comment[] = []
  let node = walker.nextNode()
  while (node) {
    comments.push(node as Comment)
    node = walker.nextNode()
  }
  for (const comment of comments) comment.remove()

  for (const element of Array.from(doc.body.querySelectorAll('*'))) {
    const tagName = element.tagName.toLowerCase()
    if (tagName.includes(':')) {
      unwrapElement(element)
      continue
    }
    element.removeAttribute('class')
    element.removeAttribute('id')
    element.removeAttribute('lang')
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name.startsWith('xmlns:'))
        element.removeAttribute(attribute.name)
    }
    cleanInlineStyle(element as HTMLElement)
  }

  return DOMPurify.sanitize(doc.body.innerHTML, EMAIL_PURIFY_OPTS)
}

/**
 * Convert TipTap output into conservative email HTML. The attributes are
 * intentionally traditional because Outlook desktop still relies on them.
 */
export function serializeEmailComposerHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, EMAIL_PURIFY_OPTS)
  if (!/<table[\s>]/i.test(sanitized) || typeof DOMParser === 'undefined') return sanitized

  const doc = new DOMParser().parseFromString(sanitized, 'text/html')
  for (const table of Array.from(doc.body.querySelectorAll('table'))) {
    if (!(table instanceof HTMLElement)) continue
    table.removeAttribute('class')
    table.setAttribute('border', '1')
    table.setAttribute('cellpadding', '0')
    table.setAttribute('cellspacing', '0')
    table.setAttribute('role', 'table')
    table.style.borderCollapse = 'collapse'
    table.style.borderSpacing = '0'
    table.style.maxWidth = '100%'
    table.style.border = '1px solid #d9d9d9'
  }
  for (const cell of Array.from(doc.body.querySelectorAll('td, th'))) {
    if (!(cell instanceof HTMLElement)) continue
    cell.setAttribute('valign', 'top')
    cell.style.border = '1px solid #d9d9d9'
    cell.style.padding = '6px 8px'
    cell.style.verticalAlign = 'top'
  }
  for (const header of Array.from(doc.body.querySelectorAll('th'))) {
    header.style.backgroundColor = '#f3f4f6'
    header.style.fontWeight = '600'
  }

  return DOMPurify.sanitize(doc.body.innerHTML, EMAIL_PURIFY_OPTS)
}
/* eslint-enable mailagent/no-raw-hex */
