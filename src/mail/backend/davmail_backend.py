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
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header

from src.mail.charset_utils import decode_mime_bytes
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
from typing import TYPE_CHECKING, Optional, Union

from loguru import logger

from src.mail.backend.base import IMailBackend, MarkerUnavailableError
from src.mail.backend.imap_client import (
    DavMailConnectionError,
    _status_message_count,
    discover_drafts_folder,
    discover_sent_folder,
    imap_connect,
    imap_session,
    parse_folder_csv_or_json,
    probe_tcp,
    quote_mailbox,
)
from src.mail.backend.imap_utf7 import decode_imap_utf7, encode_imap_utf7
from src.mail.mailbox_semantics import (
    DRAFTS_LABEL,
    INBOX_LABEL,
    SENT_LABEL,
    SENT_LABEL_VARIANTS,
    is_drafts_mailbox,
    is_sent_mailbox,
    sql_in_predicate,
)
from src.mail.backend.types import (
    BackendOrigin,
    DraftAppendResult,
    DraftRequest,
    EmailContent,
    EmailMeta,
    SendResult,
)

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.sync_store import SyncStore

# RFC 4315 APPENDUID response: [APPENDUID uidvalidity uid]
_APPENDUID_PATTERN = re.compile(rb"APPENDUID\s+(\d+)\s+(\d+)", re.IGNORECASE)
# RFC 2369 Message-ID 完整匹配 (用 regex 而非 ``in`` 避免 partial match 误判)
_MSGID_PATTERN = re.compile(r"<[^<>\s]+>")

# issue #46 大邮箱 folderSizeLimit 探测的进程级一次性门控 (codex HIGH-2)。
# 🔴 必须是模块级进程全局而非实例属性: 常驻 serve-api 每请求新建 ServiceContext →
# create_backend() → probe_readiness() (src/api/deps.py per-request; llm_service 每次
# run 同理), 实例级门控会让每个相关请求都起一个最长 240s 的 STATUS INBOX daemon
# 线程, 大邮箱下并发重复打 EWS 全量枚举 —— 恰好重新引入探测本身要预警的 throttling 风险。
_mailbox_size_probe_lock = threading.Lock()
_mailbox_size_probe_started = False


def _claim_mailbox_size_probe() -> bool:
    """原子 claim 进程级探测权: check-and-set 在同一临界区, 首次返回 True, 之后恒 False."""
    global _mailbox_size_probe_started
    with _mailbox_size_probe_lock:
        if _mailbox_size_probe_started:
            return False
        _mailbox_size_probe_started = True
        return True


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
        # make_header 是 strict 解码: 声明 gb2312 实际 GBK 字节会抛 →
        # 逐 chunk 按超集 charset 重解, 避免把 raw encoded-word 存进库
        logger.warning(
            f"[davmail-backend] RFC 2047 strict decode failed for header={value[:60]!r}: {e}, "
            f"retrying with superset charsets"
        )
        try:
            return "".join(
                chunk if isinstance(chunk, str) else decode_mime_bytes(chunk, charset)
                for chunk, charset in decode_header(value)
            )
        except Exception:
            return value


def _normalize_date_iso(date_str: str) -> str:
    """RFC 822 Date 头 → ISO 8601 (UTC 偏移). 失败 fallback 原值.

    AppleScript 路径 ``raw['date']`` 来自 ``EmailDate.isoformat()``, davmail 路径直接拿
    MIME ``Date`` 头 (RFC 822). 把 davmail 路径归一成 ISO, 跟 EmailContent.date_received
    docstring 约定 + 前端 EmailList 排序口径一致.

    统一 ``astimezone(utc)``: 排序全链路是词法字符串比较 (SQL TEXT ORDER BY +
    localeCompare), 保留原始偏移会让 ``10:54+08:00`` 字典序压过 ``05:58+00:00``
    (绝对时间更晚的反而排前)。同一绝对时刻, 仅偏移表示归一。
    """
    if not date_str:
        return ""
    try:
        dt = parsedate_to_datetime(date_str)
        if dt is None:
            return date_str
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return date_str


# RFC 5322 §2.2.3 folding: CRLF + 续行空白. Message-ID 内部不允许任何 WSP,
# 所以折行处整段删除 (不像普通 header 那样 unfold 成一个空格) 才是无损还原.
_HEADER_FOLD_RE = re.compile(r"[\r\n]+[ \t]*")


def _normalize_message_id(value: Optional[str]) -> str:
    """Message-ID 归一化: RFC 2047 decode + unfold + 去尖括号 → 裸 msgid.

    发件方 (Bugzilla / 旧版 Outlook 中继) 会把长 Message-ID 编成 encoded-word 并折行::

        =?UTF-8?Q?=3Cbug-1289017-...?=\\r\\n =?UTF-8?Q?/=3E?=

    这个原始值一路存进 ``email_metadata.message_id`` 后有两类故障:

    1. 拿去拼 IMAP ``UID SEARCH HEADER Message-ID "<...>"`` 时, quoted-string 里
       带 CR/LF 违反 RFC 3501 §4.3 → DavMail 报 ``Invalid quoted token`` → fetch
       确定性失败 → 退避 5 次进 dead_letter (issue #47);
    2. 静默错配 —— 线程根兜底 (``_thread_id_from_headers``) 拿它当 thread_id 会断
       线程; ``get_by_message_id`` 去重/跨 backend merge 是纯等值比较, 同一封信
       AppleScript 路径存干净值、davmail 路径存脏值 → 两行并存.

    所以归一化落在**写入侧**(三个 parse 点), 两类故障一并消掉; 读取侧
    (``_lookup_uid_by_message_id``) 再做一次是为了兼容修复前已经存脏的库行,
    不需要数据迁移. 干净 ASCII 值上是 no-op, 字节不变.

    单独 decode 不够: 纯 ASCII 的折行 msgid (无 encoded-word) 过 ``decode_header``
    原样返回, ``\\r\\n`` 还在 —— decode 与 unfold 两步缺一不可.
    """
    if not value:
        return ""
    return _HEADER_FOLD_RE.sub("", _decode_mime_header(value)).strip().strip("<>")


def _quote_imap_string(value: str) -> str:
    """IMAP 字符串字面量 quote (RFC 3501 §4.3 quoted string).

    ``imaplib.IMAP4.uid("search", "HEADER", "Message-ID", value)`` 不会自动 quote
    含 ``<>+=`` 之类特殊字符的 Message-ID; 必须显式 quote 否则 server 当 atom 解析失败.

    CR/LF 在 quoted-string 里非法 (§4.3 QUOTED-CHAR 排除), 一旦漏进来 server 会
    直接 ``Invalid quoted token``. 调用方本应先归一化 (见 ``_normalize_message_id``),
    这里剔除是第二层保险 —— 宁可 SEARCH 命中 0 条, 不要整条连接报错.
    """
    stripped = _HEADER_FOLD_RE.sub("", value)
    return '"' + stripped.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _thread_id_from_headers(
    references: Optional[str],
    in_reply_to: Optional[str],
    message_id: str = "",
) -> Optional[str]:
    """从 References / In-Reply-To 头提取线程根 Message-ID (thread_id).

    DavMail IMAP 返回 raw MIME: 长 Message-ID 的 References / In-Reply-To 可能被
    RFC 2047 编码成 ``=?utf-8?q?=3C...?=`` (我方旧版发件 + 对端 Outlook 继承/转发都会
    带这种头). 必须先 ``_decode_mime_header`` 解码再 split — 否则取到的是 encoded-word
    碎片 (还被折行截断), 与原邮件干净 thread_id 不相等 → 同一线程被切成两段
    (见 fix/reply-thread-rfc2047). 对已是干净 ASCII 的头, 解码是 no-op, 字节不变.

    ``message_id`` 非空时作为最终兜底 (无 References/In-Reply-To 的线程根邮件); 传 ""
    则无兜底 (返回 None), 保持各调用点原有语义.
    """
    refs_decoded = _decode_mime_header(references)
    if refs_decoded:
        parts = refs_decoded.split()
        if parts:
            return parts[0].strip("<>")
    irt_decoded = _decode_mime_header(in_reply_to)
    if irt_decoded:
        return irt_decoded.strip().strip("<>")
    mid = (message_id or "").strip().strip("<>")
    return mid or None


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

        # probe 时探测填充。配置值是显示名 (可能中文如 '草稿'), 而 IMAP SELECT/STATUS
        # 需 modified-UTF7 原始名 → encode_imap_utf7 (对纯 ASCII 恒等, 仅转义 &; 中文则
        # 编码)。probe 路径 (discover_drafts_folder) 返回的已是 IMAP LIST 原始名, 不经过这里。
        _drafts_cfg = getattr(cfg, "davmail_drafts_folder", "") or None
        self.drafts_folder: Optional[str] = (
            encode_imap_utf7(_drafts_cfg) if _drafts_cfg else None
        )
        # 草稿箱同步 (DRAFTS_SYNC_ENABLED) — 全量对账路径 (reconcile_drafts), 不走
        # SYNC_FOLDERS 增量链路 (_effective_custom_folders 有意 block Drafts)。
        self._sync_drafts: bool = bool(getattr(cfg, "drafts_sync_enabled", True))
        # 发件箱 (Sent) 同步 — 跟 drafts 一样: 配置优先, 留空时 probe 探测。
        # 仅当 sync_mailboxes 含"发件箱"/"已发送"时才启用 (默认 config 已含发件箱)。
        # 配置值显示名 (如 '已发送') 同样 encode 成 IMAP 原始名 — 否则 _folder_uidnext /
        # 发件箱取数把中文喂 imaplib STATUS/SELECT → 'ascii' codec can't encode 炸 (日志反复
        # 报 _folder_uidnext('已发送') failed)。probe 路径 (discover_sent_folder) 不经过这里。
        _sent_cfg = getattr(cfg, "davmail_sent_folder", "") or None
        self.sent_folder: Optional[str] = (
            encode_imap_utf7(_sent_cfg) if _sent_cfg else None
        )
        _mbs = [m.strip() for m in (getattr(cfg, "sync_mailboxes", "") or "").split(",")]
        self._sync_sent: bool = any(is_sent_mailbox(m) for m in _mbs)
        self.inbox_uidvalidity: Optional[int] = None
        # 多文件夹同步白名单 (SYNC_FOLDERS, IMAP 原始名 modified-UTF7)。空=零激活=与现状逐字节一致。
        # 排除空项 + INBOX (主路径单独管) + 去重保序; Sent 由 _sync_sent 单独管，避免双拉。
        self._custom_folders: list[str] = self._parse_custom_folders(cfg)
        self.last_op_latency_ms: Optional[int] = None

        # davmail radar 内存缓存 marker (sync_store 持久化由 NewWatcher 通过
        # sync_store.set_last_max_row_id 完成, 跟 AppleScript 模式一致路径)
        self._cached_marker: Optional[int] = None

    @staticmethod
    def _parse_custom_folders(cfg: "Config") -> list[str]:
        """SYNC_FOLDERS → 去重保序的自定义文件夹 imap_name 列表。

        **格式优先 JSON 数组**: ``["Notion","&W,mL3VOGU,KLsF9V-"]`` —— modified-UTF7 名
        **本身含逗号** (base64 段用 ``,`` 代替 ``/``, 如 对话历史记录=``&W,mL3VOGU,KLsF9V-``),
        逗号分隔会拆坏中文名。解析失败 (非 JSON / 旧 CSV 配置) 退回逗号分隔 (兼容简单 ASCII 名)。

        排除空项 + INBOX (主路径单独管, 避免双拉)。
        """
        names = parse_folder_csv_or_json(getattr(cfg, "sync_folders", "") or "")
        return [n for n in names if n.upper() != "INBOX"]

    def _effective_custom_folders(self) -> list[str]:
        """白名单去掉运行时探测到的系统文件夹 (Sent / Drafts)。

        INBOX 已在 `_parse_custom_folders` 排除; 但用户**手改** SYNC_FOLDERS 仍可能塞进
        Sent (探测名如 "Sent"/"Sent Items") → 与 SYNC_MAILBOXES 发件箱主路径双拉。CLI
        `folder enable` 已 gate 系统文件夹, 这里再兜一道 (防绕过)。
        """
        blocked = {f for f in (self.sent_folder, self.drafts_folder) if f}
        if not blocked:
            return list(self._custom_folders)
        return [f for f in self._custom_folders if f not in blocked]

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
            # 探测 Sent (仅当启用发件箱同步且未配置时, 一次性)
            if self._sync_sent and not self.sent_folder:
                self.sent_folder = discover_sent_folder(imap)
        finally:
            try:
                imap.logout()
            except Exception:
                pass

        # 大邮箱运维告警 (issue #46): 后台线程做一次性 STATUS(MESSAGES) 探测, 不占用
        # 本次 probe 的返回路径 —— 详见 _warn_if_large_mailbox docstring 为何不能放
        # probe 主流程 (会重新引入本函数上面刚修过的 crash-loop 密集 EWS 调用风险)。
        # 门控是模块级进程全局 (_claim_mailbox_size_probe, codex HIGH-2): serve-api
        # 每请求 create_backend() → probe_readiness(), 实例级门控会每请求重复起线程。
        if _claim_mailbox_size_probe():
            threading.Thread(
                target=self._warn_if_large_mailbox,
                daemon=True,
                name="davmail-mailbox-size-probe",
            ).start()

        return True, (
            f"DavMail OK (drafts={self.drafts_folder!r}, "
            f"sent={self.sent_folder!r} sync_sent={self._sync_sent}, probe=NOOP)"
        )

    def _warn_if_large_mailbox(self) -> None:
        """一次性探测 INBOX 邮件数, 超阈值提示设置 davmail.folderSizeLimit (issue #46).

        大邮箱下 davmail.properties 的 davmail.folderSizeLimit 留空时, 每次
        SELECT/EXAMINE/SEARCH 都会触发 DavMail 对整个 folder 的 EWS 全量枚举 —— 92k
        INBOX 实测单次 2.5min, 端到端邮件同步延迟可被放大到 30-60min; 设置 folderSizeLimit
        =2000 后降至约 32s。详见 docs/reference/architecture/architecture-internals.md
        「DavMail 大邮箱运维」节。

        本探测跑在独立后台线程 (由 probe_readiness 触发, daemon=True), **不阻塞启动
        关键路径**: STATUS(MESSAGES) 在同等规模 INBOX 上同样可能耗时到分钟级 (issue #45
        实测同一台 92k INBOX 单次 STATUS(MESSAGES) 分钟级), 若放进 probe_readiness 的
        主流程会重新引入 Sprint 16 曾修复过的问题 —— crash-loop 时短时间内密集打 EWS
        调用触发 Microsoft 端 throttling (该函数上方 NOOP 替代 SELECT 的注释即为此修复)。
        放后台线程后即使耗时也只影响这条告警本身的时效, 不影响 backend 就绪判定。

        MailAgent 读不到 davmail.properties (路径不固定, PoC 期 gitignored), 无法判断
        用户是否已经设置该项 —— 告警文案用"若尚未设置请设置"的提示语气, 不断言未设置。
        探测失败 (超时 / 连接失败 / 无 MESSAGES 值) 一律静默 debug 日志, 不影响任何功能;
        只在进程内探测一次 —— 门控是**模块级进程全局** ``_claim_mailbox_size_probe``
        (lock 内 check-and-set 原子 claim), 不是实例属性: serve-api 每请求新建
        ServiceContext → create_backend() → probe_readiness(), 实例级门控会导致每个
        相关请求都重复起最长 240s 的探测线程并发打 EWS (codex HIGH-2)。
        """
        threshold = 10000
        # 独立于 davmail_status_timeout_sec (那个配置管的是主循环每 ~30s 一次的关键路径
        # STATUS UIDNEXT, 默认刻意压小); 这里是一次性诊断探测, 给足余量而不新增配置项。
        probe_timeout_sec = 240
        try:
            with imap_session(self.cfg, timeout=probe_timeout_sec) as imap:
                count = _status_message_count(imap, "INBOX")
        except Exception as e:
            logger.debug(f"[davmail-backend] mailbox-size probe skipped (non-fatal): {e}")
            return
        if count is None:
            logger.debug("[davmail-backend] mailbox-size probe: no MESSAGES value returned")
            return
        if count > threshold:
            logger.warning(
                f"[davmail-backend] INBOX 邮件数约 {count} (超过 {threshold}) — 若尚未设置 "
                "davmail.properties 的 davmail.folderSizeLimit, 建议设为 2000: 留空时每次 "
                "SELECT/EXAMINE/SEARCH 都会触发 EWS 全量枚举, 大邮箱下单封新邮件端到端同步"
                "延迟可能被放大到数十分钟; 设置后实测可降至数十秒。同时建议设 "
                "log4j.logger.davmail=INFO (DEBUG 下每次 SELECT 会刷大量日志)。详见 "
                "docs/reference/architecture/architecture-internals.md「DavMail 大邮箱运维」节。"
            )

    # =========================================================================
    # 正向 sync — 单封抓取 (内部 typed helper; Protocol 面 = fetch_email_content_by_id)
    # =========================================================================

    def fetch_email_by_id(
        self, internal_id: int, *, mailbox: Optional[str] = None, update_uid: bool = True
    ) -> Optional[EmailContent]:
        """查 SyncStore 拿 (uidvalidity, uid) 或 message_id, 然后 IMAP UID FETCH BODY[].

        修复 (review):
        - CRITICAL #3: UIDVALIDITY 从 SELECT 响应读 (untagged), 不调 STATUS 同 mailbox
        - MEDIUM: imap_uid > 0 才走快路径, ``-1`` (backfill 标记的 permanent miss) 直接
          fallback message_id 反查
        - MEDIUM: lookup_uid_by_message_id 命中后回写 sync_store 让下次走快路径

        ``update_uid=False`` (compose_plan dry-run 懒自愈): message_id fallback 命中后
        跳过 ``_update_sync_store_uid`` 回写 — dry-run 取件解析照旧, 但不产生 SQLite 侧写。
        """
        record = self.sync_store.get(internal_id)
        if not record:
            logger.warning(f"[davmail-backend] internal_id={internal_id} not in sync_store")
            return None

        imap_box = self._resolve_imap_box(mailbox or record.get("mailbox"))
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
                # quote_mailbox: 含空格的名 (probe "Sent Items" / 编码后的自定义名如
                # "&mHl27g- &VGhipQ-") 不 quote 会被 imaplib 拆成多 atom → SELECT 失败;
                # 简单名 quote 无害 (与 _fetch_folder_headers 的既有约定一致)。
                typ, _ = imap.select(quote_mailbox(imap_box), readonly=True)
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
                    # 命中后回写 sync_store 让下次走快路径 (review MEDIUM)。
                    # update_uid=False (compose_plan dry-run 懒自愈) 跳过回写 — 守住
                    # dry-run「无写」契约 (codex 批次3 finding)。
                    if update_uid:
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

                # 命中新 UID, 回写 sync_store, 再 fetch。update_uid=False (dry-run 懒自愈)
                # 跳过回写, 仅本次取件解析 (codex 批次3 finding)。
                if update_uid:
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
        imap_box = self._resolve_imap_box(mailbox)
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(quote_mailbox(imap_box), readonly=True)
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
        mailbox: Optional[str] = None,
    ) -> bool:
        """标记已读 (Protocol 面为 str message_id fallback; 内部也容忍 int internal_id).

        mailbox 位置可传 — 签名统一决策 (e1-contract-inventory.md §3 ①): handlers /
        reverse_sync 的 fallback 调用点都是三位置参数, keyword-only 会 TypeError.
        """
        flag = "(\\Seen)"
        op = "+FLAGS" if read else "-FLAGS"
        return self._store_flag(identifier, op, flag, mailbox)

    def set_flag(
        self,
        identifier: Union[int, str],
        flagged: bool = True,
        mailbox: Optional[str] = None,
    ) -> bool:
        """标记/取消旗标. 同 ``mark_as_read`` 签名约定 (str 面 + 容忍 int)."""
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
        imap_box = self._resolve_imap_box(mailbox or record.get("mailbox"))
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                # quote_mailbox: flag 写回同样要 SELECT 对 folder; 中文自定义文件夹的
                # flag 写回 (真机 internal_id=1000004131) 与拉正文同样会撞编码炸。
                typ, _ = imap.select(quote_mailbox(imap_box), readonly=False)
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
            mime_bytes = self._build_mime(draft)
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
                # APPENDUID extension 返回 (uidvalidity, uid), 解析它
                pair = self._parse_appenduid_pair(data)
                appended_uv, appended_uid = pair if pair else (None, None)
                # MIME Message-ID (去尖括号) — 草稿即时落库的 merge key
                message_id: Optional[str] = None
                try:
                    from email.parser import BytesHeaderParser
                    raw_mid = BytesHeaderParser().parsebytes(mime_bytes).get("Message-ID")
                    if raw_mid:
                        message_id = raw_mid.strip().strip("<>") or None
                except Exception:
                    pass
                logger.info(
                    f"[davmail-backend] append_draft → {folder!r} "
                    f"uid={appended_uid} latency={self.last_op_latency_ms}ms"
                )
                return DraftAppendResult(
                    success=True, drafts_folder=folder, appended_uid=appended_uid,
                    method="imap_append",
                    message_id=message_id, appended_uidvalidity=appended_uv,
                )
        except Exception as e:
            logger.error(f"[davmail-backend] append_draft failed: {e}")
            return DraftAppendResult(
                success=False, drafts_folder=folder, error=f"append exception: {e}",
            )

    # =========================================================================
    # 真实发送 — SMTP (email send 命令 / 前端发送按钮调)
    # =========================================================================

    def send_email(self, draft: DraftRequest) -> SendResult:
        """SMTP 真实发送 (复用 _build_mime + sender.smtp_send). 失败返回 success=False 不抛."""
        try:
            mime_bytes = self._build_mime(draft)
        except Exception as e:
            logger.error(f"[davmail-backend] send_email MIME build failed: {e}")
            return SendResult(success=False, error=f"MIME build failed: {e}")
        from src.mail.backend.sender import smtp_send

        return smtp_send(
            self.cfg, mime_bytes, method="smtp_davmail",
            archive_sent=getattr(self.cfg, "davmail_archive_sent", False),
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

        issue #47: 先过 ``_normalize_message_id`` —— 写入侧已归一化, 这里再来一次是
        为了兼容修复前存进 ``email_metadata.message_id`` 的脏值 (encoded-word + 折行),
        免掉一次数据迁移. 干净值上是 no-op.
        """
        if not message_id:
            return None
        mid_clean = _normalize_message_id(message_id) or message_id.strip()
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
        message_id = _normalize_message_id(msg.get("Message-ID"))
        # RFC 2047 decode — DavMail IMAP 返回 raw encoded-word, AppleScript 返回 decoded 字符串
        subject = _decode_mime_header(msg.get("Subject"))
        sender_full = _decode_mime_header(msg.get("From"))
        sender = _extract_first_email(sender_full) or sender_full
        date_str = msg.get("Date") or ""
        # RFC 2047 decode 同 Subject/From: 长 Message-ID 的 References/In-Reply-To
        # 可能是 encoded-word, 不解码会取到碎片致线程断裂 (fix/reply-thread-rfc2047).
        thread_id = _thread_id_from_headers(
            msg.get("References"), msg.get("In-Reply-To"), message_id
        )

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
                            content = decode_mime_bytes(payload, part.get_content_charset())
                            break
                    except Exception:
                        pass
        else:
            try:
                payload = msg.get_payload(decode=True)
                if payload:
                    content = decode_mime_bytes(payload, msg.get_content_charset())
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

    def _build_mime(self, draft: DraftRequest) -> bytes:
        """Build MIME for IMAP APPEND / SMTP send (reply / reply-all / forward / new).

        委托 ``sender.build_outgoing_mime`` 单一来源 — forward 引用块 + 附件 multipart/mixed
        + threading 头逻辑都在那. 保留 ``_build_reply_mime`` 别名供 append_draft /
        imap_folder_reader 等现有调用点 (zero 改动).
        """
        from src.mail.backend.sender import build_outgoing_mime

        return build_outgoing_mime(self.cfg, draft)

    # 向后兼容别名: append_draft / imap_folder_reader 仍调 _build_reply_mime.
    _build_reply_mime = _build_mime

    # =========================================================================
    # IMailBackend 正式接口 — 邮件抓取 / flag 写 (E1 收口: 原 arm-compat 面
    # 正式化为 Protocol 方法, 见 e1-contract-inventory.md §1.1)
    # =========================================================================

    def fetch_email_content_by_id(
        self, internal_id: int, mailbox: Optional[str] = None, *, update_uid: bool = True
    ) -> Optional[dict]:
        """单封抓取 (legacy dict) — 委托内部 typed fetch_email_by_id.

        ``update_uid=False`` (compose_plan dry-run 懒自愈): message_id fallback 命中后
        **不回写** imap_uid/uidvalidity 元数据, 守住 dry-run「无写」契约 (codex 批次3
        finding)。默认 True 时既有调用方 (正向 sync / retry) 逐字节不变。
        """
        ec = self.fetch_email_by_id(internal_id, mailbox=mailbox, update_uid=update_uid)
        return ec.to_legacy_dict() if ec else None

    def fetch_email_by_message_id(
        self, message_id: str, mailbox: Optional[str] = None
    ) -> Optional[dict]:
        """通过 message_id IMAP SEARCH HEADER 反查 + FETCH. legacy dict 返回."""
        if not message_id:
            return None
        imap_box = self._resolve_imap_box(mailbox)
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                typ, _ = imap.select(quote_mailbox(imap_box), readonly=True)
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
        """按位置抓最近 N 封 (legacy dict) — IMAP UID SEARCH 末尾 N 封, 委托 fetch_recent."""
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
        """按 internal_id 标记已读 (主路径)."""
        return self.mark_as_read(internal_id, read, mailbox=mailbox)

    def set_flag_by_id(
        self, internal_id: int, flagged: bool = True, mailbox: Optional[str] = None
    ) -> bool:
        """按 internal_id 设置/取消旗标 (主路径)."""
        return self.set_flag(internal_id, flagged, mailbox=mailbox)

    # =========================================================================
    # IMailBackend 正式接口 — 雷达面 (原 SQLiteRadar 形状; marker = INBOX UIDNEXT)
    # =========================================================================

    def is_available(self) -> bool:
        """雷达可用性 — TCP probe IMAP 端口."""
        ok, _ = probe_tcp(self.host, self.imap_port, timeout=2.0)
        return ok

    def get_current_max_row_id(self) -> int:
        """当前 marker — 返回 INBOX IMAP UIDNEXT.

        DavMail marker = uidnext (int). uidvalidity 内部缓存在 self.inbox_uidvalidity,
        变化时 check_for_changes 会 log warning. 主循环用 uidnext 作为
        SyncStore.last_max_row_id 持久化.

        超时/失败 raise MarkerUnavailableError — IMAP UIDNEXT 恒 >= 1, 修复前失败
        return 0 会被首次 baseline 持久化 → 下轮 get_new_emails(0) 对 INBOX 发
        `UID 1:*` 全量重刷 (7万+ INBOX 的 STATUS 实测慢过 30s, task 07-14 L3)。
        timeout 可配 DAVMAIL_STATUS_TIMEOUT_SEC (默认 30, 大邮箱调 90)。
        """
        timeout = int(getattr(self.cfg, "davmail_status_timeout_sec", 30))
        try:
            with imap_session(self.cfg, timeout=timeout) as imap:
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
            raise MarkerUnavailableError(
                f"INBOX STATUS(UIDNEXT) failed (timeout={timeout}s): {e}"
            ) from e
        raise MarkerUnavailableError(
            f"INBOX STATUS(UIDNEXT) returned no usable data (typ={typ!r})"
        )

    def _resolve_imap_box(self, mailbox: Optional[str]) -> str:
        """中文 mailbox → IMAP folder 原始名 (modified-UTF7), 优先用 probe 探测到的实际名。

        _mailbox_to_imap 是静态映射 (发件箱→"Sent Items", 草稿→"Drafts"), 但不同
        服务器 Sent/Drafts 实际名可能不同 (如 "已发送邮件")。probe 探测到 self.sent_folder
        / self.drafts_folder 后, 这里优先用探测值, 保证 fetch/flag/read 操作 SELECT 对
        folder (否则发件箱邮件取不到全文)。

        🔴 自定义文件夹 fallthrough: ``_mailbox_to_imap`` 未命中映射时**原样返回显示名**
        (含中文, 如 "DMS固件发布")。直接 SELECT 中文名 → imaplib 内部按 ASCII 编码 args
        → ``'ascii' codec can't encode`` 炸 (真机 internal_id=1000004131 fetch/flag 都炸)。
        这里把 fallthrough 的自定义名用 ``encode_imap_utf7`` 编回 IMAP 原始名 (modified-UTF7,
        纯 ASCII), 与正向 sync 的 ``_effective_custom_folders`` (白名单存的就是原始名) +
        ``mail_write._resolve_folder_imap`` 语义对齐。

        ⚠️ **严禁对 probe 值 / 已命中映射的标准名 encode**: probe 的 self.sent_folder /
        self.drafts_folder 来自 IMAP LIST, **已是编码后的原始名**; 对其二次 encode 会把
        ``&`` 错改写为 ``&-`` (如 ``DMS&VvpO9lPRXgM-`` → ``DMS&-VvpO9lPRXgM-``) → SELECT 失败。
        故 probe/映射两分支提前 return, 不经过下面的 encode。纯 ASCII 自定义名 encode 是
        恒等 (仅转义 ``&``), 故对 ``Notion``/``Jira`` 等也安全。
        """
        if is_sent_mailbox(mailbox) and self.sent_folder:
            return self.sent_folder
        if is_drafts_mailbox(mailbox) and self.drafts_folder:
            return self.drafts_folder
        mapped = _mailbox_to_imap(mailbox)
        # fallthrough (未命中映射 → 原样返回显示名) 才 encode; 命中映射的标准 IMAP 名
        # (INBOX / "Sent Items" / "Drafts" 等) 原样透传, 不二次编码。
        if mapped == mailbox and mapped not in (None, "", "INBOX"):
            return encode_imap_utf7(mapped)
        return mapped

    def _folder_uidnext(self, imap_folder: str) -> int:
        """STATUS <folder> (UIDNEXT) — 给发件箱变化检测用 (INBOX 走 get_current_max_row_id)."""
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, data = imap.status(quote_mailbox(imap_folder), "(UIDNEXT)")
                if typ == "OK" and data:
                    uidnext = self._extract_status_value(data[0], "UIDNEXT")
                    if uidnext:
                        return int(uidnext)
        except Exception as e:
            logger.warning(
                f"[davmail-backend] _folder_uidnext({imap_folder!r}) failed: {e}"
            )
        return 0

    def check_for_changes(
        self, last_max_row_id: int
    ) -> tuple[bool, int, int]:
        """自 marker 以来是否有新邮件 — STATUS UIDNEXT 比对.

        返回的 marker 始终是 INBOX uidnext (持久化为 last_max_row_id, get_new_emails
        的 INBOX 增量用它)。发件箱用独立 UID 空间, 其游标在 get_new_emails 内部从
        SQLite 派生, 这里只额外探测发件箱 UIDNEXT 是否前进以触发 has_new。

        Returns: (has_new, inbox_uidnext, estimated_new_count)
        """
        try:
            current = self.get_current_max_row_id()
        except MarkerUnavailableError as e:
            # fail-safe: 本轮按「无新邮件」跳过, marker 不动, 下轮 IMAP 恢复自愈;
            # 在此吞掉不外冒 → 不污染 _poll_cycle 的 consecutive_errors 健康计数
            # (STATUS 偶发慢不等于服务不健康)。
            logger.warning(f"[davmail-backend] check_for_changes skipped this cycle: {e}")
            return (False, last_max_row_id, 0)
        inbox_new = max(0, current - int(last_max_row_id or 0))
        sent_new = 0
        if self._sync_sent and self.sent_folder:
            sent_uidnext = self._folder_uidnext(self.sent_folder)
            if sent_uidnext > 0:
                # sent_uidnext = 下一个将分配的 UID; marker = 已导入最大 UID。
                # uidnext > marker+1 说明 Sent 有未导入的新发件。首次 marker=0 →
                # 必触发 (走日期下限回填)。marker 同样按 uidnext 钳制, 否则幽灵高 UID
                # 会让估算恒为 0 → 纯发件变化 (无 INBOX 变化) 时漏触发。
                sent_marker = self._max_sent_imap_uid(below=sent_uidnext)
                sent_new = max(0, sent_uidnext - (sent_marker + 1))
        # --- 自定义文件夹 (SYNC_FOLDERS): STATUS(UIDNEXT UIDVALIDITY) 轻量探测变化 ---
        # 仅用于触发 has_new; 真正取数 + marker 推进在 get_new_emails 内。每文件夹独立 try,
        # 一个失败 (重命名/删除) 不影响 INBOX/其它。空白名单时整段跳过 = 零激活。
        custom_new = 0
        for imap_name in self._effective_custom_folders():
            try:
                uidnext, uv = self._folder_status(imap_name)
                if uidnext <= 0:
                    continue
                label = decode_imap_utf7(imap_name)
                stored_uv = self._get_folder_uidvalidity(imap_name)
                if stored_uv is not None and uv and uv != stored_uv:
                    # UIDVALIDITY 变化 → 该文件夹需全量重拉 → 必触发。
                    custom_new += 1
                    continue
                marker = self._max_folder_imap_uid(label)
                custom_new += max(0, uidnext - (marker + 1))
            except Exception as e:
                logger.warning(
                    f"[davmail-backend] custom folder {imap_name!r} change-probe "
                    f"failed (others unaffected): {e}"
                )
        return (
            inbox_new > 0 or sent_new > 0 or custom_new > 0,
            current,
            inbox_new + sent_new + custom_new,
        )

    def get_new_emails(self, since_row_id: int) -> list[dict]:
        """取 marker 之后的新邮件 — 多 folder UID SEARCH + BATCH FETCH.

        davmail mode 关键: 每条邮件通过 ``sync_store.allocate_davmail_internal_id()``
        分配独立 internal_id (>= 1_000_000_000), **不再**复用 IMAP UID 作 internal_id —
        因为 IMAP UID 通常是几千~几十万的小数字, 跟 Mail.app ROWID 空间冲突. 同时填好
        ``imap_uid`` / ``imap_uidvalidity`` / ``backend_origin='davmail'`` / ``mailbox``
        字段, 让上层 ``new_watcher._poll_cycle`` 直接透传到 ``sync_store.save_email`` 即可
        (review CRITICAL #2 修复).

        ## 多 folder (收件箱 + 发件箱)

        INBOX 用 ``since_row_id`` (= 持久化的 INBOX uidnext marker) 做 ``UID >`` 增量。
        Sent (发件箱) 的 IMAP UID 空间和 INBOX **独立**, 不能复用 since_row_id, 故 marker
        从 SQLite 派生 (``MAX(imap_uid) WHERE mailbox='发件箱'``); 首次 (无 davmail-origin
        发件箱行) 退化为 ``SENTSINCE <SYNC_START_DATE>`` 日期下限回填。重复拉到的存量
        AppleScript 发件邮件由 ``_save_email_v3`` 的 cross-backend merge protection 兜底
        (按 message_id merge, 不建重复行/重复 Notion 页), 故首次回填安全。
        """
        out: list[dict] = []
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                # --- INBOX (主路径, since_row_id = INBOX uidnext marker) ---
                out.extend(
                    self._fetch_new_in_folder(
                        imap, "INBOX", INBOX_LABEL,
                        ("UID", f"{int(since_row_id) + 1}:*"),
                        track_inbox_uidvalidity=True,
                    )
                )
                # --- 发件箱 (Sent) — 独立 UID 空间, marker 从 SQLite 派生 ---
                # 单独 try: Sent 失败绝不能影响 INBOX 同步 (主路径)。
                if self._sync_sent and self.sent_folder:
                    try:
                        out.extend(
                            self._fetch_new_in_folder(
                                imap, self.sent_folder, SENT_LABEL,
                                self._sent_search_criteria(),
                                track_inbox_uidvalidity=False,
                            )
                        )
                    except Exception as e:
                        logger.error(
                            f"[davmail-backend] sent folder sync failed "
                            f"(inbox unaffected): {e}"
                        )
                # --- 自定义文件夹白名单 (SYNC_FOLDERS) ---
                # 每个文件夹独立 UID 空间; marker 从 SQLite 派生 (复用 Sent 模式), per-folder
                # UIDVALIDITY 存 sync_state KV → 变化时全量重拉。每文件夹独立 try (一个失败不
                # 影响其它 + INBOX 主路径)。max_messages 截断防大文件夹灌爆。空白名单时整段
                # 跳过 = 与现状逐字节一致 (隔离不变量)。
                for imap_name in self._effective_custom_folders():
                    try:
                        out.extend(self._fetch_custom_folder(imap, imap_name))
                    except Exception as e:
                        logger.error(
                            f"[davmail-backend] custom folder {imap_name!r} sync "
                            f"failed (others + inbox unaffected): {e}"
                        )
            return out
        except Exception as e:
            # PR #23 (credit @KevinWangQQ): 顶层失败 (连接/INBOX SEARCH 超时) 必须
            # re-raise — 吞掉返空会让 _poll_cycle 误当"空成功"推进游标, 窗口内邮件
            # 永久跳过。Sent/自定义文件夹的 inner try 隔离语义不变。
            logger.error(f"[davmail-backend] get_new_emails failed: {e}")
            raise

    def _fetch_custom_folder(self, imap, imap_name: str) -> list[dict]:
        """取一个自定义文件夹的新邮件。marker 派生 + UIDVALIDITY 变化检测 + 上限截断。

        criteria 决策 (SELECT 后拿到真实 UIDVALIDITY):
          - stored_uv 存在且 != current_uv → UIDVALIDITY 变了 → 全量重拉 (SINCE 窗口下限)；
          - 否则 marker>0 → UID>marker 增量；marker==0 (首次) → SINCE 窗口下限回填。
        message_id merge protection 兜底重拉去重 (与 Sent 首次回填同理)。
        """
        label = decode_imap_utf7(imap_name)
        marker = self._max_folder_imap_uid(label)
        stored_uv = self._get_folder_uidvalidity(imap_name)
        max_messages = int(getattr(self.cfg, "folder_sync_max_messages", 0) or 0)
        return self._fetch_new_in_folder(
            imap, imap_name, label,
            search_criteria=None,                # custom 模式: criteria 在 SELECT 后内部决策
            track_inbox_uidvalidity=False,
            folder_marker=marker,
            stored_uidvalidity=stored_uv,
            date_floor=self._folder_date_floor(),
            max_messages=max_messages,
            persist_uidvalidity_for=imap_name,
        )

    def _fetch_new_in_folder(
        self,
        imap,
        imap_folder: str,
        mailbox_label: str,
        search_criteria: Optional[tuple[str, str]] = None,
        *,
        track_inbox_uidvalidity: bool,
        max_messages: Optional[int] = None,
        folder_marker: Optional[int] = None,
        stored_uidvalidity: Optional[int] = None,
        date_floor: Optional[str] = None,
        persist_uidvalidity_for: Optional[str] = None,
    ) -> list[dict]:
        """SELECT 一个 IMAP folder → UID SEARCH → BATCH FETCH headers → 分配 internal_id +
        打 mailbox/backend_origin 标签。get_new_emails 的单 folder 原语。

        两种模式:
        - **固定 criteria** (INBOX/Sent): 传 ``search_criteria=(key, arg)``，直接用。
        - **自定义文件夹** (``search_criteria=None``): SELECT 拿真实 UIDVALIDITY 后内部决策——
          stored_uv 存在且变了→全量重拉 (SINCE date_floor)；marker>0→UID 增量；否则首次 SINCE 回填。

        ``max_messages`` (>0): SEARCH 超限时只取**最新** N 封 (UID 升序末尾 N)。
        ``persist_uidvalidity_for`` (imap_name): 非空时把本次 SELECT 读到的 UIDVALIDITY 存 KV
        (无论是否取到新邮件，确保游标基线落库)。
        """
        # mailbox 名必须 quote (含空格如 "Sent Items"/"Unsent Messages" 不 quote 会被
        # imaplib 拆成多 atom → SELECT 失败)。简单名 quote 无害 (实测)。
        typ, _ = imap.select(quote_mailbox(imap_folder), readonly=True)
        if typ != "OK":
            logger.warning(f"[davmail-backend] SELECT {imap_folder!r} failed: {typ}")
            return []
        # 从 SELECT 响应读 UIDVALIDITY (untagged response), 避免协议违反
        # (RFC 3501 §6.3.10: STATUS 不能跟在 SELECT 同 mailbox 之后).
        uv = _read_uidvalidity_from_select(imap)
        if uv and track_inbox_uidvalidity:
            self.inbox_uidvalidity = uv

        def _persist_uv() -> None:
            if persist_uidvalidity_for and uv:
                self._set_folder_uidvalidity(persist_uidvalidity_for, uv)

        # 自定义文件夹模式: 据真实 UIDVALIDITY 决策 criteria
        if search_criteria is None:
            if stored_uidvalidity is not None and uv and uv != stored_uidvalidity:
                logger.info(
                    f"[davmail-backend] {mailbox_label!r} UIDVALIDITY changed "
                    f"{stored_uidvalidity}→{uv} → full re-pull (SINCE {date_floor})"
                )
                search_criteria = ("SINCE", date_floor or self._imap_date_floor())
            elif folder_marker and folder_marker > 0:
                search_criteria = ("UID", f"{folder_marker + 1}:*")
            else:
                search_criteria = ("SINCE", date_floor or self._imap_date_floor())

        key, arg = search_criteria
        typ, data = imap.uid("search", None, key, arg)
        if typ != "OK" or not data or not data[0]:
            _persist_uv()
            return []
        uids = data[0].split()
        if not uids:
            _persist_uv()
            return []
        # max_messages 截断: UID SEARCH 返回升序, 取末尾 N (最新) 防大文件夹首拉灌爆。
        if max_messages and max_messages > 0 and len(uids) > max_messages:
            logger.info(
                f"[davmail-backend] {mailbox_label!r}: {len(uids)} matched, capped to "
                f"newest {max_messages} (FOLDER_SYNC_MAX_MESSAGES)"
            )
            uids = uids[-max_messages:]
        uid_seq = b",".join(uids).decode()
        typ, data = imap.uid(
            "fetch", uid_seq,
            "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS "
            "(MESSAGE-ID SUBJECT FROM DATE REFERENCES IN-REPLY-TO)])",
        )
        if typ != "OK" or not data:
            _persist_uv()
            return []
        # 每封邮件的 imap_uidvalidity = 本 folder 的 uv (不再用 inbox_uidvalidity —
        # 修复 Sent/自定义文件夹 uidvalidity 张冠李戴的潜在问题)。
        parsed = self._parse_batch_headers(data, uidvalidity=uv)
        out: list[dict] = []
        for item in parsed:
            try:
                item["internal_id"] = self.sync_store.allocate_davmail_internal_id()
            except Exception as e:
                logger.error(
                    f"[davmail-backend] allocate_davmail_internal_id failed for "
                    f"imap_uid={item.get('imap_uid')} folder={imap_folder!r}: {e}"
                )
                continue
            item["backend_origin"] = "davmail"
            item["mailbox"] = mailbox_label
            out.append(item)
        if len(out) != len(uids):
            logger.warning(
                f"[davmail-backend] _fetch_new_in_folder({mailbox_label}): parsed "
                f"{len(out)} from {len(uids)} UIDs (missing {len(uids) - len(out)})"
            )
        _persist_uv()
        return out

    # ---- 草稿箱同步 (DRAFTS_SYNC_ENABLED): 全量对账, 非增量 ----

    DRAFTS_MAILBOX_LABEL = DRAFTS_LABEL
    _DRAFTS_UIDNEXT_KEY = "drafts_uidnext"

    def reconcile_drafts(self) -> tuple[list[dict], list[int]]:
        """草稿箱对账 — 返回 (新草稿 email dicts, 已消失草稿的 internal_ids)。

        草稿箱区别于 INBOX/Sent 的"只增"语义: 草稿会被编辑 (Exchange 端 = 新 UID 替换
        旧 UID)、发送 (从 Drafts 消失)、删除。增量 UID marker 只见新增不见消失 → 数量
        只增不减, 必须全量 UID 对账 (草稿箱通常 < 几十封, UID SEARCH ALL 一个
        round-trip 很便宜)。

        轻量化: 先 STATUS (MESSAGES UIDNEXT UIDVALIDITY) 与本地快照比对 (COUNT +
        sync_state KV), 三者都没变 → 零 SELECT 直接返回空 — 静止态每 cycle 只花一次
        STATUS, 与自定义文件夹 change-probe 同级。UIDVALIDITY 变化 → 本地 davmail
        草稿行全删重拉 (UID 空间作废)。

        已知限制: OWA/Outlook 端**编辑**老草稿 (Message-ID 不变) 时, save_email 的
        cross-backend merge 会复用本地行并更新 imap_uid, 但不重置 sync_status →
        正文/标题停留在首次同步版本。本 app compose 的"保存草稿"每次 APPEND 新
        Message-ID, 不受影响。

        Caller (new_watcher._reconcile_drafts): to_add 走 save_email(pending) 进主
        链路 fetch body; to_delete 走 delete_email_full + sync_store.delete。
        """
        if not (self._sync_drafts and self.drafts_folder):
            return [], []
        label = self.DRAFTS_MAILBOX_LABEL
        local = self._folder_imap_uid_map(label)
        stored_uv = self._get_folder_uidvalidity(self.drafts_folder)
        stored_uidnext = self._get_drafts_uidnext()
        to_delete: list[int] = []
        to_add: list[dict] = []
        try:
            with imap_session(self.cfg, timeout=60) as imap:
                # STATUS 必须先于 SELECT 同 mailbox (RFC 3501 §6.3.10)
                typ, data = imap.status(
                    quote_mailbox(self.drafts_folder),
                    "(MESSAGES UIDNEXT UIDVALIDITY)",
                )
                if typ != "OK" or not data:
                    return [], []
                messages_s = self._extract_status_value(data[0], "MESSAGES")
                uidnext_s = self._extract_status_value(data[0], "UIDNEXT")
                uv_s = self._extract_status_value(data[0], "UIDVALIDITY")
                if messages_s is None or not uidnext_s:
                    return [], []
                messages, uidnext = int(messages_s), int(uidnext_s)
                uv = int(uv_s) if uv_s else None
                if (
                    messages == len(local)
                    and stored_uidnext is not None
                    and uidnext == stored_uidnext
                    and (uv is None or stored_uv is None or uv == stored_uv)
                ):
                    return [], []  # 静止态: 远端与本地快照一致, 零 SELECT

                typ, _ = imap.select(quote_mailbox(self.drafts_folder), readonly=True)
                if typ != "OK":
                    return [], []
                current_uv = _read_uidvalidity_from_select(imap) or uv
                if stored_uv is not None and current_uv and current_uv != stored_uv:
                    # UIDVALIDITY 变化 → 本地 davmail 草稿行 UID 全部作废, 全删重拉
                    logger.info(
                        f"[davmail-backend] drafts UIDVALIDITY changed "
                        f"{stored_uv}→{current_uv} → full rebuild"
                    )
                    to_delete.extend(local.values())
                    local = {}
                typ, data = imap.uid("search", None, "ALL")
                if typ != "OK":
                    return [], []
                remote_uids = {
                    int(u) for u in (data[0].split() if data and data[0] else [])
                }
                local_uids = set(local.keys())
                to_delete.extend(local[u] for u in sorted(local_uids - remote_uids))
                new_uids = sorted(remote_uids - local_uids)
                if new_uids:
                    uid_csv = ",".join(str(u) for u in new_uids)
                    # _fetch_new_in_folder 内部会再 SELECT 同 folder (幂等, 同
                    # session 开销可忽略) + persist uv KV
                    to_add = self._fetch_new_in_folder(
                        imap, self.drafts_folder, label,
                        ("UID", uid_csv),
                        track_inbox_uidvalidity=False,
                        persist_uidvalidity_for=self.drafts_folder,
                    )
                elif current_uv:
                    self._set_folder_uidvalidity(self.drafts_folder, current_uv)
                # 快照推进 (uidnext)。对账期间新 APPEND 的 race 由下 cycle STATUS
                # 差异自愈 (messages/uidnext 再变 → 再对账)。
                self._set_drafts_uidnext(uidnext)
            # 草稿线程 linkage (D1 Bug A): 把 _parse_batch_headers 已解析的
            # in_reply_to_raw/references_raw 持久化进 draft_* 列 (经 new_watcher
            # save_email 落库), 并按 in_reply_to 反查原邮件行回填
            # draft_source_internal_id — 覆盖 webhook _create_draft_via_imap 等
            # 一切不走 _mirror_draft_locally 的草稿来源, 统一自愈。RFC 2047 decode
            # 同 thread_id 口径 (干净 ASCII 是 no-op), 防 encoded-word 链存进列。
            # ⚠️ 必须先于下方同 Message-ID 分类 (codex finding 2): 编辑草稿走
            # _update_draft_row_uid in-place 更新不进 save_email, linkage 后解析
            # 会被整个丢掉 (NULL 永不愈合 / 头变化则 stale)。
            for item in to_add:
                irt = _decode_mime_header(item.get("in_reply_to_raw")).strip().strip("<>")
                if not irt:
                    continue
                item["draft_in_reply_to"] = irt
                refs = " ".join(_decode_mime_header(item.get("references_raw")).split())
                item["draft_references"] = refs or None
                item["draft_source_internal_id"] = self._lookup_internal_id_by_message_id(irt)
            # 同 Message-ID 替换 (OWA/Outlook 编辑草稿 = 新 UID 同 Message-ID):
            # 不能走 to_add+to_delete — save_email 的 cross-backend merge guard
            # 会把 to_add 合并进旧行不建新行, 随后 to_delete 删旧行 → 刚 merge 的
            # 行被删 (草稿闪没 + internal_id 漂移); 旧行在 grace 内则保留 synced
            # + 旧正文永久陈旧 (codex review HIGH)。拆成 to_update: 直接更新旧行
            # UID/UIDVALIDITY + 置 pending 让 watcher 重 fetch 新正文; linkage
            # (thread_id + draft_* 三列, 上方已解析进 item) 一并原子刷新。
            if to_add:
                mid_to_iid = self._draft_message_id_map(label)
                if mid_to_iid:
                    kept_add: list[dict] = []
                    delete_set = set(to_delete)
                    for item in to_add:
                        old_iid = mid_to_iid.get(item.get("message_id") or "")
                        if old_iid:
                            self._update_draft_row_uid(old_iid, item)
                            delete_set.discard(old_iid)
                        else:
                            kept_add.append(item)
                    if len(kept_add) != len(to_add):
                        logger.info(
                            f"[davmail-backend] drafts reconcile: "
                            f"{len(to_add) - len(kept_add)} edited in-place (same Message-ID)"
                        )
                        to_add = kept_add
                        to_delete = [i for i in to_delete if i in delete_set]
            # Grace window: compose_draft 即时落库的新行, davmail 端 folder 缓存
            # 可能尚未反映 (SELECT 后 SEARCH 仍 stale 数分钟) → 远端"看不到"该 UID
            # 会被误判已删除。创建 < 120s 的行不删, 留给后续 cycle 确认
            # (真删除只是晚 ~2min 清理; 误删则是数据丢失, 宁可晚)。
            to_delete = self._filter_recent_rows(to_delete, grace_sec=120)
            if to_add or to_delete:
                logger.info(
                    f"[davmail-backend] drafts reconcile: +{len(to_add)} "
                    f"-{len(to_delete)} (remote={messages})"
                )
            return to_add, to_delete
        except Exception as e:
            logger.error(f"[davmail-backend] reconcile_drafts failed: {e}")
            return [], []

    def _folder_imap_uid_map(self, mailbox_label: str) -> dict[int, int]:
        """SQLite 里某 mailbox 的 {imap_uid: internal_id} (davmail-origin)。草稿对账用。"""
        try:
            conn = sqlite3.connect(str(self.sync_store.db_path), timeout=10.0)
            try:
                rows = conn.execute(
                    "SELECT imap_uid, internal_id FROM email_metadata "
                    "WHERE mailbox = ? AND backend_origin = 'davmail' "
                    "AND imap_uid IS NOT NULL",
                    (mailbox_label,),
                ).fetchall()
                return {int(r[0]): int(r[1]) for r in rows}
            finally:
                conn.close()
        except Exception as e:
            logger.warning(
                f"[davmail-backend] _folder_imap_uid_map({mailbox_label!r}) failed: {e}"
            )
            return {}

    def _draft_message_id_map(self, mailbox_label: str) -> dict[str, int]:
        """本地草稿行 {message_id: internal_id} (davmail-origin)。同 Message-ID 编辑检测用。"""
        try:
            conn = sqlite3.connect(str(self.sync_store.db_path), timeout=10.0)
            try:
                rows = conn.execute(
                    "SELECT message_id, internal_id FROM email_metadata "
                    "WHERE mailbox = ? AND backend_origin = 'davmail' "
                    "AND message_id IS NOT NULL AND message_id != ''",
                    (mailbox_label,),
                ).fetchall()
                return {str(r[0]): int(r[1]) for r in rows}
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"[davmail-backend] _draft_message_id_map failed: {e}")
            return {}

    def _lookup_internal_id_by_message_id(self, message_id: str) -> Optional[int]:
        """按 message_id 反查 email_metadata 原行 internal_id (草稿 linkage 回填用)。

        查不到 / 返回形状异常 (测试里 sync_store 常是 MagicMock) → None, 列留空。
        """
        try:
            record = self.sync_store.get_by_message_id(message_id)
            if isinstance(record, dict):
                iid = record.get("internal_id")
                if isinstance(iid, int) and not isinstance(iid, bool):
                    return iid
        except Exception as e:
            logger.debug(
                f"[davmail-backend] linkage source lookup failed mid={message_id[:40]!r}: {e}"
            )
        return None

    def _update_draft_row_uid(self, internal_id: int, item: dict) -> None:
        """草稿编辑 in-place 更新: 新 UID/UIDVALIDITY/subject + 置 pending 重 fetch 正文。

        codex finding 2: thread_id + draft_* 三列随 UID 一并原子刷新 —— 值取自新
        MIME 头 (reconcile 已解析进 item; 缺失键 = 新头没有该值 → **显式清 NULL**,
        不留 stale)。语义 = 与"删旧行 + save_email 新行"等价的 linkage 结果, 只是
        保住 internal_id 不漂移。
        """
        try:
            conn = sqlite3.connect(str(self.sync_store.db_path), timeout=10.0)
            try:
                conn.execute(
                    "UPDATE email_metadata SET imap_uid = ?, "
                    "imap_uidvalidity = COALESCE(?, imap_uidvalidity), "
                    "subject = COALESCE(NULLIF(?, ''), subject), "
                    "thread_id = ?, draft_in_reply_to = ?, "
                    "draft_references = ?, draft_source_internal_id = ?, "
                    "sync_status = 'pending', sync_error = NULL, "
                    "next_retry_at = NULL, updated_at = ? "
                    "WHERE internal_id = ?",
                    (
                        item.get("imap_uid"),
                        item.get("imap_uidvalidity"),
                        item.get("subject") or "",
                        item.get("thread_id"),
                        item.get("draft_in_reply_to"),
                        item.get("draft_references"),
                        item.get("draft_source_internal_id"),
                        time.time(),
                        internal_id,
                    ),
                )
                conn.commit()
                logger.info(
                    f"[davmail-backend] draft {internal_id} edited in-place → "
                    f"uid={item.get('imap_uid')} (pending refetch)"
                )
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"[davmail-backend] _update_draft_row_uid({internal_id}) failed: {e}")

    def _filter_recent_rows(self, internal_ids: list[int], *, grace_sec: int) -> list[int]:
        """从待删列表里剔除创建时间 < grace_sec 的行 (reconcile 误删保护)。

        查询失败时**整批不删** (fail-safe: 删除是不可逆操作, 宁可这轮跳过)。
        """
        if not internal_ids:
            return internal_ids
        try:
            conn = sqlite3.connect(str(self.sync_store.db_path), timeout=10.0)
            try:
                ph = ",".join("?" * len(internal_ids))
                cutoff = time.time() - max(0, grace_sec)
                rows = conn.execute(
                    f"SELECT internal_id FROM email_metadata "
                    f"WHERE internal_id IN ({ph}) "
                    f"AND (created_at IS NULL OR created_at < ?)",
                    (*internal_ids, cutoff),
                ).fetchall()
                keep = {int(r[0]) for r in rows}
                dropped = [i for i in internal_ids if i not in keep]
                if dropped:
                    logger.debug(
                        f"[davmail-backend] drafts reconcile: {len(dropped)} recent "
                        f"rows kept (grace {grace_sec}s): {dropped}"
                    )
                return [i for i in internal_ids if i in keep]
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"[davmail-backend] _filter_recent_rows failed (skip deletes): {e}")
            return []

    def _get_drafts_uidnext(self) -> Optional[int]:
        """读草稿箱 UIDNEXT 快照 (sync_state KV)。未记录返回 None。"""
        try:
            val = self.sync_store.get_state(self._DRAFTS_UIDNEXT_KEY)
            return int(val) if val else None
        except Exception:
            return None

    def _set_drafts_uidnext(self, uidnext: int) -> None:
        """存草稿箱 UIDNEXT 快照 (sync_state KV)。"""
        try:
            self.sync_store.set_state(self._DRAFTS_UIDNEXT_KEY, str(int(uidnext)))
        except Exception as e:
            logger.warning(f"[davmail-backend] _set_drafts_uidnext({uidnext}) failed: {e}")

    def _max_sent_imap_uid(self, below: Optional[int] = None) -> int:
        """SQLite 里 mailbox='发件箱' 已导入的最大 IMAP UID (任意 backend_origin)。

        首次同步 (存量全是 AppleScript 行, imap_uid 为 NULL) 返回 0 → 调用方退化日期下限。
        merge protection 把存量行补上 imap_uid 后, 此 marker 即转为真实增量游标。

        ``below`` 给定 (>0) 时只统计 ``imap_uid < below`` 的行。用途: 把当前 Sent
        UIDNEXT 之上的「幽灵高 UID」排除在游标外 —— davmail 换号/缓存重置后, 旧空间或
        跨文件夹污染遗留的死号 (如自发邮件被错盖 INBOX-range UID) 会把 MAX 顶到一个当前
        文件夹根本不存在的值, 导致 ``UID marker+1:*`` 永远落空。davmail UIDVALIDITY 恒为 1
        探测不到 UID 空间变化, 故用 ``< UIDNEXT`` 做防呆钳制 (uidnext 是下一个待分配 UID,
        合法当前邮件 uid 必 < uidnext, 钳制永不误排)。
        """
        try:
            # issue #42 §3.1: 游标按 SENT_MAILBOX_LABELS 全集算 (含变体), 单 label
            # 硬编码在变体行存在时会把 MAX 算漏 → 增量游标恒低 → 反复全量重拉
            # (fork 生产实证)。owner 库零变体行时与 mailbox='发件箱' 逐字节等价。
            sent_pred, sent_params = sql_in_predicate("mailbox", SENT_LABEL_VARIANTS)
            conn = sqlite3.connect(str(self.sync_store.db_path), timeout=10.0)
            try:
                if below is not None and below > 0:
                    row = conn.execute(
                        f"SELECT MAX(imap_uid) FROM email_metadata "
                        f"WHERE {sent_pred} AND imap_uid IS NOT NULL AND imap_uid < ?",
                        (*sent_params, int(below)),
                    ).fetchone()
                else:
                    row = conn.execute(
                        f"SELECT MAX(imap_uid) FROM email_metadata "
                        f"WHERE {sent_pred} AND imap_uid IS NOT NULL",
                        sent_params,
                    ).fetchone()
                return int(row[0]) if row and row[0] is not None else 0
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"[davmail-backend] _max_sent_imap_uid failed: {e}")
            return 0

    def _imap_date_floor(self) -> str:
        """SYNC_START_DATE ("2026-01-01") → IMAP SEARCH 日期格式 ("01-Jan-2026")."""
        raw = (getattr(self.cfg, "sync_start_date", "") or "2026-01-01")[:10]
        try:
            return datetime.strptime(raw, "%Y-%m-%d").strftime("%d-%b-%Y")
        except Exception:
            return "01-Jan-2026"

    def _sent_search_criteria(self) -> tuple[str, str]:
        """发件箱增量 search criteria: 有 marker 走 UID 增量, 否则日期下限回填。

        marker 按当前 Sent UIDNEXT 钳制 (排除换号/跨文件夹污染遗留的幽灵高 UID);
        钳制后归零 (当前 UID 空间内尚无已导入行, 如首次或换号后) → 日期下限重拉,
        message_id dedup 防重。
        """
        uidnext = self._folder_uidnext(self.sent_folder) if self.sent_folder else 0
        if uidnext <= 0:
            # UIDNEXT 探测失败 (STATUS 失败 / 会话降级) → 不信任 DB 裸 marker: 它可能是换号
            # 遗留的幽灵高 UID, 一旦走 UID marker+1:* 又会恒空 (复现冻结)。退化日期下限重拉
            # (message_id dedup 防重); 下个周期 uidnext 恢复后即转回钳制增量, 自愈。
            return ("SENTSINCE", self._imap_date_floor())
        marker = self._max_sent_imap_uid(below=uidnext)
        if marker > 0:
            return ("UID", f"{marker + 1}:*")
        return ("SENTSINCE", self._imap_date_floor())

    # ---- 多文件夹同步: per-folder marker / uidvalidity / 窗口 helper ----

    def _max_folder_imap_uid(self, mailbox_label: str) -> int:
        """SQLite 里某 mailbox label 已导入的最大 davmail IMAP UID (派生增量游标)。

        通用版 _max_sent_imap_uid: 按 mailbox 字段 (中文 display name) + backend_origin='davmail'
        过滤。首次 (无该 folder 的 davmail 行) 返回 0 → 调用方退化窗口下限回填。
        """
        try:
            conn = sqlite3.connect(str(self.sync_store.db_path), timeout=10.0)
            try:
                row = conn.execute(
                    "SELECT MAX(imap_uid) FROM email_metadata "
                    "WHERE mailbox = ? AND backend_origin = 'davmail' AND imap_uid IS NOT NULL",
                    (mailbox_label,),
                ).fetchone()
                return int(row[0]) if row and row[0] is not None else 0
            except Exception as e:
                logger.warning(f"[davmail-backend] _max_folder_imap_uid({mailbox_label!r}) failed: {e}")
                return 0
            finally:
                conn.close()
        except Exception as e:
            logger.warning(f"[davmail-backend] _max_folder_imap_uid({mailbox_label!r}) connect failed: {e}")
            return 0

    def _folder_status(self, imap_name: str) -> tuple[int, Optional[int]]:
        """STATUS <folder> (UIDNEXT UIDVALIDITY) → (uidnext, uidvalidity)。失败返回 (0, None)。"""
        try:
            with imap_session(self.cfg, timeout=30) as imap:
                typ, data = imap.status(quote_mailbox(imap_name), "(UIDNEXT UIDVALIDITY)")
                if typ == "OK" and data:
                    uidnext = self._extract_status_value(data[0], "UIDNEXT")
                    uv = self._extract_status_value(data[0], "UIDVALIDITY")
                    return (int(uidnext) if uidnext else 0, int(uv) if uv else None)
        except Exception as e:
            logger.warning(f"[davmail-backend] _folder_status({imap_name!r}) failed: {e}")
        return (0, None)

    def _folder_date_floor(self) -> str:
        """自定义文件夹首次窗口下限 = today - FOLDER_SYNC_PAST_DAYS → IMAP SEARCH 日期格式。"""
        days = int(getattr(self.cfg, "folder_sync_past_days", 90) or 90)
        floor = datetime.now(timezone.utc) - timedelta(days=max(0, days))
        return floor.strftime("%d-%b-%Y")

    def _folder_uidvalidity_key(self, imap_name: str) -> str:
        return f"folder_uidvalidity:{imap_name}"

    def _get_folder_uidvalidity(self, imap_name: str) -> Optional[int]:
        """读 per-folder UIDVALIDITY (sync_state KV)。未记录返回 None。"""
        try:
            val = self.sync_store.get_state(self._folder_uidvalidity_key(imap_name))
            return int(val) if val else None
        except Exception:
            return None

    def _set_folder_uidvalidity(self, imap_name: str, uv: int) -> None:
        """存 per-folder UIDVALIDITY (sync_state KV)。"""
        try:
            self.sync_store.set_state(self._folder_uidvalidity_key(imap_name), str(int(uv)))
        except Exception as e:
            logger.warning(f"[davmail-backend] _set_folder_uidvalidity({imap_name!r}={uv}) failed: {e}")

    def set_last_max_row_id(self, row_id: int) -> None:
        """写 marker 内存缓存 (持久化由调用方走 sync_store)."""
        self._cached_marker = int(row_id) if row_id else None

    def get_last_max_row_id(self) -> int:
        """读 marker 内存缓存."""
        return self._cached_marker or 0

    def _parse_batch_headers(self, data: list, *, uidvalidity: Optional[int] = None) -> list[dict]:
        """从 batch FETCH HEADER.FIELDS 响应解析出 dict list.

        ``uidvalidity``: 该批邮件所属 folder 的 UIDVALIDITY (从 SELECT 响应读)。每封邮件的
        ``imap_uidvalidity`` 用它; 省略时回退 ``self.inbox_uidvalidity`` (向后兼容 fetch_recent
        等老调用方)。

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
            message_id = _normalize_message_id(msg.get("Message-ID"))
            # RFC 2047 decode 线程头, 防 encoded-word 长 Message-ID 截断 (见 fetch 路径).
            thread_id = _thread_id_from_headers(
                msg.get("References"), msg.get("In-Reply-To")
            )
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
                "imap_uidvalidity": uidvalidity if uidvalidity is not None else self.inbox_uidvalidity,
                # references_raw / in_reply_to_raw: reconcile_drafts 消费 (草稿
                # linkage 持久化, D1 Bug A); 此处保留原 raw 语义 (decode 在消费点);
                # thread_id 已在上方走 _thread_id_from_headers 解码.
                "references_raw": (msg.get("References") or "").strip() or None,
                "in_reply_to_raw": (msg.get("In-Reply-To") or "").strip().strip("<>") or None,
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
        pair = DavMailBackend._parse_appenduid_pair(data)
        return pair[1] if pair else None

    @staticmethod
    def _parse_appenduid_pair(data: list) -> Optional[tuple[int, int]]:
        """APPENDUID → (uidvalidity, uid)。草稿即时落库需要 uv 走 fetch 快路径。"""
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
            return (int(m.group(1)), int(m.group(2)))
        except (TypeError, ValueError):
            return None
