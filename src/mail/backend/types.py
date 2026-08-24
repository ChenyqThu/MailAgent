"""Backend 抽象共享数据类型.

字段对齐现有 AppleScriptArm.fetch_email_content_by_id 返回 dict, 让上层 (new_watcher /
handlers / fanout) 切 backend 无感知. 详见 plan §"切换边界 — 命令级抽象".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

BackendOrigin = Literal["applescript", "davmail", "outlook_com"]
"""标记 SyncStore 里某行 internal_id 是谁生成的.

- 'applescript': internal_id = Mail.app SQLite ROWID (< 1_000_000_000)
- 'davmail': internal_id = SQLite AUTOINCREMENT 起点 1_000_000_000 (DavMail 时代生成)
- 'outlook_com': internal_id 与 davmail 共用同一 allocate_davmail_internal_id 序列
  (语义只是「本地合成 id, >= 10^9」); 定位元数据 = email_metadata.entry_id 缓存
  (EntryID 会漂移, 稳定锚仍是 message_id — 见 task 08-12 prd §2.2-2)

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

    # 直接父邮件 message_id (In-Reply-To 头, 无尖括号)。thread_id=线程根, 二者分开。
    in_reply_to: Optional[str] = None

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
            "in_reply_to": self.in_reply_to,
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

    # 内联图部件 (filename, content_bytes, mime_type, content_id) — draft-edit 保真集
    # (task 08-20 draft-save D2): 正文 html 引用 cid:{content_id} 的库内 inline 附件。
    # builder 仅在最终 html 确实引用该 cid 时以 multipart/related 编回对应 part
    # (本地路径 src 已由 _embed_local_inline_images 另行嵌入新 cid, 原 cid 未被引用
    # 则跳过, 不产孤儿 part)。
    inline_attachments: list[tuple[str, bytes, str, str]] = field(default_factory=list)

    # 邮件重要性 (high / normal / low, 大小写不敏感). high/low 写 Importance + X-Priority +
    # X-MSMail-Priority 三组业界标准头 (Outlook/Exchange 都认); normal/None/其它 不写头.
    importance: Optional[str] = None


@dataclass
class DraftAppendResult:
    """append_draft 返回值."""

    success: bool
    drafts_folder: str  # 实际写入的文件夹名 (probe 探测结果)
    appended_uid: Optional[int] = None  # DavMail IMAP APPEND 返回的 UID (AppleScript 路径为 None)
    method: Optional[str] = None  # AppleScript sh 返回的 method 字段 (internal_id / message_id / fallback / etc)
    error: Optional[str] = None
    # 草稿即时落库 (compose_draft → email_metadata) 用: MIME 的 Message-ID (去尖括号)
    # + APPENDUID 响应的 UIDVALIDITY。AppleScript 路径均为 None。
    message_id: Optional[str] = None
    appended_uidvalidity: Optional[int] = None


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


@dataclass
class InboxReconcileResult:
    """收件箱对账 (2026-08-11 丢邮件事故 · 方案 C) 的一轮结果。

    ``status`` 三值:

    - ``complete``   — 窗口被截断视图完整覆盖, 本轮结论可信 (真的"查全了");
    - ``incomplete`` — 视图截断打断了窗口 (folderSizeLimit 容量不足 / 长时间停摆),
      **补抓照做但不能记成一次成功对账** —— 窗口更老的那段根本不可见, 缺什么都
      判断不出来。少了这个区分, 对账会在容量不足时静默失去兜底能力;
    - ``skipped``    — SELECT/SEARCH 失败、UIDVALIDITY 异常等, 本轮整轮作废。

    ``missing`` 是可直接喂 ``save_email`` 的 payload(已带 internal_id /
    backend_origin / mailbox / ingest_reason)。

    异常通道计数 (见 ``empty_msgid`` / ``duplicate_msgid``): 远端存在无 Message-ID
    或重复 Message-ID 的邮件时单独计数并告警, **不混进正常的集合差** ——
    当前 schema 的 ``message_id TEXT UNIQUE`` 无法表达"两封物理邮件共用一个
    Message-ID", 这是已知能力边界, 必须留痕而不是静默合并。
    """

    status: str
    missing: list = field(default_factory=list)
    remote_total: int = 0
    oldest_visible_iso: Optional[str] = None
    window_floor_iso: Optional[str] = None
    empty_msgid: int = 0
    duplicate_msgid: int = 0
    reason: Optional[str] = None
