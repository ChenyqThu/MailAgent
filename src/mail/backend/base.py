"""IMailBackend Protocol — 邮件后端抽象接口.

切换边界 (详见 plan §"切换边界 — 什么走 backend, 什么不走"):
1. 写入 SQLite 的数据源 (正向 sync: fetch + 雷达)
2. SQLite outbox fanout 写回的接口 (反向 sync: flag/read + draft create)

不属于本接口: SQLite SSoT / NotionSync / LLM Agent / FanoutWorker 调度 / handler
入口 / webhook 接收 / 飞书通知 / meeting_sync iCalendar 解析 / 前端 IPC.

实现:
- src/mail/backend/applescript_backend.AppleScriptBackend (FALLBACK)
- src/mail/backend/davmail_backend.DavMailBackend (PRIMARY when MAILAGENT_BACKEND=davmail)
"""
from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable

from src.mail.backend.types import (
    BackendHealth,
    BackendOrigin,
    DraftAppendResult,
    DraftRequest,
    EmailContent,
    EmailMeta,
    RadarTick,
    SendResult,
)


class BackendStartupError(RuntimeError):
    """backend probe 失败时抛出.

    main.py 捕获后 print 友好的切换提示 + exit(1). PM2 ecosystem
    autorestart=false 配合, 不会死循环重试.
    """

    def __init__(self, backend: BackendOrigin, reason: str, fallback_hint: str = ""):
        self.backend = backend
        self.reason = reason
        self.fallback_hint = fallback_hint
        super().__init__(f"[{backend}] backend 启动失败: {reason}")


@runtime_checkable
class IMailBackend(Protocol):
    """邮件后端协议. 9 个方法对齐 plan §"切换边界 — 命令级抽象".

    所有方法都是同步签名 — IMAP/AppleScript 都是阻塞 IO, 调用方 (FanoutWorker /
    new_watcher) 用 asyncio.to_thread 包. 不在 Protocol 强制 async, 让单元测试简单.

    幂等性: mark_as_read / set_flag / append_draft 都是协议层幂等 (重复操作无副作用).
    """

    backend_origin: BackendOrigin
    """标记本 backend 抓的新邮件应该用哪个 backend_origin 写 SQLite."""

    # =========================================================================
    # 启动 / 健康检查
    # =========================================================================

    def probe_readiness(self) -> tuple[bool, str]:
        """启动时 readiness probe.

        AppleScript: Mail.app 进程存活 + Envelope Index 可读.
        DavMail: TCP probe 1143/1025 + IMAP LOGIN + SELECT INBOX.

        Returns:
            (ok, detail). ok=False 时调用方 raise BackendStartupError.
        """
        ...

    def health_status(self) -> BackendHealth:
        """运行时健康检查 (stats_reporter 定期调).

        DavMail 额外含: token 剩余天数, 最近一次 IMAP 操作 latency, 端口状态.
        """
        ...

    # =========================================================================
    # 正向 sync — 雷达 + 邮件抓取
    # =========================================================================

    def detect_new_emails(self, marker: Any = None) -> RadarTick:
        """检测自 marker 以来的新邮件.

        AppleScript: marker=int (max_row_id), 查 Envelope Index `WHERE ROWID > marker`.
        DavMail: marker=(uidvalidity, uidnext), 查 `IMAP STATUS INBOX (UIDNEXT)` 跟 marker 对比.

        marker=None 时返回当前 marker 不算新邮件 (启动 baseline).
        """
        ...

    def fetch_email_by_id(
        self, internal_id: int, *, mailbox: Optional[str] = None
    ) -> Optional[EmailContent]:
        """通过 SyncStore internal_id 抓单封邮件完整内容.

        AppleScript: `whose id is <internal_id>` (~1s, v3 快路径).
        DavMail:
            1. 查 SyncStore 拿 (imap_uidvalidity, imap_uid)
            2. NULL fallback: 查 message_id → `IMAP UID SEARCH HEADER Message-ID "..."`
               反查 + backfill 这一行的 imap_uid
            3. `IMAP UID FETCH UID BODY.PEEK[]` 拿 raw MIME
            4. 解析 MIME → EmailContent

        失败返回 None (不抛异常, 让上层走 retry queue).
        """
        ...

    def fetch_recent(
        self, count: int, *, mailbox: Optional[str] = None
    ) -> list[EmailMeta]:
        """按位置抓最近 N 封邮件元数据 (用于初始化同步 / health-check).

        AppleScript: `repeat with i from N-count to N` (按位置).
        DavMail: `IMAP UID SEARCH ALL` 取末尾 count 个 UID → BATCH FETCH headers.
        """
        ...

    # =========================================================================
    # 反向 sync — flag / read 操作 (outbox fanout 调)
    # =========================================================================

    def mark_as_read(
        self, internal_id: int, read: bool, *, mailbox: Optional[str] = None
    ) -> bool:
        """标记已读/未读.

        AppleScript: `set read status to <bool>`.
        DavMail: `IMAP UID STORE ±FLAGS (\\Seen)`.
        协议层幂等.
        """
        ...

    def set_flag(
        self, internal_id: int, flagged: bool, *, mailbox: Optional[str] = None
    ) -> bool:
        """设置/取消旗标.

        AppleScript: `set flagged status to <bool>`.
        DavMail: `IMAP UID STORE ±FLAGS (\\Flagged)`.
        协议层幂等.
        """
        ...

    # =========================================================================
    # 草稿创建 (handle_create_draft 调)
    # =========================================================================

    def append_draft(self, draft: DraftRequest) -> DraftAppendResult:
        """创建邮件草稿到 Drafts 文件夹.

        AppleScript: subprocess 调 scripts/create_reply_draft.sh (GUI 注入老路径), 利用
            Mail.app reply 模式自带的"自动引用 + 线程头定位"能力. DraftRequest 字段
            映射到 sh 的 --internal-id / --reply-text / --mode / --to / --cc 等.
        DavMail: 内部用 draft_builder.build_reply_mime(draft) 拼完整 MIME → IMAP APPEND
            到 draft.drafts_folder or self.davmail_drafts_folder (probe 探测结果).
        """
        ...

    # =========================================================================
    # 真实发送 (email send 命令 / 前端发送按钮调)
    # =========================================================================

    def send_email(self, draft: DraftRequest) -> SendResult:
        """真实发送邮件 (对外不可逆). 调用方负责二次确认 (CLI --yes / 前端弹窗).

        DavMail: smtp_session(cfg) + 拼 MIME (复用 _build_mime) + smtp.send_message;
            可选手动 APPEND 一份到 Sent (cfg.davmail_archive_sent 兜底, 默认关).
        AppleScript: fallback 也走 SMTP (复用 sender.py), 因 cfg 端口都指向 DavMail JVM.

        失败返回 SendResult(success=False, error=...), 不抛异常.
        """
        ...
