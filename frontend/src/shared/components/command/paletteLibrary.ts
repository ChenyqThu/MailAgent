// 资料库检索面的共享叶子 —— ⌘K 第五 lane 与 `/search` 页组共用（design
// 09-02-library-knowledge-base §9.1 / §9.5）。形状照 `paletteMatters.ts`：纯函数 +
// 常量，不 import 组件、不 import store。
//
// 🔴 资料库搜索是**纯关键词**，不接邮件的字段语法（`from:` / `in:` 那套）：邮件 DSL 的
// parser 硬编 `email_metadata` 别名，字段词表也全是邮件语义。所以这里既没有 DSL 提示
// 词表，UI 文案也不许暗示有字段语法 —— 塞进去只会被当字面文本召回归零。

import type { LibrarySearchHit } from '@shared/api/types/library'

/** 两个入口共用的截断口径。🔴 与 `qk.library.paletteSearch` 绑定：同一个 query key 的
 *  两个消费方必须同 limit，否则彼此读到对方形状（contacts 组同款纪律）。 */
export const LIBRARY_MAX_HITS = 8

/** 服务端 warning 码 → i18n key。
 *
 *  🔴 `warnings` 是**复数数组**（`LibrarySearchResponse.warnings`），调用方逐条渲染，
 *  不要只取 `[0]`。P2 服务端只发一种码（`cjk_too_short:<字>`，中文 1 个字整串既进不了
 *  trigram 也不该退化成全表 LIKE），但形状是数组，UI 就按数组做。 */
export function libraryWarningLabelKey(code: string): string {
  return code.split(':')[0] === 'cjk_too_short'
    ? 'library.search.tooShort'
    : 'library.search.warnGeneric'
}

/** snippet 的一段：`hit` 为 true 的段是服务端标出来的命中处。 */
export interface LibrarySnippetSegment {
  text: string
  hit: boolean
}

/**
 * FTS5 snippet 的命中标记 → 可渲染的分段。
 *
 * 🔴 资料库的 `snippet()` 用的是 `[` / `]` 一对**字面括号**，不是 `<mark>`（见
 * `src/library/repository.py::search`）—— 所以这条腿不能照抄 EmailHitRow 的
 * 「DOMPurify + dangerouslySetInnerHTML」写法。切成段之后按 React 节点渲染，正文
 * 一个字符都不进 innerHTML，也就不需要消毒。
 *
 * 落单的 `[`（正文自带、没有配对的 `]`）连同其后的文本一起当普通文本，不吞字符。
 * 2 字 LIKE 那条腿的 snippet 本来就没有标记，会原样返回单独一段 `hit:false`。
 */
export function parseLibrarySnippet(snippet: string | null | undefined): LibrarySnippetSegment[] {
  const raw = snippet ?? ''
  if (raw.length === 0) return []
  const out: LibrarySnippetSegment[] = []
  let cursor = 0
  while (cursor < raw.length) {
    const open = raw.indexOf('[', cursor)
    const close = open < 0 ? -1 : raw.indexOf(']', open + 1)
    if (open < 0 || close < 0) {
      out.push({ text: raw.slice(cursor), hit: false })
      break
    }
    if (open > cursor) out.push({ text: raw.slice(cursor, open), hit: false })
    const inner = raw.slice(open + 1, close)
    if (inner.length > 0) out.push({ text: inner, hit: true })
    cursor = close + 1
  }
  return out
}

/** 投影行（邮件附件）不在 `library_file` 里，`GET /library/search` 恒不返回它们；
 *  这里滤掉 `id === null` 是**类型上的守卫**，不是业务分支 —— 没有 id 就没有深链去处，
 *  渲染出来只会是一行点不动的结果。 */
export function libraryAddressableHits(
  hits: readonly LibrarySearchHit[]
): Array<LibrarySearchHit & { id: number }> {
  return hits.filter((hit): hit is LibrarySearchHit & { id: number } => hit.id !== null)
}

// 深链（`/library?file={id}`）**不在这里**：单源是 `components/library/deeplink.ts`
// 的 `libraryFileHref` / `navigateToLibraryFile`，与「另存到资料库」等回执共用同一个
// 去处（design §9.5 + F3）。两个入口直接 import 那一份。
