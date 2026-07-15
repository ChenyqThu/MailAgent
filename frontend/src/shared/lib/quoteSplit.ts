// 引用分离 marker (契约 D2, Bug B 前端半) — 与后端 src/services/mail_write.py 的
// QUOTE_MARKER_ATTR 逐字对齐: 引用块整体包裹 <div data-ma-quote="1">…</div>
// (含「在…写道：」/ Forwarded message 头行 + blockquote 全部)。
//
// draft-edit 回填用 splitQuoteHtml 把草稿 body_html 切成「回复段」(进 TipTap 编辑器,
// 仍过 classifyDraftHtml 分流) 与「引用段」(进折叠引用区, 发送时 getSanitizedHtml
// 原样拼回)。无 marker (存量草稿 / 外部客户端建的草稿) → quote=null, 调用方回退
// 现状全量分流。
//
// 🔴 拼回链路依赖 sanitizeEmailHtml (EMAIL_PURIFY_OPTS) 不剥 data-ma-quote 属性
// (DOMPurify 默认 ALLOW_DATA_ATTR=true) —— tests/shared/quoteSplit.test.ts 有回归
// 锁; 若未来收紧 sanitize 配置需显式 ALLOW data-ma-quote。

export const QUOTE_MARKER_ATTR = 'data-ma-quote'

export interface QuoteSplitResult {
  /** marker 之前的回复段 HTML (可为空字符串)。 */
  reply: string
  /** marker 元素 (含) 及其后所有兄弟节点的 HTML; 无 marker 时为 null。 */
  quote: string | null
}

/**
 * 按首个 `[data-ma-quote]` 元素切分草稿 HTML。
 *
 * 规则 (契约 D2):
 *  - marker 元素本身 + 它之后的所有兄弟节点 → quote (后续 marker / 尾随文本一并归入)。
 *  - 其余 (marker 之前的内容, 含嵌套时未被移走的祖先壳) → reply。
 *  - 多个 marker 取文档序首个; marker 嵌套在别的元素里时按其所在层级切分 (防御:
 *    某些客户端会再包一层 wrapper)。
 *  - 无 marker → { reply: 原文, quote: null } (调用方走现状全量分流)。
 */
export function splitQuoteHtml(html: string): QuoteSplitResult {
  if (!html || !html.includes(QUOTE_MARKER_ATTR)) {
    return { reply: html, quote: null }
  }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    // 解析不了的 HTML 一律不切 (调用方现状分流会把它判 complex 走保真通路)。
    return { reply: html, quote: null }
  }
  const marker = doc.body.querySelector(`[${QUOTE_MARKER_ATTR}]`)
  if (!marker) {
    // 字符串包含 marker 字样但不是元素属性 (如正文里的代码示例) — 不切。
    return { reply: html, quote: null }
  }
  const moved: ChildNode[] = []
  let node: ChildNode | null = marker
  while (node) {
    moved.push(node)
    node = node.nextSibling
  }
  const parts: string[] = []
  for (const n of moved) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      parts.push((n as Element).outerHTML)
    } else {
      parts.push(n.textContent ?? '')
    }
    n.remove()
  }
  return { reply: doc.body.innerHTML, quote: parts.join('') }
}
