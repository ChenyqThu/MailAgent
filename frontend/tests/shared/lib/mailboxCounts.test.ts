// 计数口径（0903 返工 A3）。
//
// 「哪一档内建视图的计数是未读」曾在 EmailListHeader 里手抄成第二份名单（红点用），
// 与 mailboxCounts 的取数各写一遍 —— 改口径漏改一处就是「草稿箱有 5 封 → 画成有未读」。
// 现在名单收成 mailboxCounts 内部一张表，`mailboxViewCount` 与 `viewCountIsUnread` 同读它。
// 本文件钉的就是「表 = 实际取数」：谁再在 mailboxViewCount 里写死字段，下面第二条会红。

import { describe, expect, test } from 'vitest'

import { mailboxViewCount, viewCountIsUnread } from '@shared/lib/mailboxCounts'
import { DRAFTS_LABEL, INBOX_LABEL } from '@shared/lib/mailboxSemantics'
import type { MailboxSummary } from '@shared/api/types'
import type { EmailView } from '@shared/state/email-filter'

/** 全部内建视图。`satisfies Record<EmailView, …>` 是这里的穷尽闸：EmailView 加一档
 *  而这里漏填 → 缺键，类型闸当场红（下面两条断言就不会漏掉新视图）。 */
const ALL_VIEWS = Object.keys({
  inbox: 0,
  outbox: 0,
  drafts: 0,
  flagged: 0,
  all: 0
} satisfies Record<EmailView, number>) as EmailView[]

/** 四个字段互不相等 —— 取错字段一定看得出来。 */
const SUMMARIES: readonly MailboxSummary[] = [
  { mailbox: INBOX_LABEL, total: 100, unread: 7, flagged: 3, failed: 0 },
  { mailbox: DRAFTS_LABEL, total: 5, unread: 11, flagged: 13, failed: 0 }
]

/** 同一批数据把未读清零：口径是未读的那几档必然算出 0，其余口径必然 > 0。 */
const ZERO_UNREAD: readonly MailboxSummary[] = SUMMARIES.map((s) => ({ ...s, unread: 0 }))

describe('mailboxViewCount 的口径', () => {
  test('owner 0828 拍板的口径表：收件箱=未读 · 草稿箱=总数 · 已标旗=旗标 · 所有邮件=未读 · 发件箱不显', () => {
    expect(mailboxViewCount(SUMMARIES, 'inbox')).toBe(7)
    expect(mailboxViewCount(SUMMARIES, 'drafts')).toBe(5)
    // 跨邮箱两档排除草稿箱（与列表查询的 DRAFTS_EXCLUDE_SQL 同径）。
    expect(mailboxViewCount(SUMMARIES, 'flagged')).toBe(3)
    expect(mailboxViewCount(SUMMARIES, 'all')).toBe(7)
    expect(mailboxViewCount(SUMMARIES, 'outbox')).toBeNull()
  })

  test('🔴 viewCountIsUnread 与实际取数同源（红点判据不许再抄第二份名单）', () => {
    for (const view of ALL_VIEWS) {
      const count = mailboxViewCount(ZERO_UNREAD, view)
      if (count === null) {
        // 不显计数的那一档谈不上「口径是未读」。
        expect(viewCountIsUnread(view), view).toBe(false)
        continue
      }
      // 未读全清零 ⇒ 未读口径恒 0，总数 / 旗标口径恒 > 0。
      expect(viewCountIsUnread(view), view).toBe(count === 0)
    }
  })
})
