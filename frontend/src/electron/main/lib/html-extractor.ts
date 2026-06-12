// Sprint Immersive-Translate — body_html 翻译单元提取器 v2。
//
// Path B 在主进程从 SQLite 读 body_html 后，用本工具把邮件正文切成
// “可见文本 run” 再批量送 LLM。v2 不再挑 p/li/div 叶子节点，而是让每个
// 可见 text 节点都归属到某个翻译单元：
//   - 容器元素按 childNodes 切 run，连续 text / inline 元素合并；
//   - 遇 block 子元素先结束当前 run，再递归进入 block；
//   - 连续两个以上 br 断段，单个 br 只作为同段换行；
//   - script/style/noscript/pre 与显式隐藏子树整棵剪掉。
//
// 过滤策略只处理“明显不该翻”的文本：过短、CJK 占比过高、没有连续英文
// 字母、纯 URL/email、裸 code run。超过 800 字符的 run 会按句子边界拆分，
// 单句仍过长才硬切，避免旧实现把整段长邮件直接丢弃。
//
// 选 node-html-parser 而非 cheerio/jsdom 的理由:
//   - cheerio 拖 parse5 + htmlparser2 + domhandler ~500KB；jsdom 拖 native
//     compile + 几 MB。我们只需要读 DOM，不写回 HTML，node-html-parser
//     50KB 纯 JS 完全够用。
//   - parse 容错好：邮件 HTML 经常是 Outlook 生成的脏 HTML，node-html-parser
//     不会因为未闭合 tag 抛错。
//
// id 仅是 batch 内部稳定键，不写回 SSoT；渲染端仍用 src 文本 fuzzy 匹配。

import { createHash } from 'node:crypto'
import { type HTMLElement, parse } from 'node-html-parser'

import {
  collectRuns,
  type DomAdapter,
  isTranslatableText,
  splitLongText
} from '@shared/lib/translation_blocks'

export interface ExtractedBlock {
  /** 8-字符稳定哈希 ID，基于 DOM path + run/chunk 序号。 */
  id: string
  /** 段落 plaintext（trim 后）。喂给 LLM 的 src。 */
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

/** 计算从 root 到节点的 tag[idx] path（idx 是同 tag 兄弟里的序号）。 */
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

/** 从 body_html 抽出待翻译 run/chunk。返回顺序 = DOM 文档顺序。 */
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
