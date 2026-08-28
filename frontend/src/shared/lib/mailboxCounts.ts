// 文件夹下拉（列表头选择器）的计数口径单源 —— owner 0828 dogfood 拍板：
//
//   收件箱 = 未读 · 草稿箱 = 总数 · 已标旗 = 总数 · 所有邮件 = 未读 · 自定义文件夹 = 各自未读
//
// 发件箱不显计数（退役前的侧栏 MAILBOXES 段也没有它的徽标）。草稿箱是自己写的，
// 「未读」在那儿没有意义，故用总数。
//
// 数据源是 `email.listMailboxes()`（按 `email_metadata.mailbox` **原值** GROUP BY 的
// per-mailbox 汇总），与退役的侧栏徽标同一条链。
//
// 🔴 徽标与列表必须同径（issue #42 两轮前科）：listMailboxes 按原值分组，变体行
// （INBOX / Drafts / Sent Items…）自成一组；而列表查询按 `mailboxFilterLabels()` 展开
// 的判定集 `IN (...)` 认全变体（main/handlers/email.ts::buildListWhere）。这里若对内建
// canonical 用 `=` 精确匹配求和，就成了「列表显 6 值、徽标算 1 值」。自定义文件夹名不在
// 任何判定集里 → `mailboxFilterLabels` 返回单元素 = 精确匹配，语义不变。

import type { MailboxSummary } from '@shared/api/types'
import type { EmailView } from '@shared/state/email-filter'

import { isDraftsMailbox, mailboxFilterLabels, mailboxForView } from './mailboxSemantics'

type CountField = 'total' | 'unread' | 'flagged'

/** 按判定集求和：内建 canonical → 变体全集；自定义文件夹名 → 单元素精确匹配。 */
function sumByLabels(
  summaries: readonly MailboxSummary[],
  mailbox: string,
  field: CountField
): number {
  const labels = mailboxFilterLabels(mailbox)
  let sum = 0
  for (const s of summaries) if (labels.includes(s.mailbox)) sum += s[field]
  return sum
}

/** 跨邮箱虚拟视图（已标旗 / 所有邮件）求和。🔴 必须排除草稿：列表查询未指定 mailbox
 *  时走 `DRAFTS_EXCLUDE_SQL`，徽标不排就与列表行数对不上。 */
function sumCrossMailbox(summaries: readonly MailboxSummary[], field: CountField): number {
  let sum = 0
  for (const s of summaries) if (!isDraftsMailbox(s.mailbox)) sum += s[field]
  return sum
}

/** 内建视图行的计数；null = 这一档不显计数（发件箱）。 */
export function mailboxViewCount(
  summaries: readonly MailboxSummary[],
  view: EmailView
): number | null {
  switch (view) {
    case 'inbox':
    case 'drafts': {
      // view↔mailbox 映射的单源仍在 mailboxSemantics，这里不手写 canonical 字面量。
      const mailbox = mailboxForView(view)
      if (mailbox === null) return null
      return sumByLabels(summaries, mailbox, view === 'inbox' ? 'unread' : 'total')
    }
    case 'flagged':
      return sumCrossMailbox(summaries, 'flagged')
    case 'all':
      return sumCrossMailbox(summaries, 'unread')
    case 'outbox':
      return null
  }
}

/** 自定义同步文件夹行的计数 = 该文件夹的未读数（过滤 key 是完整 display_name）。 */
export function folderUnreadCount(
  summaries: readonly MailboxSummary[],
  fullDisplayName: string
): number {
  return sumByLabels(summaries, fullDisplayName, 'unread')
}
