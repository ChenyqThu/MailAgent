import type { TranslationSegment } from '@shared/api/types'
import { collectRuns, type DomAdapter, normalizeForMatch } from '@shared/lib/translation_blocks'

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Remove any previously-injected translation nodes from the iframe doc. */
function clearInjectedTranslations(doc: Document): void {
  doc.querySelectorAll('.mailagent-translation').forEach((n) => n.remove())
}

const browserAdapter: DomAdapter<Node> = {
  isElement(node) {
    return node.nodeType === 1
  },
  isText(node) {
    return node.nodeType === 3
  },
  tagName(node) {
    const tag = (node as Element).tagName
    return typeof tag === 'string' ? tag.toLowerCase() : ''
  },
  childNodes(node) {
    return Array.from(node.childNodes)
  },
  getAttribute(node, name) {
    if (node.nodeType !== 1) return null
    return (node as Element).getAttribute(name)
  },
  textOf(node) {
    return node.textContent ?? ''
  }
}

interface TranslationAssignment {
  srcNorm: string
  tgt: string
  order: number
}

/** 按 shared run 划分匹配译文并注入。每个 run 最多渲染一个译文 div；
 *  长段拆 chunk 的多个译文在同一 div 里按原文位置用 br 聚合。 */
export function injectTranslations(doc: Document, segments: TranslationSegment[]): number {
  clearInjectedTranslations(doc)
  const root = doc.body ?? doc.documentElement
  if (!root) return 0

  const runs = collectRuns(browserAdapter, root)
  const normalized = runs.map((run) => normalizeForMatch(run.text))
  const assignments = new Map<number, TranslationAssignment[]>()
  let order = 0

  function add(runIdx: number, srcNorm: string, tgt: string): void {
    const list = assignments.get(runIdx) ?? []
    list.push({ srcNorm, tgt, order: order++ })
    assignments.set(runIdx, list)
  }

  for (const seg of segments) {
    const srcNorm = normalizeForMatch(seg.src)
    if (srcNorm.length === 0) continue

    const exactMatches: number[] = []
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i] === srcNorm) exactMatches.push(i)
    }
    if (exactMatches.length > 0) {
      exactMatches.forEach((runIdx) => add(runIdx, srcNorm, seg.tgt))
      continue
    }

    const containingRun = normalized.findIndex(
      (runNorm) => runNorm.length > 0 && runNorm.includes(srcNorm)
    )
    if (containingRun >= 0) {
      add(containingRun, srcNorm, seg.tgt)
      continue
    }

    const containedRun = normalized.findIndex(
      (runNorm) => runNorm.length > 0 && srcNorm.includes(runNorm)
    )
    if (containedRun >= 0) {
      add(containedRun, srcNorm, seg.tgt)
    }
  }

  let injected = 0
  for (const [runIdx, list] of assignments) {
    const run = runs[runIdx]
    if (!run) continue
    const runNorm = normalized[runIdx] ?? ''
    list.sort((a, b) => {
      const aIdx = runNorm.indexOf(a.srcNorm)
      const bIdx = runNorm.indexOf(b.srcNorm)
      const aPos = aIdx >= 0 ? aIdx : 0
      const bPos = bIdx >= 0 ? bIdx : 0
      if (aPos !== bPos) return aPos - bPos
      return a.order - b.order
    })
    const container = run.container as Node
    if (typeof container.insertBefore !== 'function') continue
    const div = doc.createElement('div')
    div.className = 'mailagent-translation'
    // Tgt 是 LLM 返回的纯文本；这里仍防御性 escape，避免 sender/LLM 带入 HTML。
    div.innerHTML = list.map((item) => escapeHtmlText(item.tgt)).join('<br>')
    container.insertBefore(div, run.endNode.nextSibling)
    injected++
  }

  return injected
}
