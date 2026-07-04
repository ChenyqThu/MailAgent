// D5 富文本混合门 — draft-edit prefill 前对草稿 body_html 分类, 决定进编辑器还是保真 iframe。
//
// TipTap schema (StarterKit + TextStyle 系 + Image) 只认 paragraph/heading/list/
// blockquote/codeBlock 等有限结构; Outlook/OWA 富文本草稿 (table 布局 + cid 内联图 +
// mso 样式汤) 经 setContent() 会被 ProseMirror 剥到近纯文本, 此后 getHTML() 发送的
// 就是剥离后的骨架 —— 「草稿富文本发出去变纯文本」的根因。
//
// 策略 (保守: 只有确信编辑器能无损表达才判 simple, 拿不准一律 complex 走保真通路):
//   'empty'   → body_html 空/纯空白 → 调用方回落 markdown。
//   'simple'  → 直灌 editor.commands.setContent() (可行内编辑)。
//   'complex' → 原文整块进折叠 iframe 保真展示 (复用 quoteHtml 拼接机制),
//               编辑器只写顶部新增内容。

export type DraftHtmlClass = 'empty' | 'simple' | 'complex'

/** TipTap 表达不了 / setContent 会剥离的结构标记。逐条对应剥离面:
 *  - <table>            : schema 无 table (未装 table 四件套), 整个拍平成文本
 *  - cid:               : 内联图引用, 编辑器渲染不了也回不去
 *  - Outlook/Word 痕迹  : <v:>/<o:>/<w:> VML·office 命名空间, mso- 样式,
 *                         <!--[if 条件注释 —— 出现即整体是 Outlook 汤
 *  - iframe/object 等   : sandbox 结构, schema 无对应 node
 */
const COMPLEX_MARKERS: readonly RegExp[] = [
  /<table[\s>]/i,
  /\bcid:/i,
  /<[vow]:[a-z]/i,
  /xmlns:[vow]=/i,
  /\bmso-/i,
  /<!--\[if/i,
  /<(iframe|frame|object|embed|svg)[\s>]/i
]

/** <img src> 只有 http(s)/data: 能在编辑器里渲染且原样回发; 相对路径
 *  (库内 cid 改写成的 attachments/{id}/{file}) / file: 等都表达不了。 */
const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi

/** 块级嵌套深度上限 — TipTap 自产 HTML (p / ul>li>p / blockquote) 远浅于此;
 *  超深嵌套 = 邮件客户端布局汤, setContent 会大量剥层。 */
const MAX_NESTING_DEPTH = 8

function maxElementDepth(root: Element): number {
  let deepest = 0
  const walk = (el: Element, depth: number): void => {
    if (depth > deepest) deepest = depth
    if (depth > MAX_NESTING_DEPTH) return // 已超限, 不必继续下钻
    for (const child of Array.from(el.children)) walk(child, depth + 1)
  }
  walk(root, 0)
  return deepest
}

/** 草稿 body_html 分类 (纯函数)。html 为 null/空白 → 'empty'。 */
export function classifyDraftHtml(html: string | null | undefined): DraftHtmlClass {
  if (!html || html.trim().length === 0) return 'empty'

  for (const re of COMPLEX_MARKERS) {
    if (re.test(html)) return 'complex'
  }

  IMG_SRC_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMG_SRC_RE.exec(html)) !== null) {
    if (!/^(https?:|data:)/i.test(m[1])) return 'complex'
  }

  // 深度检查需要 DOM 解析; 非 DOM 环境 (理论上 prefill 只在 renderer 跑) 跳过,
  // 上面的标记检查已覆盖主要剥离源。
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      if (doc.body && maxElementDepth(doc.body) > MAX_NESTING_DEPTH) return 'complex'
    } catch {
      return 'complex' // 解析都失败的 HTML 一律走保真通路
    }
  }

  return 'simple'
}
