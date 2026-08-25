"""日历与会者 → 通讯录第三源 (task 08-24 L4 批次 1 · #4)。

`scanner.py` 只吃 `email_metadata` 两源 (sender / to+cc)；本模块补第三源:
`calendar_event` 的与会者 → L0 建档 + contact 的三列聚合缓存
(`meeting_count` / `last_met_at` / `next_meeting_at`, DB v69)。

🔴 **全量重算, 不用 watermark 增量**。邮件源能用水位是因为 `email_metadata`
insert-only 且 `internal_id` 单调; `calendar_event` 是**可变表** —— 改期 / 取消 /
软删都回写既有行, 而 `next_meeting_at` 本身就是「随时间流逝会变的量」。所以这里
沿用聚合列的既有纪律 (`service.recalc_contact_aggregates`): 值恒可从窗口内的事实
重算, 幂等自愈, 不是第二真源。窗口外 (更早 / 更远) 的会议不计入。

节拍纪律镜像 `scanner.run_tick`: 🔴 绝不挂 5s radar poll —— 独立 interval env
`MAILAGENT_CONTACT_CALENDAR_INTERVAL_SEC` (默认 900s), 由 `new_watcher` 放
`asyncio.to_thread` 跑。纯本地 SQLite (零 CalDAV 网络调用: 日历 SSoT 就是
`calendar_event` 表, 不绕道 DavMail)。

身份判据仍**只有归一 email** —— 与会者的 CN 显示名只在**新建**那一行时当种子,
永不作为合并判据、也不覆盖既有联系人的姓名 (`upsert_contact_for_email` 的
`fallback_*` 同款语义)。无邮箱的与会者不产生任何 contact 行。

参与者 = ATTENDEE ∪ ORGANIZER。活库实测 (2026-08-24, 163 个未软删事件): 组织者
绝大多数也在 ATTENDEE 里, 但有 7 个事件的 ORGANIZER 不在 —— 只认 ATTENDEE 会把
这些会议里最该记一笔的那个人漏掉。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from loguru import logger

from src.contacts.repository import ContactRepository
from src.contacts.scanner import kind_for_address
from src.contacts.service import get_contact_id_for_email, normalize_email

#: 重算窗口 (天)。过去段决定 meeting_count / last_met_at, 未来段决定 next_meeting_at。
#: 🔴 窗口是**语义的一部分**: meeting_count 读作「最近半年见了几次」而不是「历史总次数」
#: (后者要么随 CalDAV 同步窗口漂移, 要么得为它单独保留历史)。
WINDOW_PAST_DAYS = 180
WINDOW_FUTURE_DAYS = 60

#: 取消的会议不算见过面 (镜像 trigger_worker 的 before_start 扫描)。
_CANCELLED = "CANCELLED"


@dataclass
class _Participation:
    """单个归一 email 在窗口内的参会事实。"""

    #: 与会者显示名 (CN); 只在新建联系人时当种子。
    name: Optional[str] = None
    #: 已结束的 occurrence 键集合 —— 用集合而非计数器: 同一个人可能有两个锚点邮箱
    #: 同时出现在一场会里, 合并到人级时要去重。
    met_keys: Set[Tuple[str, str]] = field(default_factory=set)
    last_met_at: Optional[int] = None
    next_meeting_at: Optional[int] = None

    def merge(self, other: "_Participation") -> None:
        self.met_keys |= other.met_keys
        self.last_met_at = _max_opt(self.last_met_at, other.last_met_at)
        self.next_meeting_at = _min_opt(self.next_meeting_at, other.next_meeting_at)


def _max_opt(a: Optional[int], b: Optional[int]) -> Optional[int]:
    return b if a is None else (a if b is None else max(a, b))


def _min_opt(a: Optional[int], b: Optional[int]) -> Optional[int]:
    return b if a is None else (a if b is None else min(a, b))


def _to_ms(dt: datetime) -> int:
    """occurrence 的 UTC datetime → epoch **毫秒**。

    🔴 单位换算钉在这一处: `calendar_event` 存的是 epoch 秒 (REAL), 而 contact
    表的时间列一律毫秒 (前端按 ms 渲染)。
    """
    return int(dt.timestamp() * 1000)


def _participants(row) -> List[Tuple[str, Optional[str]]]:
    """一行 `calendar_event` 的参与者 [(归一 email, 显示名)]，按出现序去重。

    `attendees_json` 的行内形状是 `[{email, name, response, role}]`，但 repository
    的写侧兜底会落成只有 `{"email": …}`（老 `attendees: list[str]` 那条腿），故这里
    对缺 name 与裸字符串两种形状都收。
    """
    out: List[Tuple[str, Optional[str]]] = []
    seen: Set[str] = set()

    def _add(raw: Any, name: Any) -> None:
        email = normalize_email(raw)
        if email is None or email in seen:
            return
        seen.add(email)
        cleaned = str(name or "").strip() or None
        out.append((email, cleaned))

    for entry in row.attendees or []:
        if isinstance(entry, dict):
            _add(entry.get("email"), entry.get("name"))
        else:
            _add(entry, None)
    _add(row.organizer, None)
    return out


def collect_participation(
    occurrences: Iterable, *, now_ms: int,
) -> Dict[str, _Participation]:
    """展开后的 occurrence 流 → 每个归一 email 的窗口内参会事实。

    三分: 已结束 (end <= now) 计入 meeting_count / last_met_at; 尚未开始
    (start > now) 参与 next_meeting_at; **正在进行中的既不算见过也不算下一场**
    (说「下一场会议是现在这场」是错的)。
    """
    by_email: Dict[str, _Participation] = {}
    for occ in occurrences:
        row = occ.row
        if (row.status or "").upper() == _CANCELLED:
            continue
        people = _participants(row)
        if not people:
            continue
        start_ms = _to_ms(occ.occurrence_start_utc)
        end_ms = _to_ms(occ.occurrence_end_utc)
        # 键要能跨"同一系列的不同 occurrence"区分, 又能让同一场会的两个锚点去重。
        key = (row.ical_uid or f"row:{row.id}", occ.occurrence_start_utc.isoformat())
        for email, name in people:
            entry = by_email.get(email)
            if entry is None:
                entry = by_email[email] = _Participation()
            if entry.name is None and name:
                entry.name = name
            if end_ms <= now_ms:
                entry.met_keys.add(key)
                entry.last_met_at = _max_opt(entry.last_met_at, end_ms)
            elif start_ms > now_ms:
                entry.next_meeting_at = _min_opt(entry.next_meeting_at, start_ms)
    return by_email


def _create_contact(conn, *, email: str, name: Optional[str], now_ms: int) -> int:
    """日历源的 L0 建档 (镜像 scanner 的新建分支, 少了账本/变体那部分)。

    邮件源不曾见过的人也照常建档 —— 「只见过面没通过信」的同事就是通讯录该有的行。
    `sent_to_count` 保持 0, 所以默认「往来的人」视图不会因此变脏 (那个视图的判据是
    双向邮件往来)。
    """
    cursor = conn.execute(
        "INSERT INTO contact (display_name, kind, created_at, updated_at) "
        "VALUES (?, ?, ?, ?)",
        (name, kind_for_address(email), now_ms, now_ms),
    )
    contact_id = int(cursor.lastrowid)
    conn.execute(
        "INSERT INTO contact_email (contact_id, email_normalized, is_primary, created_at) "
        "VALUES (?, ?, 1, ?)",
        (contact_id, email, now_ms),
    )
    return contact_id


def apply_participation(
    conn, participation: Dict[str, _Participation], *, now_ms: int,
) -> Dict[str, int]:
    """把参会事实落到 contact 三列 (缺人先建档)。只写真变化的行。"""
    stats = {"contacts_created": 0, "contacts_updated": 0, "contacts_reset": 0}

    by_contact: Dict[int, _Participation] = {}
    for email, entry in participation.items():
        contact_id = get_contact_id_for_email(conn, email)
        if contact_id is None:
            contact_id = _create_contact(
                conn, email=email, name=entry.name, now_ms=now_ms,
            )
            stats["contacts_created"] += 1
        merged = by_contact.get(contact_id)
        if merged is None:
            by_contact[contact_id] = _Participation(
                met_keys=set(entry.met_keys),
                last_met_at=entry.last_met_at,
                next_meeting_at=entry.next_meeting_at,
            )
        else:
            merged.merge(entry)

    for contact_id, entry in by_contact.items():
        target = (len(entry.met_keys), entry.last_met_at, entry.next_meeting_at)
        row = conn.execute(
            "SELECT meeting_count, last_met_at, next_meeting_at FROM contact WHERE id=?",
            (contact_id,),
        ).fetchone()
        if (row["meeting_count"], row["last_met_at"], row["next_meeting_at"]) == target:
            continue
        conn.execute(
            "UPDATE contact SET meeting_count=?, last_met_at=?, next_meeting_at=?, "
            "updated_at=? WHERE id=?",
            (*target, now_ms, contact_id),
        )
        stats["contacts_updated"] += 1

    # 窗口内已经没有这个人的会了 (会议被删 / 改期到窗口外 / 取消) → 清回默认值。
    # 少了这一步, 三列就成了「只增不减」的谎: 取消的会永远留在 last_met_at 上。
    stale = [
        int(r[0])
        for r in conn.execute(
            "SELECT id FROM contact WHERE meeting_count <> 0 "
            "OR last_met_at IS NOT NULL OR next_meeting_at IS NOT NULL"
        )
        if int(r[0]) not in by_contact
    ]
    for contact_id in stale:
        conn.execute(
            "UPDATE contact SET meeting_count=0, last_met_at=NULL, next_meeting_at=NULL, "
            "updated_at=? WHERE id=?",
            (now_ms, contact_id),
        )
    stats["contacts_reset"] = len(stale)
    return stats


def run_calendar_scan(
    db_path: str, *,
    now_ms: Optional[int] = None,
    past_days: int = WINDOW_PAST_DAYS,
    future_days: int = WINDOW_FUTURE_DAYS,
) -> Dict[str, Any]:
    """一轮全量重算 (读日历 → 算参与 → 写三列)。幂等: 同一份数据重跑不产生写。"""
    from src.calendar_sync.repository import CalendarEventRepository

    started = time.monotonic()
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    now = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
    # 读日历用独立连接、且在写事务**之前**做完 —— 不在持写锁的时候做 RRULE 展开。
    # pool=False: 本函数跑在 to_thread 的临时线程上, 长连接留在 threading.local 里
    # 没人关。
    calendar_repo = CalendarEventRepository(db_path, pool=False)
    occurrences = calendar_repo.list_event_occurrences(
        now - timedelta(days=past_days), now + timedelta(days=future_days),
    )
    participation = collect_participation(occurrences, now_ms=now_ms)

    repository = ContactRepository(db_path)
    with repository.transaction() as conn:
        stats: Dict[str, Any] = apply_participation(
            conn, participation, now_ms=now_ms,
        )
    stats["occurrences"] = len(occurrences)
    stats["participants"] = len(participation)
    stats["duration_ms"] = int((time.monotonic() - started) * 1000)

    changed = (
        stats["contacts_created"] + stats["contacts_updated"] + stats["contacts_reset"]
    )
    if changed:
        # 真改了行才广播 (无会议变动的 tick 一律静默) —— 三列会动列表投影。
        # lossy 总线, 吞错不阻断扫描 (镜像 scanner.run_scan)。
        try:
            from src.events.publisher import safe_publish

            safe_publish(
                "contact.changed",
                data={
                    "scope": "calendar_scan",
                    "contacts_created": stats["contacts_created"],
                    "contacts_updated": stats["contacts_updated"],
                    "contacts_reset": stats["contacts_reset"],
                },
                source="contact-calendar-scan",
            )
        except Exception:
            pass
    return stats


def run_tick(db_path: str) -> Optional[Dict[str, Any]]:
    """new_watcher 独立低频节拍入口 (失败只降级告警, 不打断主循环)。"""
    try:
        return run_calendar_scan(db_path)
    except Exception as e:
        logger.warning(f"[contact-calendar] scan failed (skip cycle): {e}")
        return None
