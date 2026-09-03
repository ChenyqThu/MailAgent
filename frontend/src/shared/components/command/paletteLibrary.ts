// 资料库检索面的共享叶子 —— ⌘K 第五 lane 与 `/search` 页组共用（design
// 09-02-library-knowledge-base §9.1 / §9.5）。形状照 `paletteMatters.ts`：纯函数 +
// 常量，不 import 组件、不 import store。
//
// 🔴 资料库搜索是**纯关键词**，不接邮件的字段语法（`from:` / `in:` 那套）：邮件 DSL 的
// parser 硬编 `email_metadata` 别名，字段词表也全是邮件语义。所以这里既没有 DSL 提示
// 词表，UI 文案也不许暗示有字段语法 —— 塞进去只会被当字面文本召回归零。

import type { useNavigate } from '@tanstack/react-router'

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

/** 资料库深链（design §9.5）：`/library?file={id}`，落地 = 进域 + 展开所在文件夹 +
 *  选中文件；`missing` / `trashed` 由落地页自己 toast。 */
export const LIBRARY_ROUTE = '/library'

export function libraryFileLinkTarget(fileId: number): {
  to: string
  search: { file: number }
} {
  return { to: LIBRARY_ROUTE, search: { file: fileId } }
}

type PaletteNavigate = ReturnType<typeof useNavigate>
type LooseNavigate = (options: { to: string; search?: Record<string, unknown> }) => unknown

/**
 * 跳到某个库文件。
 *
 * 🔴 `/library` 还不是已注册的路由（资料库导航接入是另一条 lane），TanStack 的 `to`
 * 是路由字面量联合类型 ⇒ 这里必须绕过一次类型检查。**绕过只在这一行**：路由落地后把
 * 下面的 `as unknown as LooseNavigate` 删掉即可，目标形状与所有调用点都不用动。
 * 同一处缺口在 `NotificationPanel.tsx::activate` 的 `case 'library'` 也有一份占位。
 */
export function navigateToLibraryFile(navigate: PaletteNavigate, fileId: number): void {
  void (navigate as unknown as LooseNavigate)(libraryFileLinkTarget(fileId))
}
