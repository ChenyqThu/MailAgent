"""Backend 抽象共享数据类型.

字段对齐现有 AppleScriptArm.fetch_email_content_by_id 返回 dict, 让上层 (new_watcher /
handlers / fanout) 切 backend 无感知. 详见 plan §"切换边界 — 命令级抽象".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

BackendOrigin = Literal["applescript", "davmail"]
"""标记 SyncStore 里某行 internal_id 是谁生成的.

- 'applescript': internal_id = Mail.app SQLite ROWID (< 1_000_000_000)
- 'davmail': internal_id = SQLite AUTOINCREMENT 起点 1_000_000_000 (DavMail 时代生成)

详见 plan §"主键 / 邮件标识策略" 方案 D.
"""


@dataclass
class EmailContent:
    """单封邮件的完整内容 (含正文 + raw MIME).

    对齐 AppleScriptArm.fetch_email_content_by_id 返回. DavMailBackend 从
    `IMAP UID FETCH BODY[]` 拿到 raw MIME 后填同样字段.
    """

    message_id: str
    internal_id: int
    subject: str
    sender: str
    date_received: str  # ISO 8601 格式
    content: str  # 邮件正文 (text + html 合并; AppleScript 是 plain text; DavMail 从 MIME body 提取)
    source: str  # 原始 MIME 源码 (RFC 822)
    is_read: bool
    is_flagged: bool
    thread_id: Optional[str]
    mailbox: Optional[str] = None

    # DavMail 时代填充, AppleScript 时代为 None
    imap_uidvalidity: Optional[int] = None
    imap_uid: Optional[int] = None

    def to_legacy_dict(self) -> dict:
        """转成现有 fetch_email_content_by_id() 返回的 dict 形状, 兼容旧代码."""
        return {
            "message_id": self.message_id,
            "subject": self.subject,
            "sender": self.sender,
            "date": self.date_received,
            "content": self.content,
            "source": self.source,
            "is_read": self.is_read,
            "is_flagged": self.is_flagged,
            "thread_id": self.thread_id,
        }


@dataclass
class EmailMeta:
    """邮件元数据 (无正文, 用于 fetch_recent / 雷达).

    对齐 AppleScriptArm.fetch_emails_by_position 返回. 用 dataclass 而不是 dict
    强类型化, 上层切 backend 不会因字段不对吃 KeyError.
    """

    message_id: str
    internal_id: int
    subject: str
    sender: str
    date_received: str
    is_read: bool
    is_flagged: bool
    thread_id: Optional[str] = None
    mailbox: Optional[str] = None

    # DavMail 时代填充
    imap_uidvalidity: Optional[int] = None
    imap_uid: Optional[int] = None


@dataclass
class RadarTick:
    """一次雷达检测结果.

    `current_marker` 是 backend-specific opaque value:
    - AppleScript: int (max_row_id of Envelope Index)
    - DavMail: tuple[int, int] (uidvalidity, uidnext)

    上层不解析 marker 内容, 只透传给下次 detect_new_emails 调用.
    """

    has_new: bool
    current_marker: Any  # backend-specific
    estimated_new_count: int = 0
    new_emails: list[EmailMeta] = field(default_factory=list)
    # AppleScript 雷达可以一次取到所有新邮件元数据 (从 SQLite 直接读), DavMail 时代
    # 只能拿 UID 列表, 然后再 batch fetch headers, 所以 new_emails 在 davmail 路径
    # 通常 lazy 填 (返回时只列 UID, 真要消费时再 fetch).


@dataclass
class BackendHealth:
    """backend 健康检查结果 (stats_reporter 上报飞书告警判定用)."""

    healthy: bool
    backend: BackendOrigin
    details: dict = field(default_factory=dict)
    last_op_latency_ms: Optional[int] = None
    error: Optional[str] = None


DraftMode = Literal["reply-all", "reply", "new", "forward"]


@dataclass
class DraftRequest:
    """append_draft 入参 — 高层 dataclass, 跨 backend 统一语义.

    设计选择 (与 plan 里 `append_draft(mime_bytes)` 的微调):
      - AppleScript 路径需要保留 Mail.app reply 模式自带的"自动引用 + 线程头定位"能力,
        所以 sh 调用必须传 internal_id_for_threading + reply_text, 不能传完整 MIME
        (传 MIME 等于绕开 sh 的关键能力)
      - DavMail 路径内部用 draft_builder.build_reply_mime(self) 拼完整 MIME → IMAP APPEND
      - 接口跨 backend 统一接 DraftRequest, 语义清晰
    """

    mode: DraftMode = "reply-all"

    # reply / reply-all 模式必填: 原邮件 internal_id (定位线程头)
    internal_id_for_threading: Optional[int] = None

    # new 模式必填: 完整收件人; reply* 模式可选 (AppleScript 自动算 reply-all)
    to: list[str] = field(default_factory=list)
    cc: list[str] = field(default_factory=list)
    bcc: list[str] = field(default_factory=list)  # davmail 路径支持; applescript sh 暂不传

    # 主题: reply* 模式可 None 让 AppleScript 自动加 "Re:" 前缀
    subject: Optional[str] = None

    # 正文: plain text + 可选富文本 HTML; 至少其一非空
    reply_text: str = ""
    reply_html: Optional[str] = None

    # 邮件头 (DavMail 路径必填, AppleScript 路径用 sh 自动推断)
    in_reply_to: Optional[str] = None
    references: Optional[str] = None

    # Drafts 文件夹 (留 None 走 backend 默认: AppleScript Mail.app 默认 Drafts, DavMail probe 探测结果)
    drafts_folder: Optional[str] = None

    # forward 模式: 转发引用块 (原文 From/Date/Subject/To 摘要 + 正文), 由 builder 拼在
    # 用户正文之后. CLI/handler 层预格式化 plain + html 两版; reply* 模式留 None.
    forward_intro_text: Optional[str] = None
    forward_intro_html: Optional[str] = None

    # 附件 (filename, content_bytes, mime_type). forward 模式带原邮件常规附件;
    # reply* 一般为空. davmail builder 用 multipart/mixed 嵌套 alternative + 各 attachment.
    attachments: list[tuple[str, bytes, str]] = field(default_factory=list)


@dataclass
class DraftAppendResult:
    """append_draft 返回值."""

    success: bool
    drafts_folder: str  # 实际写入的文件夹名 (probe 探测结果)
    appended_uid: Optional[int] = None  # DavMail IMAP APPEND 返回的 UID (AppleScript 路径为 None)
    method: Optional[str] = None  # AppleScript sh 返回的 method 字段 (internal_id / message_id / fallback / etc)
    error: Optional[str] = None


@dataclass
class SendResult:
    """send_email 返回值 — 真实投递结果 (语义区别于 DraftAppendResult).

    send 关心"是否投递成功 / Message-ID / 是否归档 Sent", 而非"草稿落哪个文件夹".
    """

    success: bool
    message_id: Optional[str] = None  # 生成的 Message-ID (便于前端关联 / 去重)
    sent_folder_uid: Optional[int] = None  # 手动 APPEND 到 Sent 时返回的 UID, 否则 None
    archived_to_sent: bool = False  # 是否做了手动 Sent 归档 (davmail_archive_sent 兜底命中)
    method: Optional[str] = None  # "smtp_davmail" / "smtp_applescript" / etc
    error: Optional[str] = None
