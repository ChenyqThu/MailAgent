"""L0+L1 增量扫描器: email_metadata → contact/contact_email/contact_email_link (task 08-13 WP1)。

形态镜像 new_watcher ``_reconcile_inbox`` 的独立低频节拍纪律:
- 🔴 绝不挂 5s radar poll —— 独立 interval env (``MAILAGENT_CONTACT_EXTRACT_INTERVAL_SEC``),
  每 tick 有界批 (batch + 墙钟预算); 纯本地 SQLite (零 IMAP), 由 new_watcher 放
  ``asyncio.to_thread`` 跑, 不冻 event loop。
- flag off (``MAILAGENT_CONTACTS_ENABLED``) = 字节级 inert: ``run_tick`` 第一行
  返回, 零 SQL 零文件。
- backfill = watermark 从 0 起步的同一段代码 (CLI ``mailagent contact backfill``
  只是不带预算的催跑, 不另起一条 bulk 路径)。

watermark = ``sync_state['contact_extract.watermark']``, 键值 = 已消化的最大
``email_metadata.internal_id``:
- internal_id 是该表自身的插入序单调键 —— applescript 行 = Mail.app ROWID
  (< 1e9, 递增), davmail 行 = ``allocate_davmail_internal_id`` 单调计数器
  (>= 1e9); 对账补抓的老邮件拿**新分配** id ⇒ 一定落在 watermark 之后 (换
  ``date_received`` 游标反而会永久漏掉补抓行)。
- 已知边界 (与 issue #34 marker 同族, 有意接受): davmail→applescript 应急回切
  后新行 id < 1e9 会落在 davmail 时代 watermark 之下, 增量扫不到 —— 兜底 =
  ``mailagent contact backfill --rescan`` 全量重扫 (全程幂等, 重跑任意区间结果
  一致); 同理 Draft→Sent 提升 merge 进老行 (id 在 watermark 之下) 的 sent_to
  计数也由 rescan 收敛。

幂等设计: 账本 ``INSERT OR IGNORE``; 聚合增量只在「该 (锚点, 邮件) 首次入账」时
+1; display_name 刷新带 ``seen_at >= last_seen_at`` 单调闸; 无变化的重扫不发
UPDATE (重跑任意区间, 表内容 byte-stable)。
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from email.utils import getaddresses
from typing import Any, Dict, FrozenSet, Optional, Set

from loguru import logger

from src.contacts.repository import ContactRepository
from src.contacts.service import (
    ensure_self_bootstrap,
    normalize_email,
    parse_identity_locks,
    resolve_self_addresses,
)
from src.mail.mailbox_semantics import DRAFT_MAILBOX_LABELS

WATERMARK_KEY = "contact_extract.watermark"
DEFAULT_BATCH_SIZE = 500
#: watcher tick 的墙钟预算 (秒): 积压大时单 tick 多消化几批, 13k 存量 1-2 个
#: tick 内清完 (验收「backfill < 5min 不阻塞启动」); 预算耗尽下个 interval 续。
DEFAULT_TICK_BUDGET_SEC = 20.0

#: robot 地址 pattern 集 (PRD §3.4; 子串命中, 保守)。
ROBOT_ADDRESS_PATTERNS = (
    "noreply", "no-reply", "donotreply", "do-not-reply",
    "notification", "newsletter", "bounce", "mailer-daemon",
)
#: list 弱启发 (PRD §3.4 允许误判, owner 可改判): local part 前缀。
LIST_LOCAL_PREFIXES = ("team-", "all-")

NAME_VARIANTS_CAP = 20


def kind_for_address(email: str) -> str:
    """确定性 kind 启发式 (只看地址, 幂等)。owner 改判 (kind_locked_at) 优先。"""
    local = email.split("@", 1)[0]
    if any(pattern in email for pattern in ROBOT_ADDRESS_PATTERNS):
        return "robot"
    if any(local.startswith(prefix) for prefix in LIST_LOCAL_PREFIXES):
        return "list"
    return "person"


def _parse_seen_at(raw: Any) -> Optional[int]:
    """`date_received` (ISO TEXT) → epoch ms; 解析不动就 None (镜像 matters
    `_parse_email_timestamp`, 那份随 WP3 候选提取退役)。"""
    if not raw:
        return None
    try:
        return int(datetime.fromisoformat(str(raw)).timestamp() * 1000)
    except (TypeError, ValueError):
        return None


def _get_watermark(conn) -> int:
    row = conn.execute(
        "SELECT value FROM sync_state WHERE key=?", (WATERMARK_KEY,)
    ).fetchone()
    try:
        return int(row[0]) if row else 0
    except (TypeError, ValueError):
        return 0


def _set_watermark(conn, value: int) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)",
        (WATERMARK_KEY, str(int(value)), time.time()),
    )


def _clean_name(raw: Any) -> Optional[str]:
    name = str(raw or "").strip()
    return name or None


def _upsert_from_scan(
    conn, *, email: str, roles: Set[str], sender_name: Optional[str],
    header_name: Optional[str], internal_id: int, seen_at: Optional[int],
    outgoing: bool, now_ms: int, stats: Dict[str, int],
) -> None:
    anchor = conn.execute(
        "SELECT ce.id AS email_id, ce.contact_id, ce.first_seen_at AS a_first, "
        "  ce.last_seen_at AS a_last, "
        "  c.display_name, c.identity_locked_at, c.identity_locks_json, "
        "  c.kind, c.kind_locked_at, "
        "  c.name_variants_json, c.first_seen_at AS c_first, c.last_seen_at AS c_last "
        "FROM contact_email ce JOIN contact c ON c.id = ce.contact_id "
        "WHERE ce.email_normalized = ?",
        (email,),
    ).fetchone()

    if anchor is None:
        kind = kind_for_address(email)
        seed_name = sender_name or header_name
        cursor = conn.execute(
            "INSERT INTO contact (display_name, kind, name_variants_json, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (
                seed_name, kind,
                json.dumps([seed_name], ensure_ascii=False) if seed_name else None,
                now_ms, now_ms,
            ),
        )
        contact_id = int(cursor.lastrowid)
        cursor = conn.execute(
            "INSERT INTO contact_email (contact_id, email_normalized, is_primary, "
            "created_at) VALUES (?, ?, 1, ?)",
            (contact_id, email, now_ms),
        )
        email_id = int(cursor.lastrowid)
        stats["contacts_created"] += 1
        display_name = seed_name
        display_name_locked = False
        kind_locked = None
        variants_raw = None
        a_first = a_last = c_first = c_last = None
        current_kind = kind
    else:
        email_id = int(anchor["email_id"])
        contact_id = int(anchor["contact_id"])
        display_name = anchor["display_name"]
        # v55 起判据 = display_name **字段锁** (identity_locks_json 真源); 防御性
        # fallback: 锁映射缺席但老聚合列非空 → 仍按锁处理 (与 v55 seed 前行为等价,
        # 兜未知旁路写)。
        display_name_locked = (
            "display_name" in parse_identity_locks(anchor["identity_locks_json"])
            or (
                anchor["identity_locks_json"] is None
                and anchor["identity_locked_at"] is not None
            )
        )
        kind_locked = anchor["kind_locked_at"]
        variants_raw = anchor["name_variants_json"]
        a_first, a_last = anchor["a_first"], anchor["a_last"]
        c_first, c_last = anchor["c_first"], anchor["c_last"]
        current_kind = anchor["kind"]

    # ---- 账本 (L1): (锚点, 邮件) 首次入账才算一次参与 ----
    new_participation = conn.execute(
        "SELECT 1 FROM contact_email_link WHERE email_id=? AND internal_id=? LIMIT 1",
        (email_id, internal_id),
    ).fetchone() is None
    inserted_links = 0
    for role in sorted(roles):
        cursor = conn.execute(
            "INSERT OR IGNORE INTO contact_email_link "
            "(email_id, internal_id, role, seen_at) VALUES (?, ?, ?, ?)",
            (email_id, internal_id, role, seen_at),
        )
        inserted_links += cursor.rowcount
    stats["links_inserted"] += inserted_links

    # ---- 锚点聚合 (只在有实际变化时 UPDATE, 保证重扫 byte-stable) ----
    anchor_sets = []
    anchor_params: list = []
    if new_participation:
        anchor_sets.append("mail_count = mail_count + 1")
    if seen_at is not None:
        if a_first is None or seen_at < int(a_first):
            anchor_sets.append("first_seen_at = ?")
            anchor_params.append(seen_at)
        if a_last is None or seen_at > int(a_last):
            anchor_sets.append("last_seen_at = ?")
            anchor_params.append(seen_at)
    if anchor_sets:
        conn.execute(
            f"UPDATE contact_email SET {', '.join(anchor_sets)} WHERE id = ?",
            (*anchor_params, email_id),
        )

    # ---- 人级聚合 + display_name 刷新 + 变体收集 + kind 启发式 ----
    sets = []
    params: list = []
    if new_participation:
        sets.append("mail_count = mail_count + 1")
        if outgoing and roles & {"to", "cc"}:
            sets.append("sent_to_count = sent_to_count + 1")
    if seen_at is not None:
        if c_first is None or seen_at < int(c_first):
            sets.append("first_seen_at = ?")
            params.append(seen_at)
        if c_last is None or seen_at > int(c_last):
            sets.append("last_seen_at = ?")
            params.append(seen_at)

    if not display_name_locked:
        # 刷新规则 (PRD §4.2): 最近一封非空 sender_name; 单调闸 seen_at >=
        # last_seen_at 让「重跑旧区间」不会拿旧名字盖新名字。to/cc 的 header
        # display name 只做空位种子, 不覆盖。
        refresh_name = None
        if "sender" in roles and sender_name:
            if c_last is None or (seen_at is not None and seen_at >= int(c_last)):
                refresh_name = sender_name
        if refresh_name is None and display_name is None:
            refresh_name = sender_name or header_name
        if refresh_name is not None and refresh_name != display_name:
            sets.append("display_name = ?")
            params.append(refresh_name)

    seen_names = [name for name in (sender_name, header_name) if name]
    if seen_names:
        try:
            variants = list(json.loads(variants_raw)) if variants_raw else []
        except (TypeError, ValueError):
            variants = []
        added = False
        for name in seen_names:
            if name not in variants and len(variants) < NAME_VARIANTS_CAP:
                variants.append(name)
                added = True
        if added:
            sets.append("name_variants_json = ?")
            params.append(json.dumps(variants, ensure_ascii=False))

    if kind_locked is None and current_kind == "person":
        heuristic = kind_for_address(email)
        if heuristic != "person":
            sets.append("kind = ?")
            params.append(heuristic)

    if sets:
        sets.append("updated_at = ?")
        params.append(now_ms)
        conn.execute(
            f"UPDATE contact SET {', '.join(sets)} WHERE id = ?",
            (*params, contact_id),
        )


def scan_batch(
    conn, *, self_addresses: FrozenSet[str],
    batch_size: int = DEFAULT_BATCH_SIZE, now_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """消化一批 (调用方持有事务: 逐封提取 + watermark 推进原子落库)。"""
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    watermark = _get_watermark(conn)
    rows = conn.execute(
        "SELECT internal_id, sender_email, sender_name, to_addr, cc_addr, "
        "date_received, mailbox FROM email_metadata "
        "WHERE internal_id > ? ORDER BY internal_id LIMIT ?",
        (watermark, batch_size),
    ).fetchall()
    stats: Dict[str, Any] = {
        "processed": len(rows), "skipped_draft": 0, "contacts_created": 0,
        "links_inserted": 0, "watermark": watermark,
        "drained": len(rows) < batch_size,
    }
    if not rows:
        return stats

    for row in rows:
        if (row["mailbox"] or "") in DRAFT_MAILBOX_LABELS:
            # 草稿未发出, 收件人不算往来 (PRD §4.2 排除集)。
            stats["skipped_draft"] += 1
            continue
        internal_id = int(row["internal_id"])
        seen_at = _parse_seen_at(row["date_received"])
        # 🔴 v58 起读派生列 `sender_email`, **不再**自己 normalize `sender`:
        # 后者不保证是裸地址 (活库 68% 的行是整个 From 头 `Gary W <…>`),
        # normalize_email 对它一律返 None ⇒ 那 8850 封的发件人在账本里从来没记过。
        # 解析收口在持久化边界 (src/mail/email_address.py::derive_sender_email)。
        sender_email = row["sender_email"]
        outgoing = sender_email is not None and sender_email in self_addresses

        participants: Dict[str, Dict[str, Any]] = {}

        def _add(addr: Any, name: Any, role: str) -> None:
            email = normalize_email(addr)
            if email is None:
                return
            entry = participants.setdefault(
                email, {"roles": set(), "sender_name": None, "header_name": None},
            )
            entry["roles"].add(role)
            cleaned = _clean_name(name)
            if cleaned:
                key = "sender_name" if role == "sender" else "header_name"
                if entry[key] is None:
                    entry[key] = cleaned

        _add(sender_email, row["sender_name"], "sender")
        for column, role in (("to_addr", "to"), ("cc_addr", "cc")):
            raw = row[column]
            if raw:
                for name, addr in getaddresses([str(raw)]):
                    _add(addr, name, role)

        for email, entry in participants.items():
            # 🔴 task 08-14 WP-3: 自有地址**照常建档记账**。此前这里 `continue`,
            # 于是 owner 换邮箱后新地址一封关联都没有 (活库实测 mail_count=0 /
            # link 0 条) —— 而 owner 要的是「标成自己也要正常记账, 我还可以给自己
            # 建立画像」。`is_self` 从排除开关降级为身份标签, 排除只剩 compose
            # 收件人补全一处 (见 repository/email_repository.py 的 excluded 位)。
            _upsert_from_scan(
                conn, email=email, roles=entry["roles"],
                sender_name=entry["sender_name"], header_name=entry["header_name"],
                internal_id=internal_id, seen_at=seen_at, outgoing=outgoing,
                now_ms=now_ms, stats=stats,
            )

    new_watermark = int(rows[-1]["internal_id"])
    _set_watermark(conn, new_watermark)
    stats["watermark"] = new_watermark
    return stats


def run_scan(
    db_path: str, *, batch_size: int = DEFAULT_BATCH_SIZE,
    budget_sec: Optional[float] = None, reset_watermark: bool = False,
    self_addresses: Optional[FrozenSet[str]] = None,
    now_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """批循环消化到追平 (或预算耗尽)。每批一个事务 (账本 + watermark 原子)。

    ``reset_watermark=True`` = 从 0 全量重扫 (幂等, CLI --rescan / 应急回切兜底)。
    """
    repository = ContactRepository(db_path)
    started = time.monotonic()
    totals: Dict[str, Any] = {
        "processed": 0, "skipped_draft": 0, "contacts_created": 0,
        "links_inserted": 0, "batches": 0, "watermark": 0, "drained": False,
    }
    first = True
    while True:
        with repository.transaction() as conn:
            if first:
                if reset_watermark:
                    _set_watermark(conn, 0)
                if self_addresses is None:
                    # 🔴 引导排在 resolve **之前** (task 08-14 WP-3 ②「引导之后一切
                    # 以『我』那条资料为准」): 先把「我」标出来, 本轮的自有集才吃得到
                    # 「我」名下合并进来的旧邮箱。显式注入 self_addresses 时不引导
                    # (调用方自己负责口径 —— CLI 在解析前自己调, 测试注入固定集)。
                    ensure_self_bootstrap(conn, now=now_ms)
                    self_addresses = resolve_self_addresses(conn)
                first = False
            stats = scan_batch(
                conn, self_addresses=self_addresses,
                batch_size=batch_size, now_ms=now_ms,
            )
        totals["batches"] += 1
        for key in ("processed", "skipped_draft", "contacts_created", "links_inserted"):
            totals[key] += stats[key]
        totals["watermark"] = stats["watermark"]
        if stats["drained"]:
            totals["drained"] = True
            break
        if budget_sec is not None and (time.monotonic() - started) > budget_sec:
            break
    totals["duration_ms"] = int((time.monotonic() - started) * 1000)
    return totals


def run_tick(
    db_path: str, *, budget_sec: float = DEFAULT_TICK_BUDGET_SEC,
) -> Optional[Dict[str, Any]]:
    """new_watcher 独立低频节拍入口。🔴 flag off = 字节级 inert: 不开库、不建
    文件、零 SQL —— 第一行 settings 门挡掉一切。"""
    from src.config import config as _settings

    if not getattr(_settings, "contacts_enabled", False):
        return None
    try:
        return run_scan(db_path, budget_sec=budget_sec)
    except Exception as e:  # 扫描失败只降级告警, 不打断 watcher 主循环
        logger.warning(f"[contact-extract] scan failed (skip cycle): {e}")
        return None
