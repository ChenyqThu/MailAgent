// Draft-edit compatibility gate. Standard tables are now part of the TipTap
// schema; proprietary layout/CID/VML content still takes the preserve-only path.

import { normalizeEditableEmailHtml } from './emailComposerHtml'

export type DraftHtmlCompatibility = 'empty' | 'editable' | 'normalize-editable' | 'preserve-only'

export interface DraftHtmlAssessment {
  compatibility: DraftHtmlCompatibility
  html: string
}

/** Compatibility wrapper for older callers/tests. */
export type DraftHtmlClass = 'empty' | 'simple' | 'complex'

const PRESERVE_MARKERS: readonly RegExp[] = [
  /\bcid:/i,
  /<v:[a-z]/i,
  /<w:[a-z]/i,
  /xmlns:[vw]=/i,
  /<!--\[if/i,
  /<(iframe|frame|object|embed|svg)[\s>]/i
]

const NORMALIZE_MARKERS: readonly RegExp[] = [
  /\bmso-/i,
  /\bclass\s*=\s*["'][^"']*\bMso/i,
  /<o:p[\s>]/i,
  /xmlns:o=/i,
  /<style[\s>]/i
]

const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi
const MAX_NESTING_DEPTH = 8

function maxElementDepth(root: Element): number {
  let deepest = 0
  const walk = (element: Element, depth: number): void => {
    if (depth > deepest) deepest = depth
    if (depth > MAX_NESTING_DEPTH) return
    for (const child of Array.from(element.children)) walk(child, depth + 1)
  }
  walk(root, 0)
  return deepest
}

function hasUnsupportedTableShape(root: ParentNode): boolean {
  const tables = Array.from(root.querySelectorAll('table'))
  return tables.some(
    (table) =>
      table.querySelector('table') !== null ||
      table.getAttribute('role')?.toLowerCase() === 'presentation'
  )
}

export function assessDraftHtml(html: string | null | undefined): DraftHtmlAssessment {
  if (!html || html.trim().length === 0) return { compatibility: 'empty', html: '' }

  for (const marker of PRESERVE_MARKERS) {
    if (marker.test(html)) return { compatibility: 'preserve-only', html }
  }

  IMG_SRC_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMG_SRC_RE.exec(html)) !== null) {
    if (!/^(https?:|data:)/i.test(match[1])) return { compatibility: 'preserve-only', html }
  }

  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      if (maxElementDepth(doc.body) > MAX_NESTING_DEPTH || hasUnsupportedTableShape(doc.body)) {
        return { compatibility: 'preserve-only', html }
      }
    } catch {
      return { compatibility: 'preserve-only', html }
    }
  } else if (/<table[\s\S]*<table[\s>]/i.test(html)) {
    return { compatibility: 'preserve-only', html }
  }

  if (NORMALIZE_MARKERS.some((marker) => marker.test(html))) {
    return { compatibility: 'normalize-editable', html: normalizeEditableEmailHtml(html) }
  }
  return { compatibility: 'editable', html }
}

export function classifyDraftHtml(html: string | null | undefined): DraftHtmlClass {
  const compatibility = assessDraftHtml(html).compatibility
  if (compatibility === 'empty') return 'empty'
  if (compatibility === 'preserve-only') return 'complex'
  return 'simple'
}
