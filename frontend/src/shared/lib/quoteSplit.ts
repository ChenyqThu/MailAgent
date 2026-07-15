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
 * 按首个 `[data-ma-quote="1"]` 元素切分草稿 HTML。
 *
 * 规则 (契约 D2):
 *  - 属性值必须严格是 "1" (后端 QUOTE_MARKER_ATTR 契约字面); 其他值 (用户/外来
 *    HTML 如 data-ma-quote="preview") 不触发切分 (codex F7)。
 *  - marker 元素 (含) 起、到文档末尾的所有内容按文档序归 quote —— 含 marker 祖先
 *    之外的顶层尾随兄弟; marker 被 wrapper 嵌套时克隆必要的祖先层级进 quote
 *    (Range.extractContents 规范行为), 保住包裹结构样式 (codex F8)。
 *  - marker 之前的内容 (含保留原位的祖先壳) → reply。
 *  - 多个 marker 取文档序首个。
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
  const marker = doc.body.querySelector(`[${QUOTE_MARKER_ATTR}="1"]`)
  if (!marker) {
    // 字符串含 marker 字样但不是严格 ="1" 的元素属性 (正文代码示例 / 外来
    // data-ma-quote="preview" 等) — 不切。
    return { reply: html, quote: null }
  }
  // 从 marker 起点到文档末尾整段提取 (语义 = Range.extractContents 的部分选中
  // 克隆规范, 手写以规避 happy-dom 对 DOMParser 文档的 Range 边界比较缺陷):
  // 自 marker 逐级向上攀爬到 body, 每级把「当前边界节点 + 其后兄弟」移入 quote,
  // 部分选中的祖先 wrapper 克隆空壳进 quote 保住包裹结构。marker 之后的所有内容
  // —— 含 marker 祖先之外的顶层尾随兄弟 —— 按文档序归 quote (旧实现只搬 marker
  // 所在层级的兄弟, 顶层尾随内容会错留在 reply、且 quote 丢祖先 wrapper)。
  const followingSiblings = (n: Node): ChildNode[] => {
    const out: ChildNode[] = []
    let sib = n.nextSibling
    while (sib) {
      out.push(sib)
      sib = sib.nextSibling
    }
    return out
  }
  let carried: ChildNode[] = [marker, ...followingSiblings(marker)]
  let parent = marker.parentNode as Node
  for (const n of carried) parent.removeChild(n)
  while (parent !== doc.body) {
    const shell = (parent as Element).cloneNode(false) as Element
    for (const n of carried) shell.appendChild(n)
    const following = followingSiblings(parent)
    const grand = parent.parentNode as Node
    for (const n of following) grand.removeChild(n)
    carried = [shell, ...following]
    parent = grand
  }
  const holder = doc.createElement('div')
  for (const n of carried) holder.appendChild(n)
  return { reply: doc.body.innerHTML, quote: holder.innerHTML }
}
