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
export const INBOX_MAILBOX_LABELS: readonly string[] = [INBOX_LABEL, 'INBOX']

export function isInboxMailbox(mailbox: string | null | undefined): boolean {
  return INBOX_MAILBOX_LABELS.includes(mailbox ?? '')
}

export function isSentMailbox(mailbox: string | null | undefined): boolean {
  return SENT_MAILBOX_LABELS.includes(mailbox ?? '')
}

export function isDraftsMailbox(mailbox: string | null | undefined): boolean {
  return DRAFT_MAILBOX_LABELS.includes(mailbox ?? '')
}

// ---- 列表过滤展开 (内建视图 canonical vs 自定义文件夹名) --------------------

/**
 * 把列表查询收到的单个 mailbox 值展开成该查询该认的全部 label。
 *
 * canonical (收件箱/发件箱/草稿箱) → 对应变体全集; 其他值 (自定义同步文件夹的
 * display_name / 存档) → 原值单元素 (精确匹配语义不变)。列表查询面只拿到一个
 * 字符串, 分不清内建视图与自定义文件夹 —— 按 canonical 命中展开正好切开两者。
 *
 * issue #42 后续 (提交者 fork 生产实证): 之前内建三视图恒精确匹配, 变体行
 * (INBOX/Sent/草稿) 在专属视图**不可见**, 只在「所有邮件」露出, 而判定面
 * (Sent 游标/报告/飞书) 已认全变体。
 *
 * 🔴 已知取舍: 变体集含 'Sent'/'Sent Items'/'INBOX' 等英文名, 英文 Exchange 环境
 * 用户**可能有同名的自定义同步文件夹** → 那些行会同时出现在内建视图和该文件夹
 * 视图 (**重复显示, 不丢数据**)。相比「变体行哪儿都看不到」这是可接受的降级。
 * owner 生产库零变体行 → 逐字节等价。
 *
 * 后端单源镜像: `src/mail/mailbox_semantics.py::filter_labels_for_mailbox`。
 */
export function mailboxFilterLabels(mailbox: string): readonly string[] {
  if (isInboxMailbox(mailbox)) return INBOX_MAILBOX_LABELS
  if (isSentMailbox(mailbox)) return SENT_MAILBOX_LABELS
  if (isDraftsMailbox(mailbox)) return DRAFT_MAILBOX_LABELS
  return [mailbox]
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

// 反向映射按判定集 —— 与 mailboxFilterLabels 同径: 列表既然认变体, 从搜索结果/
// 日历抽屉点一条 mailbox='INBOX' 的行就该落到收件箱视图, 而不是退回「所有邮件」。
// 存档 / 自定义文件夹仍落 'all' (它们没有内建视图, 由 SidebarFolderTree 承载)。
export function viewForMailbox(mailbox: string | null | undefined): EmailView {
  if (isInboxMailbox(mailbox)) return 'inbox'
  if (isSentMailbox(mailbox)) return 'outbox'
  if (isDraftsMailbox(mailbox)) return 'drafts'
  return 'all'
}
