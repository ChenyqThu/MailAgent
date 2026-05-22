"""DavMailBackend — IMailBackend 实现, PRIMARY 模式 (MAILAGENT_BACKEND=davmail).

走 DavMail JVM 本机 IMAP (1143) + SMTP (1025), DavMail 内部桥接 EWS / Graph 跟
Outlook 服务端通信. PoC 实测 vs AppleScript:
- UID FETCH BODY[] 236ms (vs 1s, 4× 快)
- STORE +FLAGS 同步生效
- APPEND Drafts 富文本完美
- IDLE 不推送 (fallback 30s STATUS polling)

详见 plan §"切换边界 — 命令级抽象" + davmail-poc/POC-RESULTS.md.

`backend_origin = "davmail"`: 新邮件抓进来时 SyncStore 写 backend_origin='davmail',
internal_id = AUTOINCREMENT 起点 1_000_000_000 (永不跟 Mail.app ROWID 冲突).
"""
from __future__ import annotations

import re
import time
from datetime import timezone
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formatdate, getaddresses, make_msgid, parsedate_to_datetime
from typing import TYPE_CHECKING, Any, Optional, Union

from loguru import logger

from src.mail.backend.base import IMailBackend
from src.mail.backend.imap_client import (
    DavMailConnectionError,
    discover_drafts_folder,
    imap_connect,
    imap_session,
    probe_tcp,
)
from src.mail.backend.types import (
    BackendHealth,
    BackendOrigin,
    DraftAppendResult,
    DraftRequest,
    EmailContent,
    EmailMeta,
    RadarTick,
)

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.sync_store import SyncStore

# RFC 4315 APPENDUID response: [APPENDUID uidvalidity uid]
_APPENDUID_PATTERN = re.compile(rb"APPENDUID\s+\d+\s+(\d+)", re.IGNORECASE)
# RFC 2369 Message-ID 完整匹配 (用 regex 而非 ``in`` 避免 partial match 误判)
_MSGID_PATTERN = re.compile(r"<[^<>\s]+>")


def _decode_mime_header(value: Optional[str]) -> str:
    """RFC 2047 decode 邮件 header (subject / from / to 等).

    DavMail IMAP 返回的 raw MIME 里 header 是 `=?gb2312?B?...?=` 这种 encoded-word 形式,
    必须 decode 才能跟 AppleScript 的 native 字符串对齐. 失败 fallback 原值 + log WARNING
    (避免 frontend 显示 raw encoded-word).
    """
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception as e:
        logger.warning(f"[davmail-backend] RFC 2047 decode failed for header={value[:60]!r}: {e}")
        return value


def _normalize_date_iso(date_str: str) -> str:
    """RFC 822 Date 头 → ISO 8601. 失败 fallback 原值.

    AppleScript 路径 ``raw['date']`` 来自 ``EmailDate.isoformat()``, davmail 路径直接拿
    MIME ``Date`` 头 (RFC 822). 把 davmail 路径归一成 ISO, 跟 EmailContent.date_received
    docstring 约定 + 前端 EmailList 排序口径一致.
    """
    if not date_str:
        return ""
    try:
        dt = parsedate_to_datetime(date_str)
        if dt is None:
            return date_str
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    except Exception:
        return date_str


def _quote_imap_string(value: str) -> str:
    """IMAP 字符串字面量 quote (RFC 3501 §4.3 quoted string).

    ``imaplib.IMAP4.uid("search", "HEADER", "Message-ID", value)`` 不会自动 quote
    含 ``<>+=`` 之类特殊字符的 Message-ID; 必须显式 quote 否则 server 当 atom 解析失败.
    """
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _extract_first_email(addr_field: str) -> str:
    """从 RFC 822 address 字段抽出第一个 email 地址 (纯 user@host 形式).

    支持: ``"Doe, John" <john@x>`` / ``Foo Bar <foo@bar>`` / ``plain@addr.com``.
    用 ``email.utils.getaddresses`` 而非自己 split, 否则 quoted display name 含逗号
    会把 RFC 5322 一条 address 当多个 split (review HIGH #_split_addrs).
    """
    if not addr_field:
        return ""
    try:
        pairs = getaddresses([addr_field])
        for _, email in pairs:
            if email:
                return email.strip()
    except Exception:
        pass
    return addr_field.strip()


def _extract_display_name(addr_field: str) -> str:
    """从 RFC 822 address 字段抽 display name (如果有), 否则空字符串."""
    if not addr_field:
        return ""
    try:
        pairs = getaddresses([addr_field])
        for name, _ in pairs:
            if name:
                return name.strip()
    except Exception:
        pass
    return ""


def _read_uidvalidity_from_select(imap) -> Optional[int]:
    """从 ``imap.select(...)`` 后的 untagged response cache 读 UIDVALIDITY.

    RFC 3501 §6.3.1 + §7.1: SELECT/EXAMINE 总会返回 ``* OK [UIDVALIDITY n]`` untagged
    response, ``imaplib`` 会把它存到 ``untagged_responses['UIDVALIDITY']`` 或 OK 响应里.
    用这个代替 STATUS 调用 (RFC 3501 §6.3.10 禁止 STATUS 跟在 SELECT 同 mailbox 后).
    """
    try:
        ur = getattr(imap, "untagged_responses", {}) or {}
        val = ur.get("UIDVALIDITY")
        if val:
            # imaplib 存的是 list, 元素可能是 bytes 或 str
            first = val[0] if isinstance(val, list) else val
            if isinstance(first, (bytes, bytearray)):
                first = first.decode("utf-8", errors="replace")
            return int(str(first).strip())
    except (TypeError, ValueError, IndexError):
        pass
    return None


def _select_is_writable(imap) -> bool:
    """SELECT(readonly=False) 后判断 mailbox 是否真的可写.

    IMAP server (含 DavMail bridge 共享邮箱场景) 可能把 ``SELECT`` 静默降级到 read-only,
    在 untagged response 中带 ``[READ-ONLY]`` response code. 用这个 explicit 检查
    避免后续 STORE 静默无效 (review CRITICAL #3).

    返回 ``False`` 时调用方应该 abort, 不要尝试 STORE.
    """
    try:
        ur = getattr(imap, "untagged_responses", {}) or {}
        # imaplib 在 readonly 时设置 PERMANENTFLAGS=[] / READ-ONLY response code;
        # READ_ONLY (有的版本是 READ-ONLY) 出现在 OK code 里. 安全检查多个键.
        for key in ("READ-ONLY", "READ_ONLY", "ReadOnly"):
            if ur.get(key):
                return False
        # 退化检查: PERMANENTFLAGS 为空 list 通常表示 read-only
        pf = ur.get("PERMANENTFLAGS")
        if pf is not None:
            first = pf[0] if isinstance(pf, list) and pf else pf
            if isinstance(first, (bytes, bytearray)):
                first = first.decode("utf-8", errors="replace")
            if isinstance(first, str) and first.strip() in ("()", "[]"):
                return False
    except Exception:
        pass
    return True


# 中文 mailbox → IMAP 标准名映射 (Outlook 国际化常见命名)
_MAILBOX_TO_IMAP = {
    "收件箱": "INBOX",
    "INBOX": "INBOX",
    "发件箱": "Sent Items",
    "已发送": "Sent Items",
    "草稿": "Drafts",
    "Drafts": "Drafts",
}

# 反向: IMAP path → 中文 label (用于 davmail 抓新邮件后写 sync_store 时填 mailbox 字段,
# 跟 AppleScript 路径的 "收件箱" / "发件箱" 口径对齐, 避免前端/CLI 显示混乱).
_IMAP_TO_MAILBOX_LABEL = {
    "INBOX": "收件箱",
    "Sent Items": "发件箱",
    "Drafts": "草稿",
}


def _mailbox_to_imap(name: Optional[str]) -> str:
    """中文 mailbox → IMAP path. case-insensitive lookup, 未知名字原样返回."""
    if not name:
        return "INBOX"
    if name in _MAILBOX_TO_IMAP:
        return _MAILBOX_TO_IMAP[name]
    # case-insensitive fallback (e.g. "inbox" vs "INBOX")
    upper = name.upper()
    for k, v in _MAILBOX_TO_IMAP.items():
        if k.upper() == upper:
            return v
    return name


def _imap_to_mailbox_label(imap_path: str) -> str:
    """IMAP path → 中文 mailbox label (反向映射). 未知保留 IMAP 名字."""
    return _IMAP_TO_MAILBOX_LABEL.get(imap_path, imap_path or "收件箱")


class DavMailBackend(IMailBackend):
    """DavMail IMAP/SMTP 后端 (主路径)."""

    backend_origin: BackendOrigin = "davmail"

    def __init__(self, cfg: "Config", *, sync_store: "SyncStore"):
        self.cfg = cfg
        self.sync_store = sync_store
        self.host = getattr(cfg, "davmail_imap_host", "") or "127.0.0.1"
        self.imap_port = int(getattr(cfg, "davmail_imap_port", 0) or 1143)
        self.smtp_port = int(getattr(cfg, "davmail_smtp_port", 0) or 1025)

        # probe 时探测填充
        self.drafts_folder: Optional[str] = (
            getattr(cfg, "davmail_drafts_folder", "") or None
        )
        self.inbox_uidvalidity: Optional[int] = None
        self.last_op_latency_ms: Optional[int] = None

        # Phase B: 让 NewWatcher / fanout / handler 的 self.arm / self.radar 调用直接 work.
        # davmail backend 自己实现 AppleScriptArm + SQLiteRadar 的兼容接口 (alias methods 在
        # class 底部 #=== Arm/Radar 兼容层 ===). 这避免改 NewWatcher 19 处 / handler / fanout
        # 内部代码, 切换 backend 完全透明.
        self.arm = self
        self.radar = self
        # NewWatcher health-check / dashboard 用 radar.db_path (None 表示无本地 db)
        self.db_path = None
        # davmail radar 内存缓存 marker (sync_store 持久化由 NewWatcher 通过
        # sync_store.set_last_max_row_id 完成, 跟 AppleScript 模式一致路径)
        self._cached_marker: Optional[int] = None

    # =========================================================================
    # 启动 / 健康检查
    # =========================================================================

    def probe_readiness(self) -> tuple[bool, str]:
        """启动 probe: TCP 1143/1025 + IMAP LOGIN + NOOP.

        Sprint 16 收尾修复: 原本 SELECT INBOX 触发 davmail → EWS searchMessages
        (~8.5s) 会让 mail-sync crash-loop 时 1min 内累积 60+ EWS 调用打爆
        Microsoft 端 throttling. 改成 NOOP (~150ms, 纯协议级) + 仅在 drafts_folder
        未知时探测一次. 已知 drafts_folder 时彻底跳过 EWS 调用.
        """
        for port in (self.imap_port, self.smtp_port):
            ok, detail = probe_tcp(self.host, port, timeout=2.0)
            if not ok:
                return False, f"TCP probe failed: {detail}"

        try:
            imap = imap_connect(self.cfg, timeout=10)
        except DavMailConnectionError as e:
            return False, f"IMAP LOGIN failed: {e}"

        try:
            # 轻量 NOOP 替代 SELECT INBOX (后者触发 EWS searchMessages)
            typ, _ = imap.noop()
            if typ != "OK":
                return False, "IMAP NOOP failed"

            # 探测 Drafts (仅当未配置时, 一次性)
            if not self.drafts_folder:
                self.drafts_folder = discover_drafts_folder(imap) or "Drafts"
        finally:
            try:
                imap.logout()
            except Exception:
                pass

        return True, (
            f"DavMail OK (drafts={self.drafts_folder!r}, probe=NOOP)"
        )

    def health_status(self) -> BackendHealth:
        # 轻量探测: 仅 TCP, 不做 LOGIN (避免高频 LOGIN)
        imap_ok, imap_detail = probe_tcp(self.host, self.imap_port, timeout=2.0)
        smtp_ok, smtp_detail = probe_tcp(self.host, self.smtp_port, timeout=2.0)
        healthy = imap_ok and smtp_ok
        return BackendHealth(
            healthy=healthy,
            backend=self.backend_origin,
            details={
                "imap": imap_detail,
                "smtp": smtp_detail,
                "uidvalidity": self.inbox_uidvalidity,
                "drafts_folder": self.drafts_folder,
            },
            last_op_latency_ms=self.last_op_latency_ms,
            error=None if healthy else f"imap={imap_ok} smtp={smtp_ok}",
        )

    # =========================================================================
    # 正向 sync — IMAP STATUS UIDNEXT 雷达
    # =========================================================================

    def detect_new_emails(self, marker: Any = None) -> RadarTick:
        """IMAP STATUS INBOX (UIDNEXT UIDVALIDITY) 轮询.

        marker=None: 启动 baseline, 返回 (uidvalidity, uidnext), has_new=False.
        marker=(uidvalidity, uidnext): 比对; uidvalidity 变了 → has_new=True + 全失效信号;
            uidnext 变大 → has_new=True, 估计新邮件数 = current_uidnext - last_uidnext.

        不在此处 fetch headers (lazy: 上层 new_watcher 收到 has_new=True 后再 fetch_recent
        或 fetch_email_by_id), 避免大批量 backfill 阻塞雷达节奏.
        """
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                t0 = time.time()
                typ, data = imap.status("INBOX", "(UIDNEXT UIDVALIDITY MESSAGES)")
                self.last_op_latency_ms = int((time.time() - t0) * 1000)
        except Exception as e:
            logger.warning(f"[davmail-backend] STATUS INBOX failed: {e}")
            return RadarTick(has_new=False, current_marker=marker, estimated_new_count=0)

        if typ != "OK" or not data:
            return RadarTick(has_new=False, current_marker=marker, estimated_new_count=0)

        uv = self._extract_status_value(data[0], "UIDVALIDITY")
        uidnext = self._extract_status_value(data[0], "UIDNEXT")
        try:
            current = (int(uv), int(uidnext))
        except (TypeError, ValueError):
            return RadarTick(has_new=False, current_marker=marker, estimated_new_count=0)

        if marker is None:
            return RadarTick(has_new=False, current_marker=current, estimated_new_count=0)

        try:
            last_uv, last_uidnext = marker
        except Exception:
            return RadarTick(has_new=True, current_marker=current, estimated_new_count=0)

        if int(last_uv) != current[0]:
            # UIDVALIDITY 变了 — Outlook server 重建 mailbox 索引, 所有 imap_uid 失效
            logger.warning(
                f"[davmail-backend] UIDVALIDITY changed: {last_uv} → {current[0]}, "
                f"all imap_uid 失效, 需触发 backfill"
            )
            return RadarTick(
                has_new=True, current_marker=current, estimated_new_count=-1,
            )

        delta = current[1] - int(last_uidnext)
        return RadarTick(
            has_new=delta > 0,
            current_marker=current,
            estimated_new_count=max(0, delta),
        )

    def fetch_email_by_id(
        self, internal_id: int, *, mailbox: Optional[str] = None
    ) -> Optional[EmailContent]:
        """查 SyncStore 拿 (uidvalidity, uid) 或 message_id, 然后 IMAP UID FETCH BODY[].

        修复 (review):
        - CRITICAL #3: UIDVALIDITY 从 SELECT 响应读 (untagged), 不调 STATUS 同 mailbox
        - MEDIUM: imap_uid > 0 才走快路径, ``-1`` (backfill 标记的 permanent miss) 直接
          fallback message_id 反查
        - MEDIUM: lookup_uid_by_message_id 命中后回写 sync_store 让下次走快路径
        """
        record = self.sync_store.get(internal_id)
        if not record:
            logger.warning(f"[davmail-backend] internal_id={internal_id} not in sync_store")
            return None

        imap_box = _mailbox_to_imap(mailbox or record.get("mailbox"))
        imap_uid_raw = record.get("imap_uid")
        imap_uid: Optional[int] = (
            int(imap_uid_raw) if isinstance(imap_uid_raw, int) and imap_uid_raw > 0 else None
        )
        imap_uv_raw = record.get("imap_uidvalidity")
        imap_uv: Optional[int] = (
            int(imap_uv_raw) if isinstance(imap_uv_raw, int) and imap_uv_raw > 0 else None
        )
        message_id = record.get("message_id") or ""

        # Sprint 16 收尾: timeout 60→120s. uid-mapper 后台并发跑时单封 fetch 偶发超时,
        # 让正向 sync 路径有更宽容窗口 (cfg.davmail_fetch_timeout_sec 可调, 默认 120s)
        fetch_timeout = int(getattr(self.cfg, "davmail_fetch_timeout_sec", 120))
        try:
            with imap_session(self.cfg, timeout=fetch_timeout) as imap:
                typ, _ = imap.select(imap_box, readonly=True)
                if typ != "OK":
                    logger.warning(f"[davmail-backend] SELECT {imap_box!r} failed")
                    return None

                # UIDVALIDITY 从 SELECT 响应读 (CRITICAL #3 协议合规)
                current_uv = _read_uidvalidity_from_select(imap)
                if current_uv:
                    self.inbox_uidvalidity = current_uv

                # 优先用 imap_uid 快路径 (要求 stored uidvalidity 跟 server 一致)
                if imap_uid and imap_uv and current_uv and current_uv != imap_uv:
                    logger.info(
                        f"[davmail-backend] UIDVALIDITY mismatch for "
                        f"internal_id={internal_id} (stored={imap_uv} vs server={current_uv}), "
                        f"fallback to message_id search"
                    )
                    imap_uid = None  # 失效, 走慢路径

                if not imap_uid:
                    if not message_id:
                        logger.warning(
                            f"[davmail-backend] internal_id={internal_id} no imap_uid "
                            f"AND no message_id — cannot locate"
                        )
                        return None
                    imap_uid = self._lookup_uid_by_message_id(imap, message_id)
                    if not imap_uid:
                        return None
                    # 命中后回写 sync_store 让下次走快路径 (review MEDIUM)
                    try:
                        self._update_sync_store_uid(internal_id, imap_uid, current_uv)
                    except Exception as e:
                        logger.warning(
                            f"[davmail-backend] update_sync_store_uid failed (non-fatal): {e}"
                        )

                # FETCH BODY[]
                t0 = time.time()
                typ, data = imap.uid(
                    "fetch", str(imap_uid),
                    "(UID INTERNALDATE FLAGS RFC822.SIZE BODY.PEEK[])",
                )
                self.last_op_latency_ms = int((time.time() - t0) * 1000)

                if typ != "OK" or not data:
                    return None

                # Sprint 16 收尾: stale UID 检测 + message_id fallback.
                # 现象: Outlook 端移动 / 规则处理 / 重排会让 server 端 UID 变 (例如
                # 147766 → 147767, UIDVALIDITY 不变). IMAP UID FETCH 返回 typ=OK 但
                # data=[None] (server 说邮件不在该 UID), 我们错误判定 valid 进 parse → None.
                # Fix: 第一次 fetch 失败 (data[0] is None 或 parse 返回 None) 时, fallback
                # 到 message_id IMAP SEARCH HEADER 反查新 UID + 回写 sync_store + 重 fetch.
                stale_uid_fetch = (
                    not data[0]  # data=[None] 或 data=[b'']
                    or (isinstance(data[0], (bytes, bytearray)) and not data[0])
                )
                ec = None if stale_uid_fetch else self._parse_fetch_response(
                    data, internal_id, imap_box
                )
                if ec:
                    return ec

                # 快路径 stale, fallback 到 message_id 反查 (仅当 message_id 已知)
                if not message_id:
                    logger.warning(
                        f"[davmail-backend] imap_uid={imap_uid} stale for "
                        f"internal_id={internal_id} AND no message_id → give up"
                    )
                    return None

                logger.info(
                    f"[davmail-backend] imap_uid={imap_uid} stale for "
                    f"internal_id={internal_id}, fallback message_id reverse lookup"
                )
                new_uid = self._lookup_uid_by_message_id(imap, message_id)
                if not new_uid or new_uid == imap_uid:
                    return None  # 反查也失败 / 跟原来一样 (邮件确实没了)

                # 命中新 UID, 回写 sync_store, 再 fetch
                try:
                    self._update_sync_store_uid(internal_id, new_uid, current_uv)
                except Exception as e:
                    logger.warning(
                        f"[davmail-backend] update_sync_store_uid failed (non-fatal): {e}"
                    )
                typ, data = imap.uid(
                    "fetch", str(new_uid),
                    "(UID INTERNALDATE FLAGS RFC822.SIZE BODY.PEEK[])",
                )
                if typ != "OK" or not data or not data[0]:
                    return None
                return self._parse_fetch_response(data, internal_id, imap_box)
        except Exception as e:
            logger.error(f"[davmail-backend] fetch_email_by_id({internal_id}) failed: {e}")
            return None

    def _update_sync_store_uid(
        self, internal_id: int, imap_uid: int, imap_uv: Optional[int]
    ) -> None:
        """命中 message_id 反查后, 回写 imap_uid (+ uidvalidity 若有) 让下次走快路径."""
        import sqlite3 as _sql
        db_path = self.cfg.sync_store_db_path
        with _sql.connect(db_path, timeout=5.0) as conn:
            conn.execute("PRAGMA busy_timeout = 5000")
            if imap_uv is not None:
                conn.execute(
                    "UPDATE email_metadata SET imap_uid = ?, imap_uidvalidity = ? "
                    "WHERE internal_id = ?",
                    (int(imap_uid), int(imap_uv), int(internal_id)),
                )
            else:
                conn.execute(
                    "UPDATE email_metadata SET imap_uid = ? WHERE internal_id = ?",
                    (int(imap_uid), int(internal_id)),
                )
            conn.commit()

    def fetch_recent(
        self, count: int, *, mailbox: Optional[str] = None
    ) -> list[EmailMeta]:
        """取末尾 count 个 UID → BATCH FETCH headers.

        MEDIUM: 用 UIDNEXT 估窗口 ``UID first:last`` 代替 ``SEARCH ALL`` (后者在 24k+
        邮箱上每次返回所有 UID, 浪费往返). Fallback ``SEARCH ALL`` 若窗口失败.
        ``EmailMeta.internal_id`` 在此处仍用 IMAP UID 作占位 (fetch_recent 是只读 helper,
        不写 SQLite, 不会触发主键冲突).
        """
        imap_box = _mailbox_to_imap(mailbox)
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(imap_box, readonly=True)
                if typ != "OK":
                    return []
                uv = _read_uidvalidity_from_select(imap)
                if uv:
                    self.inbox_uidvalidity = uv

                tail: list[bytes] = []
                # 优先估窗口: UIDNEXT - 2*count : * (×2 留 buffer 应对 expunged UIDs)
                try:
                    typ_s, data_s = imap.status(imap_box, "(UIDNEXT)")
                    if typ_s == "OK" and data_s:
                        uidnext_str = self._extract_status_value(data_s[0], "UIDNEXT")
                        if uidnext_str:
                            uidnext = int(uidnext_str)
                            window_lo = max(1, uidnext - max(count * 2, 50))
                            typ_w, data_w = imap.uid(
                                "search", None, "UID", f"{window_lo}:*",
                            )
                            if typ_w == "OK" and data_w and data_w[0]:
                                tail = data_w[0].split()[-count:]
                except Exception as e:
                    logger.debug(f"[davmail-backend] UIDNEXT window failed, fallback ALL: {e}")
                # Fallback: 全量 SEARCH (mailbox 小或 UIDNEXT 不可用)
                if not tail:
                    typ, data = imap.uid("search", None, "ALL")
                    if typ != "OK" or not data or not data[0]:
                        return []
                    all_uids = data[0].split()
                    tail = all_uids[-count:] if len(all_uids) > count else all_uids
                if not tail:
                    return []
                uid_seq = b",".join(tail).decode()
                typ, data = imap.uid(
                    "fetch", uid_seq,
                    "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS "
                    "(MESSAGE-ID SUBJECT FROM DATE REFERENCES IN-REPLY-TO)])",
                )
                if typ != "OK" or not data:
                    return []
                dicts = self._parse_batch_headers(data)
                return [
                    EmailMeta(
                        message_id=d["message_id"],
                        internal_id=int(d.get("imap_uid") or 0),  # readonly helper, not PK
                        subject=d["subject"], sender=d["sender"],
                        date_received=d["date_received"], is_read=d["is_read"],
                        is_flagged=d["is_flagged"], thread_id=d["thread_id"],
                        mailbox=imap_box, imap_uid=d["imap_uid"],
                        imap_uidvalidity=d["imap_uidvalidity"],
                    )
                    for d in dicts
                ]
        except Exception as e:
            logger.error(f"[davmail-backend] fetch_recent failed: {e}")
            return []

    # =========================================================================
    # 反向 sync — UID STORE
    # =========================================================================

    def mark_as_read(
        self,
        identifier: Union[int, str],
        read: bool = True,
        *,
        mailbox: Optional[str] = None,
    ) -> bool:
        """标记已读. 接受 ``int`` (internal_id) 或 ``str`` (message_id), 对齐
        ``AppleScriptArm.mark_as_read`` 多形签名 — 让 ``self.arm = self`` alias 兼容层
        在 handlers/reverse_sync 字符串 fallback 路径下也正确 dispatch (review HIGH #3).
        """
        flag = "(\\Seen)"
        op = "+FLAGS" if read else "-FLAGS"
        return self._store_flag(identifier, op, flag, mailbox)

    def set_flag(
        self,
        identifier: Union[int, str],
        flagged: bool = True,
        *,
        mailbox: Optional[str] = None,
    ) -> bool:
        """标记/取消旗标. 同 ``mark_as_read`` 接受 int 或 message_id str."""
        flag = "(\\Flagged)"
        op = "+FLAGS" if flagged else "-FLAGS"
        return self._store_flag(identifier, op, flag, mailbox)

    def _resolve_record_for_flag_op(
        self, identifier: Union[int, str]
    ) -> Optional[dict]:
        """根据 ``int`` (internal_id) 或 ``str`` (message_id) 查 sync_store record."""
        if isinstance(identifier, int):
            return self.sync_store.get(identifier)
        if isinstance(identifier, str) and identifier.strip():
            return self.sync_store.get_by_message_id(identifier.strip())
        return None

    def _store_flag(
        self,
        identifier: Union[int, str],
        op: str,
        flag: str,
        mailbox: Optional[str],
    ) -> bool:
        record = self._resolve_record_for_flag_op(identifier)
        if not record:
            logger.warning(
                f"[davmail-backend] _store_flag: record not found for "
                f"identifier={identifier!r} (type={type(identifier).__name__})"
            )
            return False
        internal_id = record.get("internal_id") if isinstance(record, dict) else None
        imap_box = _mailbox_to_imap(mailbox or record.get("mailbox"))
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, _ = imap.select(imap_box, readonly=False)
                if typ != "OK":
                    logger.warning(f"[davmail-backend] SELECT {imap_box!r} (rw) failed")
                    return False
                # CRITICAL #3: 检查 server 是否把 SELECT 静默降级 read-only
                # (DavMail 共享邮箱场景偶发, 否则 STORE 静默无效).
                if not _select_is_writable(imap):
                    logger.error(
                        f"[davmail-backend] SELECT {imap_box!r} returned READ-ONLY, "
                        f"STORE aborted (internal_id={internal_id})"
                    )
                    return False
                # UIDVALIDITY 从 SELECT 响应读 (CRITICAL #3)
                current_uv = _read_uidvalidity_from_select(imap)
                if current_uv:
                    self.inbox_uidvalidity = current_uv

                imap_uid_raw = record.get("imap_uid")
                imap_uid: Optional[int] = (
                    int(imap_uid_raw)
                    if isinstance(imap_uid_raw, int) and imap_uid_raw > 0
                    else None
                )
                imap_uv_raw = record.get("imap_uidvalidity")
                imap_uv: Optional[int] = (
                    int(imap_uv_raw)
                    if isinstance(imap_uv_raw, int) and imap_uv_raw > 0
                    else None
                )
                # UIDVALIDITY mismatch → 旧 imap_uid 失效
                if imap_uid and imap_uv and current_uv and current_uv != imap_uv:
                    logger.info(
                        f"[davmail-backend] _store_flag UIDVALIDITY mismatch "
                        f"(stored={imap_uv} vs server={current_uv}), fallback message_id"
                    )
                    imap_uid = None
                if not imap_uid:
                    msg_id = record.get("message_id") or ""
                    if not msg_id:
                        logger.warning(
                            f"[davmail-backend] _store_flag: no imap_uid + no message_id "
                            f"for record (internal_id={internal_id})"
                        )
                        return False
                    imap_uid = self._lookup_uid_by_message_id(imap, msg_id)
                    if not imap_uid:
                        return False
                    # 命中后回写
                    if internal_id:
                        try:
                            self._update_sync_store_uid(int(internal_id), imap_uid, current_uv)
                        except Exception as e:
                            logger.warning(
                                f"[davmail-backend] _store_flag: uid backfill failed: {e}"
                            )
                t0 = time.time()
                typ, _ = imap.uid("store", str(imap_uid), op, flag)
                self.last_op_latency_ms = int((time.time() - t0) * 1000)
                return typ == "OK"
        except Exception as e:
            logger.error(f"[davmail-backend] _store_flag failed: {e}")
            return False

    # =========================================================================
    # 草稿创建 — IMAP APPEND
    # =========================================================================

    def append_draft(self, draft: DraftRequest) -> DraftAppendResult:
        """Build MIME (multipart/alternative HTML + plain) → IMAP APPEND.

        Phase A.3 内嵌简化 MIME builder; Phase B 抽到 src/mail/draft_builder.py 并支持
        附件 / 完整 reply-all 收件人计算 / In-Reply-To 自动推断.
        """
        folder = draft.drafts_folder or self.drafts_folder or "Drafts"

        try:
            mime_bytes = self._build_reply_mime(draft)
        except Exception as e:
            return DraftAppendResult(
                success=False, drafts_folder=folder, error=f"MIME build failed: {e}",
            )

        try:
            with imap_session(self.cfg, timeout=60) as imap:
                t0 = time.time()
                # \\Seen + \\Draft: Outlook 客户端约定 draft 由发件人创建即 seen,
                # 否则 Drafts 列表会标 unread 计数, UX 异常 (review MEDIUM).
                typ, data = imap.append(folder, "(\\Draft \\Seen)", None, mime_bytes)
                self.last_op_latency_ms = int((time.time() - t0) * 1000)

                if typ != "OK":
                    return DraftAppendResult(
                        success=False, drafts_folder=folder,
                        error=f"IMAP APPEND failed: {data}",
                    )
                # APPENDUID extension 返回 UID, 解析它
                appended_uid = self._parse_appenduid(data)
                logger.info(
                    f"[davmail-backend] append_draft → {folder!r} "
                    f"uid={appended_uid} latency={self.last_op_latency_ms}ms"
                )
                return DraftAppendResult(
                    success=True, drafts_folder=folder, appended_uid=appended_uid,
                    method="imap_append",
                )
        except Exception as e:
            logger.error(f"[davmail-backend] append_draft failed: {e}")
            return DraftAppendResult(
                success=False, drafts_folder=folder, error=f"append exception: {e}",
            )

    # =========================================================================
    # 内部 helpers
    # =========================================================================

    @staticmethod
    def _extract_status_value(line: bytes, key: str) -> Optional[str]:
        """从 STATUS response line 提取指定 key 的值.

        line 形如: b'INBOX (UIDNEXT 12345 UIDVALIDITY 67890 MESSAGES 24000)'
        """
        if not line:
            return None
        text = line.decode("utf-8", errors="replace")
        tokens = text.replace("(", " ").replace(")", " ").split()
        for i, tok in enumerate(tokens):
            if tok.upper() == key.upper() and i + 1 < len(tokens):
                return tokens[i + 1]
        return None

    @staticmethod
    def _lookup_uid_by_message_id(imap, message_id: str) -> Optional[int]:
        """IMAP UID SEARCH HEADER Message-ID '<msg-id>' 反查 UID.

        HIGH #2: 用 ``_quote_imap_string`` quote Message-ID — 含 ``<>+=`` / ``"`` / 空格
        的 message_id 不 quote 会被 server 当 atom 解析失败 (RFC 3501 §4.3 + §6.4.4).
        """
        if not message_id:
            return None
        mid_clean = message_id.strip()
        # IMAP SEARCH 需要带 < > 的完整 Message-ID
        if not mid_clean.startswith("<"):
            mid_clean = f"<{mid_clean}>"
        quoted = _quote_imap_string(mid_clean)
        try:
            typ, data = imap.uid("search", None, "HEADER", "Message-ID", quoted)
        except Exception as e:
            logger.warning(
                f"[davmail-backend] UID SEARCH HEADER failed for {mid_clean[:60]!r}: {e}"
            )
            return None
        if typ != "OK" or not data or not data[0]:
            return None
        try:
            return int(data[0].split()[0])
        except Exception:
            return None

    def _parse_fetch_response(
        self, data: list, internal_id: int, imap_box: str
    ) -> Optional[EmailContent]:
        """从 UID FETCH 响应解析出 EmailContent.

        修复 (review):
        - MEDIUM: 不再 ``break`` 在第一个 tuple — IMAP 大邮件用 literal `{octets}`
          续传可能跨多个 list item, 必须 **concat** 所有 ``item[1]`` 才能拿到完整 MIME.
        - HIGH #5: ``date_received`` 归一为 ISO 8601 (跟 AppleScript 路径对齐).
        """
        mime_chunks: list[bytes] = []
        uid_returned: Optional[int] = None
        flags_returned: list[str] = []
        for item in data:
            if not (isinstance(item, tuple) and len(item) >= 2):
                continue
            meta_bytes = item[0] if isinstance(item[0], (bytes, bytearray)) else (
                item[0].encode() if isinstance(item[0], str) else b""
            )
            meta = meta_bytes.decode("utf-8", errors="replace")
            m_uid = self._extract_status_value(meta_bytes, "UID")
            if m_uid and uid_returned is None:
                try:
                    uid_returned = int(m_uid)
                except (TypeError, ValueError):
                    pass
            if "\\Seen" in meta and "\\Seen" not in flags_returned:
                flags_returned.append("\\Seen")
            if "\\Flagged" in meta and "\\Flagged" not in flags_returned:
                flags_returned.append("\\Flagged")
            body = item[1]
            if isinstance(body, (bytes, bytearray)):
                mime_chunks.append(bytes(body))
            elif isinstance(body, str):
                mime_chunks.append(body.encode("utf-8", errors="replace"))

        if not mime_chunks:
            return None

        mime_bytes = b"".join(mime_chunks)

        msg = BytesParser().parsebytes(mime_bytes)
        message_id = (msg.get("Message-ID") or "").strip().strip("<>")
        # RFC 2047 decode — DavMail IMAP 返回 raw encoded-word, AppleScript 返回 decoded 字符串
        subject = _decode_mime_header(msg.get("Subject"))
        sender_full = _decode_mime_header(msg.get("From"))
        sender = _extract_first_email(sender_full) or sender_full
        date_str = msg.get("Date") or ""
        references = msg.get("References") or ""
        in_reply_to = msg.get("In-Reply-To") or ""
        thread_id = None
        if references:
            refs = references.strip().split()
            if refs:
                thread_id = refs[0].strip("<>")
        elif in_reply_to:
            thread_id = in_reply_to.strip().strip("<>")
        if not thread_id and message_id:
            thread_id = message_id

        # 抽 text/plain 部分作为 content (HTML 部分留在 source 里给 v4 SQLite SSoT 解析)
        content = ""
        if msg.is_multipart():
            for part in msg.walk():
                if (
                    part.get_content_type() == "text/plain"
                    and not (part.get("Content-Disposition", "") or "").startswith("attachment")
                ):
                    try:
                        payload = part.get_payload(decode=True)
                        if payload:
                            content = payload.decode(
                                part.get_content_charset() or "utf-8", errors="replace",
                            )
                            break
                    except Exception:
                        pass
        else:
            try:
                payload = msg.get_payload(decode=True)
                if payload:
                    content = payload.decode(
                        msg.get_content_charset() or "utf-8", errors="replace",
                    )
            except Exception:
                pass

        return EmailContent(
            message_id=message_id,
            internal_id=internal_id,
            subject=subject,
            sender=sender,
            date_received=_normalize_date_iso(date_str),  # HIGH #5: ISO 8601 归一
            content=content,
            source=mime_bytes.decode("utf-8", errors="replace"),
            is_read="\\Seen" in flags_returned,
            is_flagged="\\Flagged" in flags_returned,
            thread_id=thread_id,
            mailbox=imap_box,
            imap_uid=uid_returned,
            imap_uidvalidity=self.inbox_uidvalidity,
        )

    def _build_reply_mime(self, draft: DraftRequest) -> bytes:
        """Build multipart/alternative MIME for IMAP APPEND.

        修复 (review HIGH/MEDIUM):
        - HIGH #4: In-Reply-To 强制 ``<msg-id>`` 包裹 (RFC 5322 §3.6.4 要求 msg-id 必须
          带角括号); References 由调用方传完整 chain (``<old_refs> <old_msgid>``).
        - MEDIUM: From 加 display name (跟 user_email 配合, 否则 enterprise SMTP 会被
          DKIM/SPF 拒); 加 ``User-Agent`` 标识便于过滤; 透传 ``Reply-To`` 字段.
        """
        msg = EmailMessage()
        from_display = getattr(self.cfg, "user_name", "") or ""
        from_email = self.cfg.user_email
        msg["From"] = f"{from_display} <{from_email}>" if from_display else from_email
        if draft.to:
            msg["To"] = ", ".join(draft.to)
        if draft.cc:
            msg["Cc"] = ", ".join(draft.cc)
        msg["Subject"] = draft.subject or "(no subject)"
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain="mailagent.local")
        if draft.in_reply_to:
            irt = draft.in_reply_to.strip()
            if not irt.startswith("<"):
                irt = f"<{irt}>"
            msg["In-Reply-To"] = irt
        if draft.references:
            # 调用方应传完整 chain (``<old_refs> <old_msgid>``); 这里只做空白归一
            refs_clean = " ".join(draft.references.split())
            if refs_clean:
                msg["References"] = refs_clean
        elif draft.in_reply_to:
            irt = draft.in_reply_to.strip()
            if not irt.startswith("<"):
                irt = f"<{irt}>"
            msg["References"] = irt

        msg["User-Agent"] = "MailAgent/dual-backend/davmail"

        msg.set_content(draft.reply_text or "(empty body)")
        if draft.reply_html:
            msg.add_alternative(draft.reply_html, subtype="html")
        return msg.as_bytes()

    # =========================================================================
    # Arm/Radar 兼容层 (Phase B): 让 NewWatcher / fanout / handler 的 self.arm.*
    # / self.radar.* 调用在 davmail mode 直接 work, 不需要改 19+ 处调用代码.
    # =========================================================================

    # --- AppleScriptArm 兼容接口 ---

    def fetch_email_content_by_id(
        self, internal_id: int, mailbox: Optional[str] = None
    ) -> Optional[dict]:
        """AppleScriptArm.fetch_email_content_by_id 兼容 — 返回 legacy dict."""
        ec = self.fetch_email_by_id(internal_id, mailbox=mailbox)
        return ec.to_legacy_dict() if ec else None

    def fetch_email_by_message_id(
        self, message_id: str, mailbox: Optional[str] = None
    ) -> Optional[dict]:
        """通过 message_id IMAP SEARCH HEADER 反查 + FETCH. legacy dict 返回."""
        if not message_id:
            return None
        imap_box = _mailbox_to_imap(mailbox)
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(imap_box, readonly=True)
                if typ != "OK":
                    return None
                imap_uid = self._lookup_uid_by_message_id(imap, message_id)
                if not imap_uid:
                    return None
                typ, data = imap.uid(
                    "fetch", str(imap_uid),
                    "(UID INTERNALDATE FLAGS RFC822.SIZE BODY.PEEK[])",
                )
                if typ != "OK" or not data:
                    return None
                # 此处 internal_id 未知 — 用占位 (调用方通常只用 dict 的 message_id/subject 等)
                ec = self._parse_fetch_response(data, internal_id=-1, imap_box=imap_box)
                return ec.to_legacy_dict() if ec else None
        except Exception as e:
            logger.error(f"[davmail-backend] fetch_email_by_message_id failed: {e}")
            return None

    def fetch_emails_by_position(
        self, count: int, mailbox: Optional[str] = None
    ) -> list[dict]:
        """AppleScriptArm.fetch_emails_by_position 兼容 — IMAP UID SEARCH ALL 末尾 N 封."""
        metas = self.fetch_recent(count, mailbox=mailbox)
        return [
            {
                "message_id": m.message_id, "id": m.internal_id,
                "subject": m.subject, "sender": m.sender,
                "date_received": m.date_received, "is_read": m.is_read,
                "is_flagged": m.is_flagged, "thread_id": m.thread_id,
            }
            for m in metas
        ]

    def mark_as_read_by_id(
        self, internal_id: int, read: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """AppleScriptArm.mark_as_read_by_id 兼容."""
        return self.mark_as_read(internal_id, read, mailbox=mailbox)

    def set_flag_by_id(
        self, internal_id: int, flagged: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """AppleScriptArm.set_flag_by_id 兼容."""
        return self.set_flag(internal_id, flagged, mailbox=mailbox)

    def extract_thread_id(self, source: str) -> Optional[str]:
        """AppleScriptArm.extract_thread_id 兼容 — 从 raw MIME 提取 thread_id."""
        if not source:
            return None
        try:
            import email
            msg = email.message_from_string(source)
            references = msg.get("References")
            if references:
                refs = references.strip().split()
                if refs:
                    return refs[0].strip().strip("<>")
            in_reply_to = msg.get("In-Reply-To")
            if in_reply_to:
                return in_reply_to.strip().strip("<>")
        except Exception as e:
            logger.warning(f"[davmail-backend] extract_thread_id failed: {e}")
        return None

    # --- SQLiteRadar 兼容接口 ---

    def is_available(self) -> bool:
        """SQLiteRadar.is_available 兼容 — TCP probe IMAP 端口."""
        ok, _ = probe_tcp(self.host, self.imap_port, timeout=2.0)
        return ok

    def get_current_max_row_id(self) -> int:
        """SQLiteRadar.get_current_max_row_id 兼容 — 返回当前 IMAP UIDNEXT.

        DavMail marker = uidnext (int). uidvalidity 内部缓存在 self.inbox_uidvalidity,
        变化时 detect_new_emails / check_for_changes 会 log warning. 主循环用 uidnext
        作为 SyncStore.last_max_row_id 持久化.
        """
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, data = imap.status("INBOX", "(UIDNEXT UIDVALIDITY)")
                if typ == "OK" and data:
                    uidnext = self._extract_status_value(data[0], "UIDNEXT")
                    uv = self._extract_status_value(data[0], "UIDVALIDITY")
                    if uv:
                        self.inbox_uidvalidity = int(uv)
                    if uidnext:
                        return int(uidnext)
        except Exception as e:
            logger.warning(f"[davmail-backend] get_current_max_row_id failed: {e}")
        return 0

    def check_for_changes(
        self, last_max_row_id: int
    ) -> tuple[bool, int, int]:
        """SQLiteRadar.check_for_changes 兼容 — STATUS UIDNEXT 比对.

        Returns: (has_new, current_uidnext, estimated_new_count)
        """
        current = self.get_current_max_row_id()
        if current == 0:
            return (False, last_max_row_id, 0)
        delta = current - int(last_max_row_id or 0)
        return (delta > 0, current, max(0, delta))

    def get_new_emails(self, since_row_id: int) -> list[dict]:
        """SQLiteRadar.get_new_emails 兼容 — IMAP UID SEARCH UID > since + BATCH FETCH.

        davmail mode 关键: 每条邮件通过 ``sync_store.allocate_davmail_internal_id()``
        分配独立 internal_id (>= 1_000_000_000), **不再**复用 IMAP UID 作 internal_id —
        因为 IMAP UID 通常是几千~几十万的小数字, 跟 Mail.app ROWID 空间冲突. 同时填好
        ``imap_uid`` / ``imap_uidvalidity`` / ``backend_origin='davmail'`` / ``mailbox``
        字段, 让上层 ``new_watcher._poll_cycle`` 直接透传到 ``sync_store.save_email`` 即可
        (review CRITICAL #2 修复).
        """
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, select_data = imap.select("INBOX", readonly=True)
                if typ != "OK":
                    return []
                # 从 SELECT 响应读 UIDVALIDITY (untagged response), 避免协议违反
                # (RFC 3501 §6.3.10: STATUS 不能跟在 SELECT 同 mailbox 之后).
                uv = _read_uidvalidity_from_select(imap)
                if uv:
                    self.inbox_uidvalidity = uv
                # IMAP UID SEARCH: UID since_row_id+1:*
                search_arg = f"{int(since_row_id) + 1}:*"
                typ, data = imap.uid("search", None, "UID", search_arg)
                if typ != "OK" or not data or not data[0]:
                    return []
                uids = data[0].split()
                if not uids:
                    return []
                uid_seq = b",".join(uids).decode()
                typ, data = imap.uid(
                    "fetch", uid_seq,
                    "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS "
                    "(MESSAGE-ID SUBJECT FROM DATE REFERENCES IN-REPLY-TO)])",
                )
                if typ != "OK" or not data:
                    return []
                parsed = self._parse_batch_headers(data)
                # davmail 分配独立 internal_id + 填上 backend_origin/mailbox label
                mailbox_label = _imap_to_mailbox_label("INBOX")
                out: list[dict] = []
                for item in parsed:
                    try:
                        item["internal_id"] = self.sync_store.allocate_davmail_internal_id()
                    except Exception as e:
                        logger.error(
                            f"[davmail-backend] allocate_davmail_internal_id failed for "
                            f"imap_uid={item.get('imap_uid')}: {e}"
                        )
                        continue
                    item["backend_origin"] = "davmail"
                    item["mailbox"] = mailbox_label
                    out.append(item)
                if len(out) != len(uids):
                    logger.warning(
                        f"[davmail-backend] get_new_emails: parsed {len(out)} from "
                        f"{len(uids)} UIDs (missing {len(uids) - len(out)})"
                    )
                return out
        except Exception as e:
            logger.error(f"[davmail-backend] get_new_emails failed: {e}")
            return []

    def set_last_max_row_id(self, row_id: int) -> None:
        """SQLiteRadar.set_last_max_row_id 兼容 — 内存缓存 (持久化走 sync_store)."""
        self._cached_marker = int(row_id) if row_id else None

    def get_last_max_row_id(self) -> int:
        """SQLiteRadar.get_last_max_row_id 兼容."""
        return self._cached_marker or 0

    def _parse_batch_headers(self, data: list) -> list[dict]:
        """从 batch FETCH HEADER.FIELDS 响应解析出 dict list.

        注意 ``internal_id`` 字段**不在这里设置** — davmail mode 下应由调用方
        (``get_new_emails`` / ``fetch_recent``) 通过 ``sync_store.allocate_davmail_internal_id()``
        分配 (>= 1_000_000_000), 跟 Mail.app ROWID 空间不冲突. 这里只填 ``imap_uid``
        (真实 IMAP UID, 可能小数字) + ``imap_uidvalidity``.

        ``date_received`` 归一成 ISO 8601, 跟 AppleScript 路径口径一致 (RFC 822 字符串
        排序会乱).

        丢条目时一律 WARNING log (review CRITICAL: 静默丢邮件会让正向 sync 丢数据
        而不告警). expected_count 由调用方提供时附加 discrepancy 提示.
        """
        results: list[dict] = []
        dropped = 0
        for idx, item in enumerate(data):
            if not (isinstance(item, tuple) and len(item) >= 2):
                # imaplib 在 batch FETCH 中会插入纯 bytes (e.g. b')') 作 closing,
                # 这是协议正常现象, 不计入 dropped.
                continue
            meta_bytes = item[0] if isinstance(item[0], (bytes, bytearray)) else (
                item[0].encode() if isinstance(item[0], str) else b""
            )
            meta = meta_bytes.decode("utf-8", errors="replace")
            uid_str = self._extract_status_value(meta_bytes, "UID")
            try:
                uid = int(uid_str) if uid_str else 0
            except (TypeError, ValueError):
                logger.warning(
                    f"[davmail-backend] _parse_batch_headers: bad UID in meta[{idx}]={meta[:80]!r}"
                )
                dropped += 1
                continue
            if uid <= 0:
                logger.warning(
                    f"[davmail-backend] _parse_batch_headers: missing UID in meta[{idx}]={meta[:80]!r}"
                )
                dropped += 1
                continue
            flags = []
            if "\\Seen" in meta:
                flags.append("\\Seen")
            if "\\Flagged" in meta:
                flags.append("\\Flagged")
            try:
                body_bytes = (
                    bytes(item[1]) if isinstance(item[1], (bytes, bytearray))
                    else (item[1].encode() if isinstance(item[1], str) else b"")
                )
                msg = BytesParser().parsebytes(body_bytes)
            except Exception as e:
                logger.warning(
                    f"[davmail-backend] _parse_batch_headers: MIME parse failed uid={uid}: {e}"
                )
                dropped += 1
                continue
            message_id = (msg.get("Message-ID") or "").strip().strip("<>")
            references = msg.get("References") or ""
            in_reply_to = msg.get("In-Reply-To") or ""
            thread_id = None
            if references:
                refs = references.strip().split()
                if refs:
                    thread_id = refs[0].strip("<>")
            elif in_reply_to:
                thread_id = in_reply_to.strip().strip("<>")
            from_decoded = _decode_mime_header(msg.get("From"))
            sender_email = _extract_first_email(from_decoded) or from_decoded
            results.append({
                "message_id": message_id,
                # NOTE: internal_id 不在此设置, davmail mode 由调用方分配 (>=10^9).
                "subject": _decode_mime_header(msg.get("Subject")),
                "sender": sender_email,  # 纯 email 地址 (对齐 AppleScript 路径)
                "sender_name": _extract_display_name(from_decoded),
                "date_received": _normalize_date_iso(msg.get("Date") or ""),
                "is_read": "\\Seen" in flags,
                "is_flagged": "\\Flagged" in flags,
                "thread_id": thread_id,
                "imap_uid": uid,
                "imap_uidvalidity": self.inbox_uidvalidity,
                "references_raw": references.strip() or None,
                "in_reply_to_raw": in_reply_to.strip().strip("<>") or None,
            })
        if dropped:
            logger.warning(
                f"[davmail-backend] _parse_batch_headers dropped {dropped} item(s) from batch of {len(data)}"
            )
        return results

    @staticmethod
    def _parse_appenduid(data: list) -> Optional[int]:
        """从 APPEND 响应解析 APPENDUID extension 返回的 UID.

        RFC 4315 响应形如 ``* OK [APPENDUID uidvalidity uid] msg`` — 用 regex 提取
        比 token-split 鲁棒 (server 包装差异 / 不同空白处理都不影响) (review MEDIUM).
        """
        if not data:
            return None
        joined_parts: list[bytes] = []
        for item in data:
            if isinstance(item, (bytes, bytearray)):
                joined_parts.append(bytes(item))
            elif isinstance(item, str):
                joined_parts.append(item.encode("utf-8", errors="replace"))
        if not joined_parts:
            return None
        joined = b" ".join(joined_parts)
        m = _APPENDUID_PATTERN.search(joined)
        if not m:
            return None
        try:
            return int(m.group(1))
        except (TypeError, ValueError):
            return None
