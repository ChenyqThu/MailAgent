"""OutlookComBackend — 第三个 IMailBackend 实现 (Windows classic Outlook COM).

task 08-12 (win-mailagentwin-backend-eval) BE1+BE2: 邮件获取/写回不经 Mail.app 也不经
davmail IMAP 桥, 直接用本机 classic Outlook 的 COM 对象模型 (pywin32)。COM 管线机制
直搬同事 fork (MailAgentWin, 授权) 并包进本仓协议 + 三态异常契约。

架构要点 (prd §2.2 八条决策的落点):

- **STA 纪律**: COM 对象绑定创建线程 apartment → backend 自持 :class:`StaComExecutor`
  单线程 executor, 所有协议方法一进门转发到专属 STA 线程 (对调用方透明同步)。
  new_watcher 有不经 run_backend_io 的直调点, 收在 backend 内部最稳。
- **marker 语义**: 收件箱 ReceivedTime 水位 (epoch 秒 int, 单调)。
  🔴 三态异常契约: marker 取不到 raise :class:`MarkerUnavailableError` (绝不回 0 ——
  task 07-14 L3: 0 被 baseline 持久化 → 全量重刷); 枚举失败 raise
  :class:`FolderFetchError` (绝不 ``return []`` 吞错 —— 2026-08-11 丢邮件事故;
  MailAgentWin 原码的 return [] 反模式在这里修掉)。
- **internal_id**: 照抄 davmail 模式 —— ``sync_store.allocate_davmail_internal_id()``
  同一序列 (>= 10^9 本地合成 id, 语义与 backend 无关)。
- **EntryID 只当缓存不当锚** (v53 ``email_metadata.entry_id`` 列): EntryID 在邮件
  移动文件夹后会变 (MAPI 语义), 稳定锚是 ``message_id UNIQUE``; entry_id miss/失效时
  按 ``PR_INTERNET_MESSAGE_ID`` (DASL) 反查 + 回写自愈 —— 与 davmail imap_uid 双路
  设计完全同构 (imap_uid 实测 32% 漂移, 该模式已验证)。
- **MIME 重组**: COM 没有可靠的原始 MIME API → :mod:`outlook_mime` 从 ItemSnapshot
  (transport 头 + HTMLBody + 附件 bytes) 本地重组 RFC822, 失败 raise → fetch 返 None
  走 retry queue (与 davmail fetch 失败语义一致)。
- **发信**: ``CreateItem(0) + .Send()`` 走 Outlook 自己的账户, 不需要 SMTP 凭证;
  reply 线程头 (In-Reply-To/References/ConversationIndex) 由 Outlook 自动接对。
  ``.Send()/.Save()`` 可能被模态窗卡住 → ``call_with_timeout`` (COM 封送 + join 放弃
  语义) + 进度窗隐藏 hack (draft_handler 三件套直搬)。
- **fail-soft 白名单** (有意 NOT implemented, v2 再做): ``search_inbox_unseen`` /
  ``fetch_inbox_seen_flags`` (issue#58 入向已读回收) / ``reconcile_inbox`` (对账兜底) /
  ``reconcile_drafts`` (草稿箱同步) —— new_watcher 的 hasattr 门对缺失方法自动不激活
  对应功能 ("没判据就不许猜" 纪律)。🔴 因此本类**有意不继承** IMailBackend Protocol
  基类 —— 继承会把 Protocol 的默认方法体带进来, 打穿 hasattr 门。

🔴 平台纪律: 绝不 top-level import win32com/pythoncom —— 开发机是 macOS。全部 COM
交互经 :mod:`com_client` (懒 import + fake 注入点), 本模块 mac 上可 import 可单测。
"""
from __future__ import annotations

import os
import re
import tempfile
import time
import uuid
from datetime import datetime, timezone
from email.parser import Parser
from typing import Any, Callable, Optional

from loguru import logger

from src.mail.mailbox_semantics import DRAFTS_LABEL, INBOX_LABEL, SENT_LABEL
from src.mail.backend.base import (
    FolderFetchError,
    MarkerUnavailableError,
)
from src.mail.backend.com_client import (
    DASL_MESSAGE_ID,
    OL_FOLDER_DRAFTS,
    OL_FOLDER_INBOX,
    OL_FOLDER_SENT_MAIL,
    OL_MAIL_ITEM,
    OL_MARK_NO_DATE,
    PR_ATTACH_CONTENT_ID,
    PR_INTERNET_MESSAGE_ID,
    PR_SMTP_ADDRESS,
    PR_TRANSPORT_MESSAGE_HEADERS,
    OutlookSession,
    StaComExecutor,
    call_with_timeout,
    epoch_to_dasl_local,
    start_progress_window_hider,
)
# 纯函数复用 (单源, 不复制): davmail_backend 的头解码/地址提取/线程推导与
# backend 无关, outlook_com 的 transport 头走同一套, 保证两 backend 口径一致。
from src.mail.backend.davmail_backend import (
    _normalize_message_id,
    _thread_id_from_headers,
)
from src.mail.backend.outlook_mime import (
    AttachmentSnapshot,
    ItemSnapshot,
    rebuild_rfc822,
)
from src.mail.backend.types import (
    BackendOrigin,
    DraftAppendResult,
    DraftRequest,
    EmailContent,
    SendResult,
)

#: PR_ATTACH_MIME_TAG — 附件的 Content-Type (PropertyAccessor)
_PR_ATTACH_MIME_TAG = "http://schemas.microsoft.com/mapi/proptag/0x370E001F"

#: OlAttachmentType: olByValue=1 普通附件; olOLE=6 OLE 嵌入对象 (跳过)
_OL_ATTACH_BY_VALUE = 1
_OL_ATTACH_OLE = 6

#: OlFlagStatus: olNoFlag=0 / olFlagComplete=1 / olFlagMarked=2
_OL_FLAG_MARKED = 2
_OL_NO_FLAG = 0

#: 附件抽取上限 (单封) — 防超大附件把 STA 线程卡死; 超限附件跳过并 warning。
_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024


def _com_get(obj: Any, attr: str, default: Any = None) -> Any:
    """容错取 COM 属性 — 部分属性在特定 item 状态下访问即抛."""
    try:
        value = getattr(obj, attr)
        return default if value is None else value
    except Exception:  # noqa: BLE001 — COM 属性缺失/受限统一按 default
        return default


def _prop(obj: Any, dasl_or_proptag: str, default: Any = None) -> Any:
    """PropertyAccessor.GetProperty 容错包装."""
    try:
        accessor = obj.PropertyAccessor
        value = accessor.GetProperty(dasl_or_proptag)
        return default if value is None else value
    except Exception:  # noqa: BLE001 — 属性不存在 (MAPI_E_NOT_FOUND) 等
        return default


def _to_epoch(dt: Any) -> Optional[int]:
    """pywintypes/py datetime → epoch 秒 int. 解析不了返 None (由调用方决定语义)."""
    if dt is None:
        return None
    try:
        # pywintypes datetime 兼容 datetime 接口; naive 视为本地时间
        return int(dt.timestamp())
    except Exception:  # noqa: BLE001
        return None


def _to_datetime(dt: Any) -> Optional[datetime]:
    """pywintypes datetime → 标准 datetime (纯数据快照用, 剥 COM 类型)."""
    epoch = _to_epoch(dt)
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, tz=timezone.utc)


def _dasl_quote(value: str) -> str:
    """DASL filter 字符串字面量转义 (单引号 double)."""
    return value.replace("'", "''")


class OutlookComBackend:
    """Windows classic Outlook COM backend (IMailBackend 第三实现).

    结构性 duck-typing: 不继承 Protocol 基类 (见模块 docstring fail-soft 段)。
    注意 ``isinstance(backend, IMailBackend)`` 对本类为 **False** —— runtime_checkable
    检查全部协议方法, 而 ``reconcile_drafts`` 有意缺席 (hasattr 门不激活草稿同步)。
    运行时无任何 isinstance(IMailBackend) 消费点 (grep 证实, 仅 applescript 测试用),
    协议一致性由本类专属契约测试保证。
    """

    backend_origin: BackendOrigin = "outlook_com"

    #: 能力标: folder 级写面 (归档/移动/文件夹 CRUD) 经 FolderComReader 支持。
    #: mail_write._folder_imap_reader 的能力判定闸消费 (isinstance(DavMailBackend)
    #: 之外的第二分支; applescript 无此标 → 维持原 ServiceInvalidArgError)。
    supports_folder_ops = True

    #: get_new_emails 单轮抓取上限 (追赶/首拉防灌爆; 超出部分下轮继续 —— marker
    #: 只推进到已抓最后一封, 不会跳过)
    MAX_BATCH = 200

    def __init__(
        self,
        cfg,
        sync_store,
        *,
        dispatch_factory: Optional[Callable[[str], Any]] = None,
    ):
        """``dispatch_factory``: 测试注入点 (fake Outlook Application); None = 真 COM."""
        self.cfg = cfg
        self.sync_store = sync_store
        self._sta = StaComExecutor()
        self._session = OutlookSession(dispatch_factory)
        self._cached_marker: Optional[int] = None
        # 观测: 最近一次 COM 操作耗时 (镜像 davmail last_op_latency_ms 观测面)
        self.last_op_latency_ms: Optional[int] = None
        # 协议外属性 (mail_write getattr 消费, 镜像 davmail probe 探测结果语义)
        self.sent_folder: Optional[str] = None
        self.drafts_folder: Optional[str] = None
        self._publish_timeout = float(
            getattr(cfg, "outlook_com_publish_timeout_sec", 60) or 60
        )

    # ------------------------------------------------------------------
    # 内部: STA 转发 + 会话包装
    # ------------------------------------------------------------------

    def _com(self, fn: Callable[[OutlookSession], Any], *, op: str) -> Any:
        """所有 COM 调用的唯一入口: STA 线程 + 忙态退避 + 死对象 reconnect."""
        t0 = time.time()
        try:
            return self._sta.run(lambda: self._session.call(fn, op=op))
        finally:
            self.last_op_latency_ms = int((time.time() - t0) * 1000)

    # ------------------------------------------------------------------
    # 文件夹定位
    # ------------------------------------------------------------------

    def _default_folder(self, session: OutlookSession, kind: int) -> Any:
        return session.namespace.GetDefaultFolder(kind)

    def _folder_for_label(self, session: OutlookSession, label: Optional[str]) -> Any:
        """mailbox 标签 (本仓 canonical 中文标签) → Outlook 文件夹. 未知标签回收件箱."""
        if label == SENT_LABEL:
            return self._default_folder(session, OL_FOLDER_SENT_MAIL)
        if label == DRAFTS_LABEL:
            return self._default_folder(session, OL_FOLDER_DRAFTS)
        # INBOX_LABEL / None / 未知自定义 (v1 无多文件夹) → 收件箱
        return self._default_folder(session, OL_FOLDER_INBOX)

    # ------------------------------------------------------------------
    # 协议: 启动 probe / 可用性
    # ------------------------------------------------------------------

    def probe_readiness(self) -> tuple[bool, str]:
        """启动 probe: Dispatch + GetNamespace + 收件箱可达.

        🔴 Dispatch 在 Outlook 未运行时会**拉起 Outlook.exe** (COM out-of-proc 语义)。
        probe 语义定义: 能建会话 + 能拿到收件箱 = ready (Outlook 被拉起也算 ready ——
        与「用户必须先手动开 Outlook」相比这是更可用的形态; 未登录/首次配置向导挡路时
        GetDefaultFolder 会失败 → not ready, factory raise BackendStartupError)。

        New Outlook (olk.exe) 没有 COM 对象模型 → Dispatch 直接失败, 错误信息里
        明示需要 classic Outlook。
        """

        def _probe(session: OutlookSession) -> tuple[str, str]:
            inbox = self._default_folder(session, OL_FOLDER_INBOX)
            _ = _com_get(inbox, "Name", "Inbox")
            sent = self._default_folder(session, OL_FOLDER_SENT_MAIL)
            drafts = self._default_folder(session, OL_FOLDER_DRAFTS)
            return (
                str(_com_get(sent, "Name", "") or ""),
                str(_com_get(drafts, "Name", "") or ""),
            )

        try:
            sent_name, drafts_name = self._com(_probe, op="probe-readiness")
        except Exception as e:  # noqa: BLE001 — probe 契约: 返回 (False, why) 不 raise
            return False, (
                f"Outlook COM 不可达: {e} —— 需要本机安装并配置 **classic Outlook** "
                "(New Outlook/olk.exe 无 COM 接口), 且首次访问需在 Outlook 的 "
                "Programmatic Access 弹窗中选择「允许」"
            )
        # 协议外属性: mail_write 经 getattr 消费 (镜像 davmail probe 语义)。
        # 注意存的是 Outlook 显示名 (本地化), 仅作展示/日志 — 定位恒走 GetDefaultFolder。
        self.sent_folder = sent_name or None
        self.drafts_folder = drafts_name or None
        return True, "Outlook COM ready (classic Outlook)"

    def is_available(self) -> bool:
        """雷达可用性 — 轻量探活 (Namespace 存活即可)."""
        def _ping(session: OutlookSession) -> bool:
            inbox = self._default_folder(session, OL_FOLDER_INBOX)
            return inbox is not None

        try:
            return bool(self._com(_ping, op="is-available"))
        except Exception as e:  # noqa: BLE001 — 可用性探测失败 = False, 不抛
            logger.warning(f"[outlook-com] is_available probe failed: {e}")
            return False

    # ------------------------------------------------------------------
    # 协议: marker (ReceivedTime 水位)
    # ------------------------------------------------------------------

    def get_current_max_row_id(self) -> int:
        """当前 marker = 收件箱最新一封的 ReceivedTime (epoch 秒 int).

        🔴 失败 raise MarkerUnavailableError — 绝不 return 0 (task 07-14 L3: 0 被
        持久化成 baseline → 下轮 get_new_emails(0) 全量重刷)。

        空收件箱是合法状态 → 返回**当前时间** (此前没有任何邮件, 从现在开始增量;
        与 davmail「UIDNEXT 恒 >= 1」同样保证 marker 恒为正数)。
        """

        def _newest(session: OutlookSession) -> Optional[int]:
            inbox = self._default_folder(session, OL_FOLDER_INBOX)
            items = inbox.Items
            items.Sort("[ReceivedTime]", True)  # descending
            first = items.GetFirst()
            if first is None:
                return None  # 空收件箱 (合法)
            epoch = _to_epoch(_com_get(first, "ReceivedTime"))
            if epoch is None:
                raise ValueError("newest inbox item has unreadable ReceivedTime")
            return epoch

        try:
            newest = self._com(_newest, op="marker-query")
        except Exception as e:  # noqa: BLE001 — 统一翻译成协议异常
            raise MarkerUnavailableError(
                f"outlook_com marker query failed: {e}"
            ) from e
        if newest is None:
            return int(time.time())
        return int(newest)

    def check_for_changes(self, last_max_row_id: int) -> tuple[bool, int, int]:
        """自 marker 以来是否有新邮件 — Items.Restrict(DASL datereceived >= 水位) 计数.

        Returns: (has_new, current_marker, estimated_new_count)

        水位比较用 ``>=`` (同秒多封不丢), 由 message_id UNIQUE merge 去重边界重抓。
        计数 > 0 但全是已同步的边界封时, save_email merge 会静默去重 —— 与 davmail
        inclusive 下界语义一致 (2026-08-11 事故修复的口径)。
        """
        try:
            current = self.get_current_max_row_id()
        except MarkerUnavailableError:
            raise
        if last_max_row_id <= 0:
            # 无 baseline: 报无新邮件, 让调用方先持久化 current 作 baseline
            return False, current, 0

        def _count(session: OutlookSession) -> int:
            inbox = self._default_folder(session, OL_FOLDER_INBOX)
            restricted = inbox.Items.Restrict(self._since_filter(last_max_row_id))
            return int(_com_get(restricted, "Count", 0))

        try:
            est = self._com(_count, op="check-for-changes")
        except Exception as e:  # noqa: BLE001
            raise MarkerUnavailableError(
                f"outlook_com change-count query failed: {e}"
            ) from e
        return (current > last_max_row_id or est > 0), current, est

    @staticmethod
    def _since_filter(epoch: int) -> str:
        """epoch 水位 → DASL Restrict filter (>=, 本地时区字面量, locale 解耦)."""
        return (
            "@SQL=\"urn:schemas:httpmail:datereceived\" >= "
            f"'{epoch_to_dasl_local(epoch)}'"
        )

    def set_last_max_row_id(self, row_id: int) -> None:
        """写 marker 内存缓存 (持久化由调用方走 sync_store) — 镜像 davmail."""
        self._cached_marker = int(row_id) if row_id else None

    def get_last_max_row_id(self) -> int:
        return self._cached_marker or 0

    # ------------------------------------------------------------------
    # 协议: get_new_emails (增量取信)
    # ------------------------------------------------------------------

    def get_new_emails(self, since_row_id: int) -> list[dict]:
        """取 marker (epoch 秒) 之后的新邮件元数据 (收件箱 + 已发送).

        🔴 三态契约 (2026-08-11 丢邮件事故, base.py FolderFetchError docstring):

        - 枚举/快照/internal_id 分配失败 → raise FolderFetchError (游标不推进,
          下轮重试; MailAgentWin 原码 return [] 吞错的反模式在此修掉);
        - OK + 窗口内没有新邮件 → 返回 ``[]`` (游标照常推进);
        - Sent 文件夹失败不牵连 INBOX (inner try, 镜像 davmail 多 folder 纪律)。

        每条已带 ``internal_id`` (allocate_davmail_internal_id, >= 10^9) /
        ``backend_origin='outlook_com'`` / ``mailbox`` / ``entry_id``, 上层
        new_watcher 直接透传 save_email。
        """
        if since_row_id <= 0:
            # 无合法水位时拒绝全量扫描 (10 万封邮箱 Restrict 无下界会卡死 STA 线程);
            # 调用方 (watcher baseline 流程) 会先 get_current_max_row_id 建水位。
            logger.warning(
                f"[outlook-com] get_new_emails(since={since_row_id}) without valid "
                "watermark — returning [] (baseline flow establishes marker first)"
            )
            return []

        rows = self._scan_folder_since(INBOX_LABEL, since_row_id)  # 失败冒泡

        # Sent: 独立 inner try —— 失败降级 warning, 不牵连 INBOX 主路径
        try:
            rows.extend(self._scan_folder_since(SENT_LABEL, since_row_id))
        except Exception as e:  # noqa: BLE001 — Sent 失败不阻断收件主链
            logger.warning(f"[outlook-com] sent-folder scan failed (non-fatal): {e}")

        return rows

    def _scan_folder_since(self, mailbox_label: str, since_epoch: int) -> list[dict]:
        """单文件夹按 ReceivedTime 水位增量扫描 → 行 dict 列表 (含 internal_id 分配)."""

        def _scan(session: OutlookSession) -> list[ItemSnapshot]:
            folder = self._folder_for_label(session, mailbox_label)
            items = folder.Items
            items.Sort("[ReceivedTime]", False)  # ascending: 老→新, 截断留最老的下轮
            restricted = items.Restrict(self._since_filter(since_epoch))
            total = int(_com_get(restricted, "Count", 0))
            snaps: list[ItemSnapshot] = []
            item = restricted.GetFirst()
            scanned = 0
            while item is not None and scanned < self.MAX_BATCH:
                scanned += 1
                # 非邮件 item (会议回执/任务) 没有 MailItem 属性面 — Class 43 = olMail
                if int(_com_get(item, "Class", 43)) == 43:
                    snaps.append(
                        self._snapshot_item(
                            item, want_attachments=False, want_headers=True
                        )
                    )
                item = restricted.GetNext()
            if total > scanned:
                logger.info(
                    f"[outlook-com] {mailbox_label}: {total} matched, capped to "
                    f"{scanned} (MAX_BATCH) — remainder next cycle"
                )
            return snaps

        try:
            snaps = self._com(_scan, op=f"scan-{mailbox_label}")
        except Exception as e:  # noqa: BLE001 — 统一翻译成三态契约异常
            raise FolderFetchError(
                f"outlook_com scan {mailbox_label!r} since={since_epoch} failed: {e}"
            ) from e

        out: list[dict] = []
        for snap in snaps:
            row = self._meta_row_from_snapshot(snap, mailbox_label)
            try:
                row["internal_id"] = self.sync_store.allocate_davmail_internal_id()
            except Exception as e:
                # 跳过单封会让这封落在游标推进后的窗口里 → 永久丢失; 整批失败
                raise FolderFetchError(
                    f"allocate_davmail_internal_id failed for "
                    f"entry_id={snap.entry_id!r} folder={mailbox_label!r}: {e}"
                ) from e
            out.append(row)
        return out

    def _meta_row_from_snapshot(self, snap: ItemSnapshot, mailbox_label: str) -> dict:
        """ItemSnapshot → save_email 行 dict (形状对齐 davmail _parse_batch_headers)."""
        refs_raw, irt_raw = self._refs_from_headers(snap.transport_headers)
        thread_id = _thread_id_from_headers(refs_raw, irt_raw)
        received = snap.received_time
        date_iso = (
            received.astimezone().isoformat() if received is not None else ""
        )
        sender_email = snap.sender_email or ""
        return {
            "message_id": _normalize_message_id(snap.message_id),
            # internal_id 由调用方 (_scan_folder_since) 分配, 镜像 davmail 注释纪律
            "subject": snap.subject or "",
            "sender": sender_email or snap.sender_name or "",
            "sender_name": snap.sender_name or "",
            "date_received": date_iso,
            "is_read": snap.is_read,
            "is_flagged": snap.is_flagged,
            "thread_id": thread_id,
            "backend_origin": "outlook_com",
            "mailbox": mailbox_label,
            # v53: EntryID 快路径缓存 (漂移时 fetch 反查回写自愈)
            "entry_id": snap.entry_id,
            "references_raw": (refs_raw or "").strip() or None,
            "in_reply_to_raw": (irt_raw or "").strip().strip("<>") or None,
        }

    @staticmethod
    def _refs_from_headers(
        transport_headers: Optional[str],
    ) -> tuple[Optional[str], Optional[str]]:
        """transport 头块 → (References, In-Reply-To) 原文."""
        if not transport_headers:
            return None, None
        try:
            msg = Parser().parsestr(transport_headers, headersonly=True)
        except Exception:  # noqa: BLE001 — 头块坏 → 无线程信息 (合法降级)
            return None, None
        return msg.get("References"), msg.get("In-Reply-To")

    # ------------------------------------------------------------------
    # COM item → ItemSnapshot (STA 线程上执行)
    # ------------------------------------------------------------------

    def _snapshot_item(
        self, item: Any, *, want_attachments: bool, want_headers: bool
    ) -> ItemSnapshot:
        """MailItem → 纯数据快照 (COM 解耦边界; 一切属性容错取)."""
        sender_email = self._resolve_sender_smtp(item)
        message_id = _normalize_message_id(
            str(_prop(item, PR_INTERNET_MESSAGE_ID, "") or "")
        )
        transport_headers: Optional[str] = None
        if want_headers:
            raw = _prop(item, PR_TRANSPORT_MESSAGE_HEADERS)
            transport_headers = str(raw) if raw else None

        # Flag: FlagStatus (旧语义) 或 IsMarkedAsTask (新语义) 任一命中即 flagged
        flagged = bool(_com_get(item, "IsMarkedAsTask", False)) or (
            int(_com_get(item, "FlagStatus", _OL_NO_FLAG) or 0) == _OL_FLAG_MARKED
        )

        store_id = None
        parent = _com_get(item, "Parent")
        if parent is not None:
            store_id = _com_get(parent, "StoreID")

        snap = ItemSnapshot(
            subject=str(_com_get(item, "Subject", "") or ""),
            sender_name=str(_com_get(item, "SenderName", "") or ""),
            sender_email=sender_email,
            to=str(_com_get(item, "To", "") or ""),
            cc=str(_com_get(item, "CC", "") or ""),
            message_id=message_id,
            received_time=_to_datetime(_com_get(item, "ReceivedTime")),
            transport_headers=transport_headers,
            html_body=(str(_com_get(item, "HTMLBody", "") or "") or None),
            plain_body=(str(_com_get(item, "Body", "") or "") or None),
            conversation_index=(
                str(_com_get(item, "ConversationIndex", "") or "") or None
            ),
            conversation_id=(str(_com_get(item, "ConversationID", "") or "") or None),
            entry_id=(str(_com_get(item, "EntryID", "") or "") or None),
            store_id=(str(store_id) if store_id else None),
            is_read=not bool(_com_get(item, "UnRead", False)),
            is_flagged=flagged,
        )
        if want_attachments:
            snap.attachments = self._extract_attachments(item)
        return snap

    def _resolve_sender_smtp(self, item: Any) -> str:
        """发件人 SMTP 地址: EX (Exchange DN) → GetExchangeUser 解析; 兜底 PR_SMTP_ADDRESS."""
        addr = str(_com_get(item, "SenderEmailAddress", "") or "")
        addr_type = str(_com_get(item, "SenderEmailType", "") or "").upper()
        if addr and addr_type != "EX":
            return addr
        sender = _com_get(item, "Sender")
        if sender is not None:
            try:
                exch = sender.GetExchangeUser()
                if exch is not None:
                    smtp = _com_get(exch, "PrimarySmtpAddress", "")
                    if smtp:
                        return str(smtp)
            except Exception:  # noqa: BLE001 — 非 Exchange 账户
                pass
            smtp = _prop(sender, PR_SMTP_ADDRESS, "")
            if smtp:
                return str(smtp)
        return addr  # EX DN 原文兜底 (总比空好, davmail 路径同理保留原文)

    def _extract_attachments(self, item: Any) -> list[AttachmentSnapshot]:
        """附件 → bytes 快照 (SaveAsFile → read → unlink; OLE 嵌入对象跳过)."""
        out: list[AttachmentSnapshot] = []
        attachments = _com_get(item, "Attachments")
        if attachments is None:
            return out
        count = int(_com_get(attachments, "Count", 0) or 0)
        if count <= 0:
            return out
        tmpdir = tempfile.mkdtemp(prefix="outlook-com-att-")
        try:
            for i in range(1, count + 1):
                try:
                    att = attachments.Item(i)
                    att_type = int(_com_get(att, "Type", _OL_ATTACH_BY_VALUE) or 0)
                    if att_type == _OL_ATTACH_OLE:
                        continue  # OLE 嵌入对象无文件语义
                    filename = str(_com_get(att, "FileName", "") or "") or f"attachment-{i}"
                    size = int(_com_get(att, "Size", 0) or 0)
                    if size > _MAX_ATTACHMENT_BYTES:
                        logger.warning(
                            f"[outlook-com] attachment {filename!r} {size}B exceeds "
                            f"{_MAX_ATTACHMENT_BYTES}B cap — skipped"
                        )
                        continue
                    # 文件名去路径分隔符 (COM FileName 理论上无路径, 防御性清洗)
                    safe_name = re.sub(r"[\\/]", "_", filename)
                    path = os.path.join(tmpdir, f"{i}-{safe_name}")
                    att.SaveAsFile(path)
                    with open(path, "rb") as f:
                        data = f.read()
                    os.unlink(path)
                    content_id = _prop(att, PR_ATTACH_CONTENT_ID)
                    mime_tag = _prop(att, _PR_ATTACH_MIME_TAG)
                    out.append(
                        AttachmentSnapshot(
                            filename=filename,
                            data=data,
                            content_id=(str(content_id) if content_id else None),
                            mime_type=(str(mime_tag) if mime_tag else None),
                        )
                    )
                except Exception as e:  # noqa: BLE001 — 单附件失败不炸整封
                    logger.warning(f"[outlook-com] attachment #{i} extract failed: {e}")
        finally:
            try:
                os.rmdir(tmpdir)
            except OSError:
                pass  # 残留文件 (unlink 失败) 时留给系统 tmp 清理
        return out

    # ------------------------------------------------------------------
    # item 定位: entry_id 快路径 + message_id 反查 (自愈)
    # ------------------------------------------------------------------

    def _get_item_by_entry_id(self, session: OutlookSession, entry_id: str) -> Any:
        try:
            return session.namespace.GetItemFromID(entry_id)
        except Exception:  # noqa: BLE001 — EntryID 漂移/失效 → 走 message_id 反查
            return None

    def _find_by_message_id(
        self,
        session: OutlookSession,
        message_id: str,
        mailbox_label: Optional[str],
    ) -> Any:
        """按 PR_INTERNET_MESSAGE_ID (DASL) 在候选文件夹里 Items.Find.

        候选顺序: 记录所属文件夹 → 收件箱 → 已发送 → 草稿箱 (去重)。
        """
        mid = (message_id or "").strip().strip("<>")
        if not mid:
            return None
        candidates: list[Any] = []
        seen_ids: set[str] = set()
        for label in (mailbox_label, INBOX_LABEL, SENT_LABEL, DRAFTS_LABEL):
            if label is None:
                continue
            try:
                folder = self._folder_for_label(session, label)
            except Exception:  # noqa: BLE001 — 单文件夹不可达跳过
                continue
            fid = str(_com_get(folder, "EntryID", "") or label)
            if fid in seen_ids:
                continue
            seen_ids.add(fid)
            candidates.append(folder)
        for folder in candidates:
            for literal in (f"<{mid}>", mid):
                flt = f"@SQL=\"{DASL_MESSAGE_ID}\" = '{_dasl_quote(literal)}'"
                try:
                    item = folder.Items.Find(flt)
                except Exception:  # noqa: BLE001 — filter 语法被具体 store 拒绝
                    continue
                if item is not None:
                    return item
        return None

    def _resolve_item_for_record(
        self, session: OutlookSession, record: dict, mailbox: Optional[str]
    ) -> tuple[Any, bool]:
        """sync_store 行 → COM item. 返回 (item, healed) — healed=经反查命中 (需回写)."""
        entry_id = record.get("entry_id")
        if entry_id:
            item = self._get_item_by_entry_id(session, str(entry_id))
            if item is not None:
                return item, False
        item = self._find_by_message_id(
            session,
            record.get("message_id") or "",
            mailbox or record.get("mailbox"),
        )
        return item, item is not None

    def _update_entry_id(self, internal_id: int, entry_id: str) -> None:
        """message_id 反查命中后回写 entry_id 走快路径 (镜像 davmail _update_sync_store_uid)."""
        import sqlite3 as _sql

        db_path = self.cfg.sync_store_db_path
        try:
            with _sql.connect(db_path, timeout=5.0) as conn:
                conn.execute("PRAGMA busy_timeout = 5000")
                conn.execute(
                    "UPDATE email_metadata SET entry_id = ? WHERE internal_id = ?",
                    (entry_id, int(internal_id)),
                )
                conn.commit()
        except Exception as e:  # noqa: BLE001 — 回写失败非致命 (下次继续反查)
            logger.warning(f"[outlook-com] entry_id heal write failed (non-fatal): {e}")

    # ------------------------------------------------------------------
    # 协议: fetch 全文 ×3
    # ------------------------------------------------------------------

    def fetch_email_content_by_id(
        self,
        internal_id: int,
        mailbox: Optional[str] = None,
        *,
        update_uid: bool = True,
    ) -> Optional[dict]:
        """按 internal_id 抓全文 — entry_id 快路径 + message_id 反查自愈.

        失败返 None (调用方标 fetch_failed 进 retry queue) — 与 davmail 语义一致。
        ``update_uid=False`` (dry-run 语义) 跳过 entry_id 回写。
        """
        record = self.sync_store.get(internal_id)
        if not record:
            logger.warning(f"[outlook-com] internal_id={internal_id} not in sync_store")
            return None

        def _fetch(session: OutlookSession) -> Optional[tuple[ItemSnapshot, bool]]:
            item, healed = self._resolve_item_for_record(session, record, mailbox)
            if item is None:
                return None
            return (
                self._snapshot_item(item, want_attachments=True, want_headers=True),
                healed,
            )

        try:
            result = self._com(_fetch, op="fetch-content")
        except Exception as e:  # noqa: BLE001 — fetch 失败走 retry queue
            logger.warning(
                f"[outlook-com] fetch_email_content_by_id({internal_id}) failed: {e}"
            )
            return None
        if result is None:
            logger.warning(
                f"[outlook-com] internal_id={internal_id} item not found "
                f"(entry_id miss + message_id search miss)"
            )
            return None
        snap, healed = result

        if update_uid and healed and snap.entry_id:
            self._update_entry_id(internal_id, snap.entry_id)

        return self._snapshot_to_legacy_dict(snap, internal_id, record.get("mailbox"))

    def fetch_email_by_message_id(
        self, message_id: str, mailbox: Optional[str] = None
    ) -> Optional[dict]:
        """message_id 反查抓全文 (fallback 路径, legacy dict)."""
        if not message_id:
            return None

        def _fetch(session: OutlookSession) -> Optional[ItemSnapshot]:
            item = self._find_by_message_id(session, message_id, mailbox)
            if item is None:
                return None
            return self._snapshot_item(item, want_attachments=True, want_headers=True)

        try:
            snap = self._com(_fetch, op="fetch-by-message-id")
        except Exception as e:  # noqa: BLE001
            logger.warning(
                f"[outlook-com] fetch_email_by_message_id({message_id!r}) failed: {e}"
            )
            return None
        if snap is None:
            return None
        record = self.sync_store.get_by_message_id(
            (message_id or "").strip().strip("<>")
        )
        internal_id = int(record["internal_id"]) if record else 0
        return self._snapshot_to_legacy_dict(
            snap, internal_id, record.get("mailbox") if record else mailbox
        )

    def _snapshot_to_legacy_dict(
        self, snap: ItemSnapshot, internal_id: int, mailbox: Optional[str]
    ) -> Optional[dict]:
        """快照 → MIME 重组 → EmailContent legacy dict. 重组失败返 None (retry queue)."""
        try:
            source = rebuild_rfc822(snap)
        except Exception as e:  # noqa: BLE001 — 重组失败 = fetch 失败
            logger.warning(
                f"[outlook-com] MIME rebuild failed internal_id={internal_id}: {e}"
            )
            return None
        refs_raw, irt_raw = self._refs_from_headers(snap.transport_headers)
        received = snap.received_time
        content = EmailContent(
            message_id=_normalize_message_id(snap.message_id)
            or self._msgid_from_source(source),
            internal_id=internal_id,
            subject=snap.subject or "",
            sender=snap.sender_email or snap.sender_name or "",
            date_received=(
                received.astimezone().isoformat() if received is not None else ""
            ),
            content=(snap.plain_body or snap.html_body or ""),
            source=source,
            is_read=snap.is_read,
            is_flagged=snap.is_flagged,
            thread_id=_thread_id_from_headers(refs_raw, irt_raw),
            mailbox=mailbox,
            in_reply_to=((irt_raw or "").strip().strip("<>") or None),
        )
        return content.to_legacy_dict()

    @staticmethod
    def _msgid_from_source(source: str) -> str:
        """重组 MIME 里的 Message-ID (rebuild_rfc822 缺失时会合成) — 保证非空."""
        try:
            msg = Parser().parsestr(source, headersonly=True)
            return _normalize_message_id(msg.get("Message-ID"))
        except Exception:  # noqa: BLE001
            return ""

    def fetch_emails_by_position(
        self, count: int, mailbox: Optional[str] = None
    ) -> list[dict]:
        """按位置抓最近 N 封元数据 (初始化/健康检查) — ReceivedTime 降序前 N."""
        label = mailbox or INBOX_LABEL

        def _recent(session: OutlookSession) -> list[ItemSnapshot]:
            folder = self._folder_for_label(session, label)
            items = folder.Items
            items.Sort("[ReceivedTime]", True)  # descending
            snaps: list[ItemSnapshot] = []
            item = items.GetFirst()
            while item is not None and len(snaps) < count:
                if int(_com_get(item, "Class", 43)) == 43:
                    snaps.append(
                        self._snapshot_item(
                            item, want_attachments=False, want_headers=True
                        )
                    )
                item = items.GetNext()
            return snaps

        try:
            snaps = self._com(_recent, op="fetch-recent")
        except Exception as e:  # noqa: BLE001 — 健康检查路径, 失败返空不抛
            logger.warning(f"[outlook-com] fetch_emails_by_position failed: {e}")
            return []
        out: list[dict] = []
        for snap in snaps:
            row = self._meta_row_from_snapshot(snap, label)
            record = self.sync_store.get_by_message_id(row["message_id"] or "")
            out.append(
                {
                    "message_id": row["message_id"],
                    "id": int(record["internal_id"]) if record else 0,
                    "subject": row["subject"],
                    "sender": row["sender"],
                    "date_received": row["date_received"],
                    "is_read": row["is_read"],
                    "is_flagged": row["is_flagged"],
                    "thread_id": row["thread_id"],
                }
            )
        return out

    # ------------------------------------------------------------------
    # 协议: 写面 — 已读 / 旗标
    # ------------------------------------------------------------------

    def mark_as_read_by_id(
        self, internal_id: int, read: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """已读写回 (幂等): item.UnRead = not read + Save()."""
        return self._write_item_state(
            internal_id=internal_id,
            mailbox=mailbox,
            op="mark-read",
            mutate=lambda item: self._apply_read(item, read),
        )

    def set_flag_by_id(
        self, internal_id: int, flagged: bool, mailbox: Optional[str] = None
    ) -> bool:
        """旗标写回 (幂等): MarkAsTask / ClearTaskFlag (FlagStatus 兜底)."""
        return self._write_item_state(
            internal_id=internal_id,
            mailbox=mailbox,
            op="set-flag",
            mutate=lambda item: self._apply_flag(item, flagged),
        )

    def mark_as_read(
        self, message_id: str, read: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """fallback 路径 (internal_id 缺失): message_id 定位 + 已读写回."""
        return self._write_by_message_id(
            message_id, mailbox, op="mark-read-mid",
            mutate=lambda item: self._apply_read(item, read),
        )

    def set_flag(
        self, message_id: str, flagged: bool, mailbox: Optional[str] = None
    ) -> bool:
        """fallback 路径: message_id 定位 + 旗标写回."""
        return self._write_by_message_id(
            message_id, mailbox, op="set-flag-mid",
            mutate=lambda item: self._apply_flag(item, flagged),
        )

    @staticmethod
    def _apply_read(item: Any, read: bool) -> None:
        item.UnRead = not read
        item.Save()

    @staticmethod
    def _apply_flag(item: Any, flagged: bool) -> None:
        try:
            if flagged:
                item.MarkAsTask(OL_MARK_NO_DATE)
            else:
                item.ClearTaskFlag()
        except Exception:  # noqa: BLE001 — 老版对象模型无 MarkAsTask → FlagStatus
            item.FlagStatus = _OL_FLAG_MARKED if flagged else _OL_NO_FLAG
        item.Save()

    def _write_item_state(
        self,
        *,
        internal_id: int,
        mailbox: Optional[str],
        op: str,
        mutate: Callable[[Any], None],
    ) -> bool:
        record = self.sync_store.get(internal_id)
        if not record:
            logger.warning(f"[outlook-com] {op}: internal_id={internal_id} not in store")
            return False

        def _do(session: OutlookSession) -> tuple[bool, Optional[str]]:
            item, healed = self._resolve_item_for_record(session, record, mailbox)
            if item is None:
                return False, None
            mutate(item)
            new_entry = str(_com_get(item, "EntryID", "") or "") or None
            return True, (new_entry if healed else None)

        try:
            ok, healed_entry = self._com(_do, op=op)
        except Exception as e:  # noqa: BLE001 — 写失败 = False, fanout 按 outbox 重试
            logger.warning(f"[outlook-com] {op}(internal_id={internal_id}) failed: {e}")
            return False
        if not ok:
            logger.warning(
                f"[outlook-com] {op}: internal_id={internal_id} item not found"
            )
            return False
        if healed_entry:
            self._update_entry_id(internal_id, healed_entry)
        return True

    def _write_by_message_id(
        self,
        message_id: str,
        mailbox: Optional[str],
        *,
        op: str,
        mutate: Callable[[Any], None],
    ) -> bool:
        if not message_id:
            return False

        def _do(session: OutlookSession) -> bool:
            item = self._find_by_message_id(session, message_id, mailbox)
            if item is None:
                return False
            mutate(item)
            return True

        try:
            ok = self._com(_do, op=op)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[outlook-com] {op}({message_id!r}) failed: {e}")
            return False
        if not ok:
            logger.warning(f"[outlook-com] {op}: message_id={message_id!r} not found")
        return ok

    # ------------------------------------------------------------------
    # 协议: 写面 — 草稿 / 发信
    # ------------------------------------------------------------------

    def append_draft(self, draft: DraftRequest) -> DraftAppendResult:
        """建草稿: 命令式操作 MailItem + .Save() (存 Outlook Drafts).

        reply/reply-all/forward 走原 item 的 Reply()/ReplyAll()/Forward() —— 线程头
        (In-Reply-To/References/ConversationIndex) 由 Outlook 自动接对, 不需要
        draft_builder 拼 MIME。``.Save()`` 经 call_with_timeout (模态窗卡死防护)。

        返回值: ``appended_uid``/``appended_uidvalidity`` 恒 None (IMAP 概念);
        entry_id 语义经 ``entry_id`` 字段带回 (compose_draft 落库消费)。
        """
        drafts_folder = self.drafts_folder or "Drafts"

        def _do(session: OutlookSession) -> tuple[bool, Optional[str], Optional[str]]:
            item, cleanup = self._build_outgoing_item(session, draft)
            try:
                ok = call_with_timeout(
                    item, lambda t: t.Save(),
                    timeout_sec=self._publish_timeout, op="draft-save",
                )
                if not ok:
                    return False, None, None
                entry_id = str(_com_get(item, "EntryID", "") or "") or None
                mid = _normalize_message_id(
                    str(_prop(item, PR_INTERNET_MESSAGE_ID, "") or "")
                ) or None
                return True, entry_id, mid
            finally:
                cleanup()

        try:
            ok, entry_id, mid = self._com(_do, op="append-draft")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[outlook-com] append_draft failed: {e}")
            return DraftAppendResult(
                success=False, drafts_folder=drafts_folder,
                method="outlook_com", error=str(e),
            )
        if not ok:
            return DraftAppendResult(
                success=False, drafts_folder=drafts_folder, method="outlook_com",
                error="Outlook COM Save 超时或失败 (模态窗/Outlook 无响应?)",
            )
        result = DraftAppendResult(
            success=True, drafts_folder=drafts_folder,
            method="outlook_com", message_id=mid,
        )
        # entry_id 经动态属性带回 (DraftAppendResult 是跨 backend dataclass, 不为
        # COM 加字段; compose_draft 的 outlook_com 分支 getattr 消费)
        result.entry_id = entry_id  # type: ignore[attr-defined]
        return result

    def send_email(self, draft: DraftRequest) -> SendResult:
        """真实发送: MailItem.Send() — 走 Outlook 账户, 无需 SMTP 凭证.

        发送后 Outlook 自动归档到已发送 (archived_to_sent=False: 指本仓的手动
        APPEND 兜底, COM 路径不需要)。message_id: Send 后 item 已入队/失效,
        Outlook 分配的 Message-ID 拿不到 → None (发件箱增量扫描会正常拉回该封)。
        """

        def _do(session: OutlookSession) -> bool:
            item, cleanup = self._build_outgoing_item(session, draft)
            try:
                start_progress_window_hider()
                return call_with_timeout(
                    item, lambda t: t.Send(),
                    timeout_sec=self._publish_timeout, op="send-email",
                )
            finally:
                cleanup()

        try:
            ok = self._com(_do, op="send-email")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[outlook-com] send_email failed: {e}")
            return SendResult(success=False, method="outlook_com", error=str(e))
        if not ok:
            return SendResult(
                success=False, method="outlook_com",
                error="Outlook COM Send 超时或失败 (模态窗/Outlook 无响应?)",
            )
        return SendResult(success=True, method="outlook_com")

    def _build_outgoing_item(
        self, session: OutlookSession, draft: DraftRequest
    ) -> tuple[Any, Callable[[], None]]:
        """DraftRequest → MailItem (reply*/forward 从原 item 派生; new 走 CreateItem).

        返回 (item, cleanup) — cleanup 释放附件临时文件 (Attachments.Add 要真实路径,
        Add 即拷贝, Save/Send 后可删)。失败 raise (上层翻译成 DraftAppendResult/
        SendResult error)。
        """
        item: Any = None
        if draft.mode in ("reply", "reply-all", "forward"):
            if draft.internal_id_for_threading is None:
                raise ValueError(f"{draft.mode} 模式必须提供 internal_id_for_threading")
            record = self.sync_store.get(draft.internal_id_for_threading)
            if not record:
                raise ValueError(
                    f"原邮件 internal_id={draft.internal_id_for_threading} 不在 sync_store"
                )
            orig, _ = self._resolve_item_for_record(session, record, None)
            if orig is None:
                raise ValueError(
                    f"原邮件定位失败 (entry_id 漂移且 message_id 反查 miss): "
                    f"internal_id={draft.internal_id_for_threading}"
                )
            if draft.mode == "reply":
                item = orig.Reply()
            elif draft.mode == "reply-all":
                item = orig.ReplyAll()
            else:
                item = orig.Forward()
            # 收件人覆写: 显式给了就整体替换 (Reply/ReplyAll 已自动算好默认收件人)
            if draft.to:
                item.To = "; ".join(draft.to)
            if draft.cc:
                item.CC = "; ".join(draft.cc)
            if draft.bcc:
                item.BCC = "; ".join(draft.bcc)
            if draft.subject:
                item.Subject = draft.subject
            # 用户正文 prepend 在 Outlook 自动引用块之前
            user_html = draft.reply_html or (
                draft.forward_intro_html if draft.mode == "forward" else None
            )
            user_text = draft.reply_text or (
                draft.forward_intro_text if draft.mode == "forward" else ""
            )
            if user_html:
                try:
                    existing = str(_com_get(item, "HTMLBody", "") or "")
                    item.HTMLBody = user_html + existing
                except Exception:  # noqa: BLE001 — HTMLBody 拼接失败降级纯文本
                    item.Body = (user_text or "") + "\n\n" + str(
                        _com_get(item, "Body", "") or ""
                    )
            elif user_text:
                item.Body = user_text + "\n\n" + str(_com_get(item, "Body", "") or "")
        else:  # new
            item = session.application.CreateItem(OL_MAIL_ITEM)
            item.To = "; ".join(draft.to)
            if draft.cc:
                item.CC = "; ".join(draft.cc)
            if draft.bcc:
                item.BCC = "; ".join(draft.bcc)
            item.Subject = draft.subject or ""
            if draft.reply_html:
                item.HTMLBody = draft.reply_html
            else:
                item.Body = draft.reply_text or ""

        imp = (draft.importance or "").lower()
        if imp == "high":
            item.Importance = 2
        elif imp == "low":
            item.Importance = 0

        # 附件: 落临时文件 → Attachments.Add(path) (Add 即拷贝进 item)
        tmp_paths: list[str] = []
        tmpdir: Optional[str] = None
        if draft.attachments:
            tmpdir = tempfile.mkdtemp(prefix="outlook-com-send-")
            for filename, data, _mime in draft.attachments:
                safe_name = re.sub(r"[\\/]", "_", filename or "") or (
                    f"attachment-{uuid.uuid4().hex[:8]}"
                )
                path = os.path.join(tmpdir, safe_name)
                with open(path, "wb") as f:
                    f.write(data)
                item.Attachments.Add(path)
                tmp_paths.append(path)

        def _cleanup() -> None:
            for p in tmp_paths:
                try:
                    os.unlink(p)
                except OSError:
                    pass
            if tmpdir:
                try:
                    os.rmdir(tmpdir)
                except OSError:
                    pass

        return item, _cleanup

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def shutdown(self) -> None:
        """释放 STA executor (进程退出时调用; 幂等)."""
        self._sta.shutdown()
