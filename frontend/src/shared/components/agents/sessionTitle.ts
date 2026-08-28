// 会话标题口径的单源（task 08-27-l4-tab-workspace P2 收口）。
//
// 原来是 AgentThreadList 的模块私有函数；主标签面包屑（AgentViewLayout）也要显同一个
// 标题，抄第二份迟早会出现「标签写 A、列表写 B」。抽成叶子模块而不是从 .tsx 导出 ——
// 组件文件导出非组件会破 react-refresh 纪律（eslint 当场红）。

import type { TFunction } from 'i18next'

/** titleOf 只读这三个字段 —— 结构类型而不是 `ChatSessionListItem`，好让「不在列表里、
 *  按 id 单条直取」的 `ChatSession`（没有 email_subject / first_user_message 两个 join
 *  投影）也走同一条口径。`ChatSessionListItem` 天然满足它。 */
export interface SessionTitleSource {
  readonly title?: string | null
  readonly email_subject?: string | null
  readonly first_user_message?: string | null
}

/** Unified title: a stored title wins (manual rename / haiku auto-title); else an email session
 *  shows its subject, a general session the first user message; else "untitled". */
export function titleOf(item: SessionTitleSource, t: TFunction): string {
  return (
    item.title?.trim() ||
    item.email_subject?.trim() ||
    item.first_user_message?.trim() ||
    t('sessions.untitled')
  )
}
