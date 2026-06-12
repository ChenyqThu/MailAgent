export const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'big',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'label',
  'mark',
  'nobr',
  'output',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
  'img'
])

export const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'pre'])

export const MIN_LEN = 4
export const MAX_LEN = 800

export interface DomAdapter<N> {
  isElement(node: N): boolean
  isText(node: N): boolean
  tagName(node: N): string
  childNodes(node: N): N[]
  getAttribute(node: N, name: string): string | null | undefined
  textOf(node: N): string
}

export interface Run<N> {
  /** run 内可见文本，已折叠空白但保留原大小写。 */
  text: string
  /** run 所属的直接容器元素。 */
  container: N
  /** run 的最后一个顶层节点，注入端以它的 nextSibling 作为锚点。 */
  endNode: N
  /** 过滤端用：整段只是一个裸 inline code 时不送翻译。 */
  isSingleCodeElement: boolean
}

export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

function normalizeRunText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** CJK 字符占比 >= 50% 则视为已是中/日/韩文本，空白不计入分母。 */
export function isCjkHeavy(text: string): boolean {
  let cjk = 0
  let total = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20) continue
    total += 1
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1
    }
  }
  if (total === 0) return false
  return cjk / total >= 0.5
}

export interface TranslatableTextOptions {
  isSingleCodeElement?: boolean
}

export function isTranslatableText(text: string, opts: TranslatableTextOptions = {}): boolean {
  const trimmed = text.trim()
  if (trimmed.length < MIN_LEN) return false
  if (opts.isSingleCodeElement) return false
  if (isCjkHeavy(trimmed)) return false
  if (!/[A-Za-z]{2}/.test(trimmed)) return false
  if (/^https?:\/\/\S+$/i.test(trimmed)) return false
  if (/^\S+@\S+\.\S+$/.test(trimmed)) return false
  return true
}

export function splitLongText(text: string, maxLen = MAX_LEN): string[] {
  const normalized = normalizeRunText(text)
  if (normalized.length === 0) return []
  if (normalized.length <= maxLen) return [normalized]

  const sentences: string[] = []
  const boundary = /[.!?;。；！？…]\s+/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = boundary.exec(normalized)) !== null) {
    const end = match.index + match[0].length
    const part = normalized.slice(start, end).trim()
    if (part.length > 0) sentences.push(part)
    start = end
  }
  const rest = normalized.slice(start).trim()
  if (rest.length > 0) sentences.push(rest)

  const chunks: string[] = []
  let pending = ''

  function hardPush(piece: string): void {
    let offset = 0
    while (offset < piece.length) {
      const chunk = piece.slice(offset, offset + maxLen).trim()
      if (chunk.length > 0) chunks.push(chunk)
      offset += maxLen
    }
  }

  function flushPending(): void {
    if (pending.length === 0) return
    chunks.push(pending)
    pending = ''
  }

  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      flushPending()
      hardPush(sentence)
      continue
    }
    if (pending.length === 0) {
      pending = sentence
      continue
    }
    const next = `${pending} ${sentence}`
    if (next.length <= maxLen) {
      pending = next
    } else {
      flushPending()
      pending = sentence
    }
  }
  flushPending()
  return chunks
}

function isHiddenElement<N>(adapter: DomAdapter<N>, node: N): boolean {
  if (!adapter.isElement(node)) return false
  if (
    adapter.getAttribute(node, 'hidden') !== undefined &&
    adapter.getAttribute(node, 'hidden') !== null
  ) {
    return true
  }
  const ariaHidden = adapter.getAttribute(node, 'aria-hidden')
  if (typeof ariaHidden === 'string' && ariaHidden.trim().toLowerCase() === 'true') return true
  const style = adapter.getAttribute(node, 'style')
  if (typeof style !== 'string') return false
  return /display\s*:\s*none\b/i.test(style) || /visibility\s*:\s*hidden\b/i.test(style)
}

function shouldPruneElement<N>(adapter: DomAdapter<N>, node: N): boolean {
  if (!adapter.isElement(node)) return false
  const tag = adapter.tagName(node)
  return SKIP_TAGS.has(tag) || isHiddenElement(adapter, node)
}

function visibleText<N>(adapter: DomAdapter<N>, node: N): string {
  if (adapter.isText(node)) return adapter.textOf(node)
  if (!adapter.isElement(node) || shouldPruneElement(adapter, node)) return ''
  if (adapter.tagName(node) === 'br') return '\n'
  return adapter
    .childNodes(node)
    .map((child) => visibleText(adapter, child))
    .join('')
}

function isWhitespaceText<N>(adapter: DomAdapter<N>, node: N): boolean {
  return adapter.isText(node) && adapter.textOf(node).trim().length === 0
}

function isSingleCodeRun<N>(adapter: DomAdapter<N>, nodes: N[]): boolean {
  const meaningful = nodes.filter((node) => {
    if (isWhitespaceText(adapter, node)) return false
    if (adapter.isElement(node) && adapter.tagName(node) === 'br') return false
    return true
  })
  return (
    meaningful.length === 1 &&
    adapter.isElement(meaningful[0]!) &&
    adapter.tagName(meaningful[0]!) === 'code'
  )
}

export function collectRuns<N>(adapter: DomAdapter<N>, root: N): Run<N>[] {
  const runs: Run<N>[] = []

  function flush(container: N, nodes: N[]): void {
    if (nodes.length === 0) return
    const text = normalizeRunText(nodes.map((node) => visibleText(adapter, node)).join(''))
    if (text.length === 0) return
    runs.push({
      text,
      container,
      endNode: nodes[nodes.length - 1]!,
      isSingleCodeElement: isSingleCodeRun(adapter, nodes)
    })
  }

  function walk(container: N): void {
    if (!adapter.isElement(container) || shouldPruneElement(adapter, container)) return

    let current: N[] = []
    let lastBrIndex: number | null = null

    function resetAfterText(node: N): void {
      current.push(node)
      if (!isWhitespaceText(adapter, node)) lastBrIndex = null
    }

    for (const child of adapter.childNodes(container)) {
      if (adapter.isText(child)) {
        resetAfterText(child)
        continue
      }
      if (!adapter.isElement(child)) continue
      if (shouldPruneElement(adapter, child)) continue

      const tag = adapter.tagName(child)
      if (tag === 'br') {
        const onlyWhitespaceSinceLastBr =
          lastBrIndex !== null &&
          current.slice(lastBrIndex + 1).every((node) => isWhitespaceText(adapter, node))
        if (onlyWhitespaceSinceLastBr) {
          flush(container, current)
          current = []
          lastBrIndex = null
          continue
        }
        current.push(child)
        lastBrIndex = current.length - 1
        continue
      }

      if (INLINE_TAGS.has(tag)) {
        current.push(child)
        lastBrIndex = null
        continue
      }

      flush(container, current)
      current = []
      lastBrIndex = null
      walk(child)
    }

    flush(container, current)
  }

  walk(root)
  return runs
}
