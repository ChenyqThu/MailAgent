// L4 群聊 — 发送框 @ 提及解析（纯函数叶子，零 react / 零 api import）。
//
// 约定（任务规格 §3）：文本里出现 `@成员显示名` 即点名该成员；有点名 → 只有被点名的成员
// 回复，无点名 → 全员按成员序各回一轮（labs on 时改为 realtime 成员）。解析规则与匹配纪律见
// ai-gateway/groupChat.ts 的 parseGroupMentions（本文件只 re-export + 补全探测）。

/** 解析单源 = gateway groupChat.ts 的 parseGroupMentions（显式纯叶子，type-only imports 之外
 *  只引 groupFloors 常量）——g1 把它下沉到服务端调度器后，renderer 经这里共用同一份，
 *  不手抄第二份匹配口径（照 members.ts 对 parseGroupMemberIds 的先例）。 */
export {
  parseGroupMentions,
  type GroupMentionMember
} from '../../../../ai-gateway/groupChat'

/** 补全触发探测：光标前最后一个 `@` 起的未完成片段（`@` 后无空白/换行）。
 *  返回 null = 不在补全语境；返回 { query, start } = 弹层按 query 过滤成员，
 *  start = `@` 在文本中的下标（供插入时替换）。 */
export function detectMentionDraft(
  text: string,
  caret: number
): { query: string; start: number } | null {
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  const fragment = upto.slice(at + 1)
  if (/[\s\n]/.test(fragment)) return null
  return { query: fragment, start: at }
}
