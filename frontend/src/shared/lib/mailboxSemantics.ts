// Mailbox 语义单源 (issue #42 C 案) — 后端 src/mail/mailbox_semantics.py 的 TS 镜像。
//
// `email_metadata.mailbox` 存中文 canonical (收件箱/发件箱/草稿箱/存档 + 自定义
// 文件夹解码路径)；历史/防御变体 ('草稿'/'Drafts'/'已发送邮件'…) 的判定散落各组件
// 时漏一种写法 = 静默 bug。判定/SQL/view↔mailbox 映射统一从这里 import。
// 🔴 改集合两边同步 (Python 侧有成员锁死单测 tests/mail/test_mailbox_semantics.py)。

import type { EmailView } from '@shared/state/email-filter'

// ---- canonical 写入常量 (写入面只准用这些) ---------------------------------

export const INBOX_LABEL = '收件箱'
export const SENT_LABEL = '发件箱'
export const DRAFTS_LABEL = '草稿箱'
export const ARCHIVE_LABEL = '存档'

// ---- 判定变体 (canonical 首位, 声明序 = SQL 字面量序; 与 Python 侧一致) ----

export const SENT_MAILBOX_LABELS: readonly string[] = [
  SENT_LABEL,
  '已发送',
  '已发送邮件',
  'Sent',
  'Sent Messages',
  'Sent Items'
]
export const DRAFT_MAILBOX_LABELS: readonly string[] = [DRAFTS_LABEL, '草稿', 'Drafts']

export function isSentMailbox(mailbox: string | null | undefined): boolean {
  return SENT_MAILBOX_LABELS.includes(mailbox ?? '')
}

export function isDraftsMailbox(mailbox: string | null | undefined): boolean {
  return DRAFT_MAILBOX_LABELS.includes(mailbox ?? '')
}

// ---- SQL 谓词 (main 进程 SQLite 直查用; serve-api email_views.py 同款镜像) ----
//
// ⚠️ IS NULL 豁免必须带上：SQL 三值逻辑里 `NULL NOT IN (...)` 不成立，少了它
// 历史 mailbox=NULL 行会从所有跨邮箱读面静默消失（codex review MEDIUM）。
export const DRAFTS_EXCLUDE_SQL = `(mailbox IS NULL OR mailbox NOT IN (${DRAFT_MAILBOX_LABELS.map(
  (l) => `'${l}'`
).join(', ')}))`

// ---- view ↔ mailbox 双向映射 (Sidebar / CommandPalette / EventDetailDrawer /
// useEmailListRows 共用; flagged/all 是跨邮箱虚拟视图无具体 mailbox) ----------

export function mailboxForView(view: EmailView): string | null {
  if (view === 'inbox') return INBOX_LABEL
  if (view === 'outbox') return SENT_LABEL
  if (view === 'drafts') return DRAFTS_LABEL
  return null
}

export function viewForMailbox(mailbox: string | null | undefined): EmailView {
  if (mailbox === INBOX_LABEL) return 'inbox'
  if (mailbox === SENT_LABEL) return 'outbox'
  if (mailbox === DRAFTS_LABEL) return 'drafts'
  return 'all'
}
