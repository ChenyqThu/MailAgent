"""IMailBackend Protocol — 邮件后端抽象接口.

E1 契约收口 (2026-07, 方案 B): Protocol 方法集 = 全系统真实消费的 arm/radar 面
(盘点见 docs/plans/architecture-review-2026-07/e1-contract-inventory.md), 不再是
Sprint 16 的 typed 理想面. 调用方 (NewWatcher / handlers / fanout / reverse_sync /
builders / CLI) 直接持 IMailBackend 调方法, 无 arm-compat 影子层.

切换边界:
1. 写入 SQLite 的数据源 (正向 sync: 雷达 + fetch)
2. SQLite outbox fanout 写回的接口 (反向 sync: flag/read + draft/send)

不属于本接口: SQLite SSoT / NotionSync / LLM Agent / FanoutWorker 调度 / handler
入口 / webhook 接收 / 飞书通知 / meeting_sync iCalendar 解析 / 前端 IPC.

实现:
- src/mail/backend/applescript_backend.AppleScriptBackend (FALLBACK; 内部委托
  AppleScriptArm + SQLiteRadar)
- src/mail/backend/davmail_backend.DavMailBackend (PRIMARY when MAILAGENT_BACKEND=davmail)
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from src.mail.backend.types import (
    BackendOrigin,
    DraftAppendResult,
    DraftRequest,
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


class MarkerUnavailableError(Exception):
    """marker (get_current_max_row_id) 查询失败时抛出.

    修复前失败塌成 return 0, 与「真实 marker 0」(applescript 空邮箱) 不可区分;
    首次 baseline 会把 0 持久化成 marker → 下轮 get_new_emails(0) 对 INBOX 发
    `UID 1:*` 全量重刷 (7万+ 封实测 STATUS 超时触发过, 见 task 07-14 L3)。
    调用方语义: check_for_changes 捕获后按「本轮无新邮件」fail-safe (marker 不动,
    下轮自愈); 首次 baseline 捕获后重试, 仍失败宁可不启动也不落 0。
    """


@runtime_checkable
class IMailBackend(Protocol):
    """邮件后端协议 — 真实消费面 (17 方法).

    所有方法都是同步签名 — IMAP/AppleScript 都是阻塞 IO, 调用方 (FanoutWorker /
    NewWatcher) 用 asyncio.to_thread 包. 不在 Protocol 强制 async, 让单元测试简单.

    幂等性: mark_as_read* / set_flag* / append_draft 都是协议层幂等 (重复操作无副作用).

    邮件 payload 用 legacy dict (AppleScriptArm 历史形状: message_id / subject /
    sender / date / content / source / is_read / is_flagged / thread_id ...),
    这是全部调用方的事实契约; typed dataclass (EmailContent / EmailMeta) 仅作
    backend 内部实现细节.
    """

    backend_origin: BackendOrigin
    """标记本 backend 抓的新邮件应该用哪个 backend_origin 写 SQLite."""

    # =========================================================================
    # 启动 probe
    # =========================================================================

    def probe_readiness(self) -> tuple[bool, str]:
        """启动时 readiness probe.

        AppleScript: Mail.app Envelope Index 可读 (隐含进程存活 + FDA 权限).
        DavMail: TCP probe 1143/1025 + IMAP LOGIN + NOOP.

        Returns:
            (ok, detail). ok=False 时调用方 (factory) raise BackendStartupError.
        """
        ...

    # =========================================================================
    # 正向 sync — 雷达 (原 SQLiteRadar 面; marker 语义按 backend 各自定义:
    # AppleScript = Envelope Index max ROWID, DavMail = INBOX UIDNEXT)
    # =========================================================================

    def is_available(self) -> bool:
        """雷达可用性 (AppleScript: Envelope Index 可读; DavMail: IMAP 端口通)."""
        ...

    def get_current_max_row_id(self) -> int:
        """当前 marker (启动 baseline / 首次运行定基线用).

        成功返回真实 marker (applescript 空邮箱可为 0; davmail UIDNEXT 恒 >= 1);
        查询失败 raise MarkerUnavailableError (不得以 0 伪装成功, 见该异常 docstring)。
        """
        ...

    def check_for_changes(self, last_max_row_id: int) -> tuple[bool, int, int]:
        """自 marker 以来是否有新邮件.

        Returns:
            (has_new, current_marker, estimated_new_count)
        """
        ...

    def get_new_emails(self, since_row_id: int) -> list[dict]:
        """取 marker 之后的新邮件元数据 dict 列表.

        AppleScript: Envelope Index `ROWID > since_row_id`, internal_id = ROWID.
        DavMail: 多 folder UID SEARCH + BATCH FETCH; 每条已分配独立 internal_id
        (>= 10^9, allocate_davmail_internal_id) 并填好 imap_uid / imap_uidvalidity /
        backend_origin='davmail' / mailbox.
        """
        ...

    def set_last_max_row_id(self, row_id: int) -> None:
        """写 marker 内存缓存 (持久化由调用方走 sync_store, 两 backend 一致)."""
        ...

    def get_last_max_row_id(self) -> int:
        """读 marker 内存缓存."""
        ...

    # =========================================================================
    # 正向 sync — 邮件抓取 (原 AppleScriptArm 面, legacy dict 返回)
    # =========================================================================

    def fetch_email_content_by_id(
        self, internal_id: int, mailbox: Optional[str] = None, *, update_uid: bool = True
    ) -> Optional[dict]:
        """通过 SyncStore internal_id 抓单封邮件完整内容 (legacy dict).

        AppleScript: `whose id is <internal_id>` (~1s, v3 快路径).
        DavMail: SyncStore (imap_uidvalidity, imap_uid) → UID FETCH BODY.PEEK[];
        miss 时 message_id IMAP SEARCH 反查 + 回写 sync_store.

        ``update_uid=False`` (compose_plan dry-run 懒自愈): davmail message_id fallback
        命中后**跳过** imap_uid/uidvalidity 元数据回写 — 守住 dry-run「无 auth/写」契约。
        默认 True 时既有调用方 (正向 sync / retry) 逐字节不变; applescript 无 UID 元数据
        回写, 参数仅满足契约被忽略。

        失败返回 None (不抛异常, 让上层走 retry queue).
        """
        ...

    def fetch_email_by_message_id(
        self, message_id: str, mailbox: Optional[str] = None
    ) -> Optional[dict]:
        """通过 message_id 抓单封邮件完整内容 (legacy dict). 失败返回 None."""
        ...

    def fetch_emails_by_position(
        self, count: int, mailbox: Optional[str] = None
    ) -> list[dict]:
        """按位置抓最近 count 封邮件元数据 (初始化同步 / health-check 用)."""
        ...

    # =========================================================================
    # 反向 sync — flag / read (outbox fanout / handlers / reverse_sync 调)
    # =========================================================================

    def mark_as_read_by_id(
        self, internal_id: int, read: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """按 internal_id 标记已读/未读 (主路径). 协议层幂等.

        AppleScript: `set read status to <bool>`.
        DavMail: `IMAP UID STORE ±FLAGS (\\Seen)`.
        """
        ...

    def set_flag_by_id(
        self, internal_id: int, flagged: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """按 internal_id 设置/取消旗标 (主路径). 协议层幂等."""
        ...

    def mark_as_read(
        self, message_id: str, read: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """按 message_id 标记已读/未读 (internal_id 缺失时的 fallback 路径).

        签名统一决策 (inventory §3 ①): mailbox 位置可传 (对齐 AppleScriptArm 形状,
        调用方 handlers/reverse_sync 都是三位置参数调用).
        """
        ...

    def set_flag(
        self, message_id: str, flagged: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """按 message_id 设置/取消旗标 (fallback 路径). 同 mark_as_read 签名约定."""
        ...

    # =========================================================================
    # 草稿 (handle_create_draft / MailWriteService / drafts 同步调)
    # =========================================================================

    def append_draft(self, draft: DraftRequest) -> DraftAppendResult:
        """创建邮件草稿到 Drafts 文件夹.

        AppleScript: subprocess 调 scripts/create_reply_draft.sh (GUI 注入老路径).
        DavMail: build MIME → IMAP APPEND 到 drafts_folder (probe 探测结果).
        """
        ...

    def reconcile_drafts(self) -> tuple[list[dict], list[int]]:
        """草稿箱全量对账 — 返回 (新草稿 email dicts, 已消失草稿的 internal_ids).

        davmail-only 能力 (DRAFTS_SYNC_ENABLED): 草稿会被编辑/发送/删除, 增量
        marker 只见新增不见消失, 必须全量 UID 对账. AppleScript 实现返回 ([], [])
        (noop, 与历史 hasattr duck-typing 缺失语义等价 — inventory §3 ②).
        """
        ...

    # =========================================================================
    # 真实发送 (email send 命令 / 前端发送按钮调)
    # =========================================================================

    def send_email(self, draft: DraftRequest) -> SendResult:
        """真实发送邮件 (对外不可逆). 调用方负责二次确认 (CLI --yes / 前端弹窗).

        DavMail: smtp_session(cfg) + 拼 MIME + smtp.send_message.
        AppleScript: fallback 也走 SMTP (cfg 端口都指向 DavMail JVM).

        失败返回 SendResult(success=False, error=...), 不抛异常.
        """
        ...
