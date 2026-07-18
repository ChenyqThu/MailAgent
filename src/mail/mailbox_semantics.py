"""Mailbox 语义单源 (issue #42 C 案) — canonical 写入常量 + 判定集合 + SQL 辅助。

背景: `email_metadata.mailbox` 存中文 canonical (收件箱/发件箱/草稿箱/存档 +
自定义文件夹解码路径), 但历史/防御变体 (已发送邮件/Sent/草稿/Drafts…) 的判定
枚举散落 ~30 处且宽窄口径不一 (如 feishu 判 sent 用三写法、llm_agent 只认
'发件箱') —— 漏一种写法 = 静默 bug (fork 生产实证: Sent 增量游标漏变体 →
反复全量重拉)。本模块是唯一权威:

- **写入面**只准用 `INBOX_LABEL` / `SENT_LABEL` / `DRAFTS_LABEL` / `ARCHIVE_LABEL`;
- **读取/判定面**只准用 `is_*_mailbox()` 或 `*_MAILBOX_LABELS` 集合
  (含历史防御变体; owner 生产库零变体行, 变体命中仅在 fork / 历史账户出现);
- **SQL 面**用 `sql_in_predicate()` (参数化) / `sql_not_in_or_null()` (字面量,
  labels 恒来自本模块常量, 无注入面)。

层次: 本模块零依赖 (纯常量), 放 src/mail 顶层供 sync_store / backend /
llm_agent / reports / api 等各面 import, 不构成环。历史导出点
`sync_store.DRAFT_MAILBOX_LABELS` 等在原处 re-export 保兼容。
前端镜像: `frontend/src/shared/lib/mailboxSemantics.ts` (改集合两边同步)。
"""

from typing import Iterable, Optional, Sequence, Tuple

# ==================== canonical 写入常量 (唯一权威) ====================

INBOX_LABEL = "收件箱"
SENT_LABEL = "发件箱"
DRAFTS_LABEL = "草稿箱"
ARCHIVE_LABEL = "存档"

# sync_store 历史导出名 (Draft→Sent 提升的目标 label) — 语义同 SENT_LABEL。
SENT_CANONICAL_LABEL = SENT_LABEL

# ==================== 判定变体 (canonical 在首位, 声明序 = SQL 字面量序) ====================

# 已发送/已发送邮件: sync_mailboxes 配置变体 (AppleScript 账户命名差异);
# Sent/Sent Messages/Sent Items: IMAP 原名 / Mail.app 英文账户变体。
SENT_LABEL_VARIANTS: Tuple[str, ...] = (
    SENT_LABEL, "已发送", "已发送邮件", "Sent", "Sent Messages", "Sent Items",
)
# 草稿/Drafts: davmail `_IMAP_TO_MAILBOX_LABEL` 历史写法 + IMAP 原名。
DRAFT_LABEL_VARIANTS: Tuple[str, ...] = (DRAFTS_LABEL, "草稿", "Drafts")
INBOX_LABEL_VARIANTS: Tuple[str, ...] = (INBOX_LABEL, "INBOX")

SENT_MAILBOX_LABELS = frozenset(SENT_LABEL_VARIANTS)
DRAFT_MAILBOX_LABELS = frozenset(DRAFT_LABEL_VARIANTS)
INBOX_MAILBOX_LABELS = frozenset(INBOX_LABEL_VARIANTS)

# 标准邮箱 (非自定义文件夹)。🔴 "存档" **有意**不进 —— PRD §7 D7「存档/草稿箱
# 并入白名单走主链路」, 存档作为可同步自定义文件夹, 享受 L3 默认静默
# (归档邮件不该刷飞书, 这正是想要的)。见 new_watcher L2/L3 gate。
STANDARD_MAILBOXES = INBOX_MAILBOX_LABELS | SENT_MAILBOX_LABELS | DRAFT_MAILBOX_LABELS


# ==================== 判定函数 (读取面唯一入口) ====================

def is_inbox_mailbox(mailbox: Optional[str]) -> bool:
    return (mailbox or "") in INBOX_MAILBOX_LABELS


def is_sent_mailbox(mailbox: Optional[str]) -> bool:
    return (mailbox or "") in SENT_MAILBOX_LABELS


def is_drafts_mailbox(mailbox: Optional[str]) -> bool:
    return (mailbox or "") in DRAFT_MAILBOX_LABELS


def is_archive_mailbox(mailbox: Optional[str]) -> bool:
    return (mailbox or "") == ARCHIVE_LABEL


def is_custom_folder_mailbox(mailbox: Optional[str]) -> bool:
    """mailbox 是自定义文件夹 (多文件夹同步接入的, 非收件箱/发件箱/草稿)。

    注: 存档按自定义文件夹处理 (STANDARD_MAILBOXES 注释), 返回 True。
    """
    return bool(mailbox) and mailbox not in STANDARD_MAILBOXES


# ==================== SQL 辅助 ====================

def sql_in_predicate(column: str, labels: Sequence[str]) -> Tuple[str, Tuple[str, ...]]:
    """参数化 IN 谓词: ("<column> IN (?, ?, ...)", params)。

    labels 传 `*_LABEL_VARIANTS` (有序 tuple) 保 SQL/参数序稳定。
    """
    vals = tuple(labels)
    placeholders = ", ".join("?" for _ in vals)
    return f"{column} IN ({placeholders})", vals


def sql_not_in_or_null(column: str, labels: Iterable[str]) -> str:
    """字面量排除谓词: "(<col> IS NULL OR <col> NOT IN ('a', 'b', ...))"。

    ⚠️ IS NULL 豁免必须带上: SQL 三值逻辑里 `NULL NOT IN (...)` 不成立, 少了它
    历史 mailbox=NULL 行会从跨邮箱读面静默消失。labels 恒来自本模块常量
    (无注入面), 供 email_views / 前端 DRAFTS_EXCLUDE 同款静态拼接场景。
    """
    quoted = ", ".join(f"'{v}'" for v in labels)
    return f"({column} IS NULL OR {column} NOT IN ({quoted}))"
