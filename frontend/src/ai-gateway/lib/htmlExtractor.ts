// Body HTML translation unit extractor v2 (shared with ai-gateway translateRoutes).
//
// Collects visible text runs in DOM order, splitting blocks at container/double-br
// boundaries, pruning script/style/noscript/pre and hidden subtrees, filtering
// non-translatable runs, and splitting >800 char paragraphs at sentence boundaries.

import { createHash } from 'node:crypto'
import { type HTMLElement, parse } from 'node-html-parser'

import {
  collectRuns,
  type DomAdapter,
  isTranslatableText,
  splitLongText
} from '@shared/lib/translation_blocks'

export interface ExtractedBlock {
  /** 8-char stable hash ID from DOM path + run/chunk index. */
  id: string
  /** Trimmed paragraph plaintext fed to LLM as `src`. */
  text: string
}

type HtmlNode = HTMLElement | HTMLElement['childNodes'][number]

const htmlAdapter: DomAdapter<HtmlNode> = {
  isElement(node) {
    return node.nodeType === 1
  },
  isText(node) {
    return node.nodeType === 3
  },
  tagName(node) {
    const tag = (node as HTMLElement).tagName
    return typeof tag === 'string' ? tag.toLowerCase() : ''
  },
  childNodes(node) {
    return Array.from(node.childNodes ?? []) as HtmlNode[]
  },
  getAttribute(node, name) {
    if (node.nodeType !== 1) return undefined
    return (node as HTMLElement).getAttribute(name)
  },
  textOf(node) {
    return node.text ?? node.textContent ?? ''
  }
}

function nodePath(node: HtmlNode): string {
  const parts: string[] = []
  let cur: HtmlNode | null = node
  while (cur && cur.nodeType === 1) {
    const rawTag = (cur as HTMLElement).tagName
    if (typeof rawTag !== 'string' || rawTag.length === 0) break
    const tag = rawTag.toLowerCase()
    const parent = cur.parentNode as HTMLElement | null
    if (parent && parent.childNodes) {
      let idx = 0
      let found = false
      for (const sib of parent.childNodes) {
        const sibTag = (sib as HTMLElement).tagName
        if (sib.nodeType === 1 && typeof sibTag === 'string' && sibTag.toLowerCase() === tag) {
          if (sib === cur) {
            parts.unshift(`${tag}[${idx}]`)
            found = true
            break
          }
          idx += 1
        }
      }
      if (!found) parts.unshift(tag)
    } else {
      parts.unshift(tag)
    }
    cur = parent
  }
  return parts.join('/')
}

function hashId(path: string): string {
  return createHash('sha1').update(path).digest('hex').slice(0, 8)
}

/** Extract translatable runs/chunks from body_html in DOM document order. */
export function extractBlocks(html: string): ExtractedBlock[] {
  if (typeof html !== 'string' || html.length === 0) return []
  const root = parse(html, {
    blockTextElements: {
      script: false,
      noscript: false,
      style: false,
      pre: true
    }
  }) as HtmlNode

  const seen = new Set<string>()
  const out: ExtractedBlock[] = []
  const runs = collectRuns(htmlAdapter, root)

  runs.forEach((run, runIdx) => {
    if (!isTranslatableText(run.text, { isSingleCodeElement: run.isSingleCodeElement })) return
    const chunks = splitLongText(run.text)
    chunks.forEach((text, chunkIdx) => {
      if (seen.has(text)) return
      seen.add(text)
      const id = hashId(`${nodePath(run.container)}#${runIdx}#${chunkIdx}`)
      out.push({ id, text })
    })
  })

  return out
}
