// T3 群聊话题 — 群行「要不要亮」的判据，群列表行 / rail 群聊格 / peek 三处共用：
// 群行自己的未读（`isSessionUnread` 单源，不动）‖ 底下有未读话题（serve-api 派生列
// `has_unread_threads`）。话题回复只 bump 话题行的 updated_at，父群行一动不动 —— 没有第二半，
// 别人在话题里回了你、群列表永远不亮。
//
// 🔴 `=== true`：缺省 / 旧 serve-api → undefined → 不亮，与 isSessionUnread 对 NULL 水位的口径一致
// （宁可不亮，不能整列亮起来）。

import type { ChatSession } from '@shared/api/types'

import { isSessionUnread } from './chatUnread'

export function isGroupRowUnread(
  item: Pick<ChatSession, 'updated_at'> & {
    last_read_at?: number | null
    has_unread_threads?: boolean
  }
): boolean {
  return isSessionUnread(item) || item.has_unread_threads === true
}
