import DOMPurify from 'dompurify'

import { COMPOSE_LINE_HEIGHT_DEFAULT } from '../state/appearance'
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

/** 出站行距 wrapper 的标记属性。草稿往返回填 (draft-edit) 靠它识别并剥掉上一轮
 *  自己注入的 wrapper —— 既恢复本封的行距选择, 也保证再次发送只有一层 wrapper。 */
export const COMPOSE_LINE_HEIGHT_ATTR = 'data-ma-lh'

/** 顶层 `<p>` 的块间距 —— 与 index.css `.folder-draft-editor .ProseMirror p` 逐字
 *  对齐。编辑区靠 app CSS 拿到这个间距, 而 CSS 从不随邮件发出; 不内联的话收件端
 *  会回落到客户端默认的 1em 上下 margin, 段落间距立刻和撰写时对不上。 */
const COMPOSE_PARAGRAPH_MARGIN = '0 0 12px'

function resolveComposeLineHeight(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : COMPOSE_LINE_HEIGHT_DEFAULT
}

/** 新输入段整体包一层带 line-height 的 div。引用段在调用侧拼在其**后**(兄弟, 非
 *  嵌套), 故不受影响 —— 引用块出站样式契约 (hr + 引用头 + 原文逐字) 保持不变。 */
function wrapComposeLineHeight(inner: string, lineHeight: number): string {
  return (
    `<div ${COMPOSE_LINE_HEIGHT_ATTR}="${lineHeight}" style="line-height:${lineHeight}">` +
    inner +
    '</div>'
  )
}

export interface ComposeLineHeightStrip {
  /** 剥掉 wrapper 后的内容 (非本工具产出的 HTML 原样返回)。 */
  html: string
  /** wrapper 上记录的行距; 无 wrapper / 值非法时为 null。 */
  lineHeight: number | null
}

/**
 * 剥掉 `serializeEmailComposerHtml` 注入的行距 wrapper。
 *
 * 只认「整段正好是一个顶层 `<div data-ma-lh>`」这一形状 —— 那是我们自己发出的字节;
 * 其他形状 (外部客户端草稿 / 用户粘贴的 div) 一律原样返回, 不做任何猜测性改写。
 */
export function stripComposeLineHeightWrapper(html: string): ComposeLineHeightStrip {
  if (!html || !html.includes(COMPOSE_LINE_HEIGHT_ATTR) || typeof DOMParser === 'undefined') {
    return { html, lineHeight: null }
  }
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return { html, lineHeight: null }
  }
  // 忽略纯空白文本节点 (序列化/存盘往返常见), 其余节点多于一个即不是我们的形状。
  const nodes = Array.from(doc.body.childNodes).filter(
    (n) => n.nodeType !== 3 || (n.textContent ?? '').trim().length > 0
  )
  if (nodes.length !== 1 || nodes[0].nodeType !== 1) return { html, lineHeight: null }
  const root = nodes[0] as Element
  if (root.tagName.toLowerCase() !== 'div') return { html, lineHeight: null }
  const raw = root.getAttribute(COMPOSE_LINE_HEIGHT_ATTR)
  if (raw === null) return { html, lineHeight: null }
  const parsed = Number(raw)
  return {
    html: root.innerHTML,
    lineHeight: Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
}

/**
 * Convert TipTap output into conservative email HTML. The attributes are
 * intentionally traditional because Outlook desktop still relies on them.
 *
 * 行距 (`options.lineHeight`) **始终注入** —— 编辑区的行距来自 app CSS, 从不随邮件
 * 发出, 收件端只能回落到客户端默认 (≈1.2); 内联进出站 HTML 才是「所见即所得」。
 */
export function serializeEmailComposerHtml(
  html: string,
  options: { lineHeight?: number } = {}
): string {
  const lineHeight = resolveComposeLineHeight(options.lineHeight)
  const sanitized = DOMPurify.sanitize(html, EMAIL_PURIFY_OPTS)
  if (typeof DOMParser === 'undefined') return wrapComposeLineHeight(sanitized, lineHeight)

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
  // 顶层段落的块间距。已带自己 margin 的段落 (粘贴进来的外部 HTML) 不动 —— 编辑区
  // 里 inline style 本来就压过 .ProseMirror p 规则, 保留它才是所见即所得。
  for (const child of Array.from(doc.body.children)) {
    if (!(child instanceof HTMLElement) || child.tagName.toLowerCase() !== 'p') continue
    if (child.style.margin || child.style.marginBottom) continue
    child.style.margin = COMPOSE_PARAGRAPH_MARGIN
  }

  return wrapComposeLineHeight(
    DOMPurify.sanitize(doc.body.innerHTML, EMAIL_PURIFY_OPTS),
    lineHeight
  )
}
/* eslint-enable mailagent/no-raw-hex */
