// Sprint Immersive-Translate — body_html 块级元素提取器。
//
// On-demand batch 翻译路径 (Path B) 在主进程从 SQLite 读 body_html，用本工具
// 抽出块级段落 (p/li/h*/td/blockquote/dt/dd) 喂给 LLM；LLM 返回 {id, tgt} 后
// 渲染端用同样的 id (或 src 子串) 在 iframe.contentDocument 上 fuzzy 匹配
// DOM 节点注入译文。
//
// 选 node-html-parser 而非 cheerio/jsdom 的理由:
//   - cheerio 拖 parse5 + htmlparser2 + domhandler ~500KB；jsdom 拖 native
//     compile + 几 MB。我们只需要 querySelectorAll + textContent，节点不写
//     回（HTML SSoT 不污染），node-html-parser 50KB 纯 JS 完全够用。
//   - parse 容错好：邮件 HTML 经常是 Outlook 生成的脏 HTML，node-html-parser
//     不会因为未闭合 tag 抛错。
//
// 设计：
//   - 不注入 data-i18n-id（不污染 SSoT），id 仅用作 batch 内部去重；
//     渲染端用 textContent.includes(src) 配对，不依赖 id。
//   - 过滤：长度 < 4 / CJK ≥ 50% / parent 是 code/pre/script/style。
//   - id = sha1(domPath).slice(0,8)。domPath 是自顶向下 tag[idx] 串，碰撞
//     概率忽略不计（一封邮件几十段，不会有同 path）。

import { createHash } from 'node:crypto'
import { type HTMLElement, parse } from 'node-html-parser'

export interface ExtractedBlock {
  /** 8-字符稳定哈希 ID，基于 DOM path。LLM 不一定回得来同一个 id，
   *  渲染端最终用 src 子串配对，id 只是 batch 内部 dedupe key。 */
  id: string
  /** 段落 plaintext（trim 后）。喂给 LLM 的 src。 */
  text: string
}

// 块级 selector — 邮件正文里承载语义段的元素。
// 必须含 div 因为 Outlook / Gmail 默认用 <div> 而非 <p> 包段落 (实测 54094
// 整封邮件 0 个 <p> 全是 div+span)。但 div 是通用容器, 极易抽到 "整封邮件
// 文本" 这种巨长 outer node, 所以在 extractBlocks 里加 leaf 过滤: 只抽不含
// 其他 BLOCK 后代的叶子节点。
const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, blockquote, dt, dd, div'

// 父节点为这些时跳过：代码块/脚本/样式里抽出来翻是没意义的
const SKIP_ANCESTORS = new Set(['code', 'pre', 'script', 'style', 'noscript'])

const MIN_LEN = 4
const MAX_LEN = 800 // 单段过长 LLM 也 hold 不住; > 800 字符的段落 prompt 那边
// 会要求 LLM 取 30-300 的首句锚, 但我们这里仍然把全文喂进去, 给 LLM 上下文

/** CJK 字符占比 ≥ 50% 则跳过 (已是中文 / 日文 / 韩文)。
 *
 *  CJK Unified Ideographs 主区 (U+4E00-U+9FFF) + Hiragana / Katakana / Hangul，
 *  覆盖中文/日文/韩文段落足够；不试图区分 zh/ja/ko，因为反正都不需要翻成中文。 */
function isCjkHeavy(text: string): boolean {
  let cjk = 0
  let total = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20) continue // 空白不算分母
    total += 1
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af) // Hangul Syllables
    ) {
      cjk += 1
    }
  }
  if (total === 0) return false
  return cjk / total >= 0.5
}

/** 检查节点祖先链是否含 SKIP_ANCESTORS 中任一 tag。
 *  node-html-parser 的虚拟 root 节点 tagName 是 null/undefined, 加 guard。 */
function hasSkipAncestor(node: HTMLElement): boolean {
  let cur: HTMLElement | null = node.parentNode as HTMLElement | null
  while (cur && cur.nodeType === 1) {
    const tag = cur.tagName
    if (typeof tag === 'string' && SKIP_ANCESTORS.has(tag.toLowerCase())) return true
    cur = cur.parentNode as HTMLElement | null
  }
  return false
}

/** 计算从 root 到节点的 tag[idx] path（idx 是同 tag 兄弟里的序号）。
 *
 *  例：`html/body/div[1]/p[3]`。这个串喂 sha1 取前 8 字符做 id；同一封邮件
 *  里不同节点的 path 永不冲突，所以 id 实际作为节点身份标识。 */
function nodePath(node: HTMLElement): string {
  const parts: string[] = []
  let cur: HTMLElement | null = node
  while (cur && cur.nodeType === 1 && typeof cur.tagName === 'string' && cur.tagName) {
    const tag = cur.tagName.toLowerCase()
    const parent = cur.parentNode as HTMLElement | null
    if (parent && parent.childNodes) {
      let idx = 0
      let found = false
      for (const sib of parent.childNodes) {
        const sibEl = sib as HTMLElement
        const sibTag = sibEl.tagName
        if (
          sibEl.nodeType === 1 &&
          typeof sibTag === 'string' &&
          sibTag.toLowerCase() === tag
        ) {
          if (sibEl === cur) {
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

/**
 * 从 body_html 抽出待翻译块级段落。返回顺序 = DOM 文档顺序。
 *
 * 重复段：如果两段 trim 后 text 完全一致，第二段会被 dedupe（用同一个 src
 * 喂 LLM 两次浪费 token，且渲染端 textContent 配对会在第一个匹配处注入两次
 * — 由 EmailBodyFrame 端用 "已注入标记" 处理）。
 */
export function extractBlocks(html: string): ExtractedBlock[] {
  if (typeof html !== 'string' || html.length === 0) return []
  const root = parse(html, {
    blockTextElements: {
      script: false,
      noscript: false,
      style: false,
      pre: true // pre 内文本保留, 但 hasSkipAncestor 会跳过 — 不重要
    }
  })
  const nodes = root.querySelectorAll(BLOCK_SELECTOR)
  const seen = new Set<string>()
  const out: ExtractedBlock[] = []
  for (const node of nodes) {
    if (hasSkipAncestor(node)) continue
    // Leaf filter: skip nodes that themselves contain another BLOCK descendant.
    // Without this, an outer <div> wrapping the entire email body matches the
    // selector and dumps the full-text textContent — too long + 重复内容会
    // 让 LLM 拿到错位的 batch。我们只想要 "段落级" 叶子 (含 inline 子节点
    // 如 span/b/a/br 但不含 div/p/li 等其它 block)。
    if (node.querySelector(BLOCK_SELECTOR)) continue
    // .text 是 node-html-parser 的 textContent (含子节点所有 text 拼接)
    const raw = node.text ?? ''
    const text = raw.replace(/\s+/g, ' ').trim()
    if (text.length < MIN_LEN) continue
    if (text.length > MAX_LEN) continue
    if (isCjkHeavy(text)) continue
    if (seen.has(text)) continue
    seen.add(text)
    const id = hashId(nodePath(node))
    out.push({ id, text })
  }
  return out
}
