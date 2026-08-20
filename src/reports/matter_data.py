"""报告事项取数 —— 窗口内值得进报告的 Matter 投影（确定性，无 LLM）。

🔴 与 ``data.py``（邮件取数）**有意分成两个文件**：两个域的 SQL 混在一个文件里，
下一个改邮件查询的人会顺手动到事项。本模块只**读** ``matter*`` 表，一行不写。

纪律与邮件侧一致：事实由代码从库里取，LLM 只做策展（挑哪几条、怎么讲）。取数失败
一律降级为「没有事项」，绝不让报告因为事项挂了而生不出来。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from loguru import logger

_BEIJING = timezone(timedelta(hours=8))

# 一次报告最多带多少条事项。超出时**记日志说明丢了几条** —— silent truncation 会让
# 报告读起来像「覆盖全了」。
MAX_MATTER_BRIEFS = 30

# 「在推进」的状态集：窗口内没动静也照样进报告（推进中的事本来就该被问一句）。
# 与 stat_row 的「推进中 N」同一口径。
ACTIVE_STATUSES = ("active", "waiting", "blocked")

# due_at 距窗口末端多久算「临期」（与前端 matterDueTone 的 warn 档同为 3 天）。
DUE_SOON_DAYS = 3

# 每条 brief 的各段上限（喂 LLM 的是浓缩投影，不是全量导出）。
_MAX_EVENT_LINES = 5
_MAX_OPEN_ACTIONS = 3
_MAX_WAITING_ON = 4
_MAX_SIGNALS = 3
_MAX_EMAIL_IDS = 5
_SUMMARY_MAX_CHARS = 300

# attention.severity → 排序权重（越大越先讲）。
_SEVERITY_RANK = {"critical": 2, "warn": 1, "info": 0}

# priority → 排序权重（p0 最前；未知值垫底）。
_PRIORITY_ORDER = {"p0": 0, "p1": 1, "p2": 2, "p3": 3}

# 事项时间戳（due_at / happened_at / …）在库里是 **epoch 毫秒**（service.clock_ms）。
_MS = 1000


@dataclass
class MatterBrief:
    """一条事项在本报告窗口里的投影（够 matter_item block + LLM 档案段用）。"""

    public_id: str
    title: str
    status: str
    health: str
    priority: str
    due_at: Optional[int] = None  # epoch ms
    current_summary: str = ""
    goal_done: int = 0
    goal_total: int = 0
    # 窗口内发生了什么（已压成人读短句）；空 = 本窗口没动静。
    event_lines: List[str] = field(default_factory=list)
    # 未完成的行动项（top-3，按 position）。
    open_actions: List[str] = field(default_factory=list)
    # 在等谁（is_waiting_on 干系人显示名 / 邮箱）。
    waiting_on: List[str] = field(default_factory=list)
    # open attention 信号（why 文案，按 severity 降序）。
    signals: List[str] = field(default_factory=list)
    signal_count: int = 0
    pending_updates: int = 0
    # 🔴 窗口内关联邮件的 internal_id —— 事项↔邮件的连接点。没有它，报告里事项和邮件
    # 是两个各说各话的清单；有了它模型才写得出「X 事项本周 3 封往来，球在对方」。
    email_ids: List[int] = field(default_factory=list)

    @property
    def has_window_activity(self) -> bool:
        return bool(self.event_lines) or bool(self.email_ids)


def fetch_matter_briefs(
    db_path: str,
    window_start: datetime,
    window_end: datetime,
    *,
    limit: int = MAX_MATTER_BRIEFS,
) -> List[MatterBrief]:
    """取窗口 ``[window_start, window_end)`` 内值得进报告的事项。

    纳入判据（live 事项满足任一）：窗口内有 ``matter_event`` / 状态在推进
    （active|waiting|blocked）/ ``due_at`` 临期或逾期 / 有 open attention 信号 /
    有 pending 提案。

    取数异常 → 记日志返 ``[]``，**不抛**（报告不能因为事项挂了而生不出来）。
    """
    start_ms = int(window_start.timestamp() * _MS)
    end_ms = int(window_end.timestamp() * _MS)
    due_soon_ms = end_ms + DUE_SOON_DAYS * 86_400 * _MS

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT m.id                AS id,
                   m.public_id         AS public_id,
                   m.title             AS title,
                   m.status            AS status,
                   m.health            AS health,
                   m.priority          AS priority,
                   m.due_at            AS due_at,
                   m.current_summary   AS current_summary,
                   m.goal_checks_json  AS goal_checks_json,
                   m.last_activity_at  AS last_activity_at,
                   (SELECT COUNT(*) FROM matter_event e
                     WHERE e.matter_id = m.id
                       AND e.happened_at >= ? AND e.happened_at < ?) AS event_count,
                   (SELECT COUNT(*) FROM matter_attention a
                     WHERE a.matter_id = m.id AND a.state = 'open')  AS signal_count,
                   (SELECT COUNT(*) FROM matter_update u
                     WHERE u.matter_id = m.id
                       AND u.review_status = 'pending')              AS pending_updates
              FROM matter m
             WHERE m.deleted_at IS NULL AND m.archived_at IS NULL
            """,
            (start_ms, end_ms),
        ).fetchall()

        selected = [
            r
            for r in rows
            if _is_report_worthy(r, end_ms=end_ms, due_soon_ms=due_soon_ms)
        ]
        selected.sort(key=_sort_key)
        if len(selected) > limit:
            # 🔴 截断必须留痕：不说一句「丢了几条」，读者会以为这份报告覆盖了全部事项。
            logger.info(
                f"[report] 事项取数命中上限 {limit}：窗口内 {len(selected)} 条候选，"
                f"按优先级 + 信号 + 到期取前 {limit} 条，未纳入 {len(selected) - limit} 条"
            )
            selected = selected[:limit]
        if not selected:
            return []

        matter_ids = [int(r["id"]) for r in selected]
        events = _window_event_lines(conn, matter_ids, start_ms, end_ms)
        actions = _open_actions(conn, matter_ids)
        waiting = _waiting_on(conn, matter_ids)
        signals = _open_signals(conn, matter_ids)
        emails = _window_email_ids(conn, matter_ids, window_start, window_end)
    except sqlite3.Error as e:
        logger.warning(f"[report] fetch_matter_briefs query failed: {e}")
        return []
    finally:
        conn.close()

    briefs: List[MatterBrief] = []
    for r in selected:
        mid = int(r["id"])
        done, total = _goal_progress(r["goal_checks_json"])
        briefs.append(
            MatterBrief(
                public_id=str(r["public_id"]),
                title=str(r["title"] or ""),
                status=str(r["status"] or ""),
                health=str(r["health"] or ""),
                priority=str(r["priority"] or ""),
                due_at=int(r["due_at"]) if r["due_at"] is not None else None,
                current_summary=(r["current_summary"] or "").strip()[:_SUMMARY_MAX_CHARS],
                goal_done=done,
                goal_total=total,
                event_lines=events.get(mid, []),
                open_actions=actions.get(mid, []),
                waiting_on=waiting.get(mid, []),
                signals=signals.get(mid, []),
                signal_count=int(r["signal_count"] or 0),
                pending_updates=int(r["pending_updates"] or 0),
                email_ids=emails.get(mid, []),
            )
        )
    return briefs


def matter_stats(briefs: Sequence[MatterBrief]) -> Dict[str, int]:
    """stat_row 追加的两格（PRD R3）：推进中 / 需你决策。

    「需你决策」= 有待审提案**或**有 open 信号的事项数 —— 这两样都是「球在你这边、
    等你拍板」，合成一格比拆两格更贴 owner 扫一眼的用法。
    """
    return {
        "matters_active": sum(1 for b in briefs if b.status in ACTIVE_STATUSES),
        "matters_attention": sum(
            1 for b in briefs if b.pending_updates > 0 or b.signal_count > 0
        ),
    }


# ── 纳入判据 / 排序 ──────────────────────────────────────────────────────────

def _is_report_worthy(row: sqlite3.Row, *, end_ms: int, due_soon_ms: int) -> bool:
    if int(row["event_count"] or 0) > 0:
        return True
    if str(row["status"] or "") in ACTIVE_STATUSES:
        return True
    due_at = row["due_at"]
    if due_at is not None and int(due_at) < due_soon_ms:
        # 逾期（< end_ms）与临期（< end_ms + N 天）同一判据：都是「该被提一句」。
        return True
    if int(row["signal_count"] or 0) > 0:
        return True
    return int(row["pending_updates"] or 0) > 0


def _sort_key(row: sqlite3.Row) -> Tuple[int, int, int, int]:
    """priority → 有无信号 → 到期早晚 → 最近活动（PRD R1 的排序口径）。"""
    priority = _PRIORITY_ORDER.get(str(row["priority"] or ""), len(_PRIORITY_ORDER))
    has_signal = 0 if int(row["signal_count"] or 0) > 0 else 1
    due = int(row["due_at"]) if row["due_at"] is not None else 1 << 62
    last_activity = -int(row["last_activity_at"] or 0)
    return (priority, has_signal, due, last_activity)


def _goal_progress(raw: Any) -> Tuple[int, int]:
    """goal_checks_json（``[{"t":…,"done":bool}]``）→ (done, total)。非法 → (0, 0)。"""
    try:
        parsed = json.loads(raw or "[]")
    except (json.JSONDecodeError, TypeError):
        return 0, 0
    if not isinstance(parsed, list):
        return 0, 0
    checks = [c for c in parsed if isinstance(c, dict)]
    return sum(1 for c in checks if c.get("done")), len(checks)


# ── 明细批查询（一次覆盖整批事项，绝不按行发查询）──────────────────────────

def _placeholders(values: Sequence[Any]) -> str:
    return ", ".join("?" for _ in values)


def _window_event_lines(
    conn: sqlite3.Connection, matter_ids: List[int], start_ms: int, end_ms: int
) -> Dict[int, List[str]]:
    """窗口内事件 → 人读短句（状态迁移 / 闭环的行动项 / 采纳的进展 / 新信号）。"""
    rows = conn.execute(
        "SELECT matter_id, kind, payload_json FROM matter_event "
        f"WHERE matter_id IN ({_placeholders(matter_ids)}) "
        "AND happened_at >= ? AND happened_at < ? "
        "ORDER BY matter_id, happened_at, id",
        (*matter_ids, start_ms, end_ms),
    ).fetchall()
    out: Dict[int, List[str]] = {}
    for row in rows:
        mid = int(row["matter_id"])
        lines = out.setdefault(mid, [])
        if len(lines) >= _MAX_EVENT_LINES:
            continue
        line = _event_line(str(row["kind"]), row["payload_json"])
        if line and line not in lines:
            lines.append(line)
    return out


def _event_line(kind: str, payload_raw: Any) -> Optional[str]:
    """一条 matter_event → 一句话；讲不出内容的技术性事件返回 None（不占额度）。

    payload 形状见 src/matters/event_changes.py（``changes`` = 值级前后像）。
    """
    try:
        payload = json.loads(payload_raw or "{}")
    except (json.JSONDecodeError, TypeError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    changes = [c for c in (payload.get("changes") or []) if isinstance(c, dict)]
    title = str(payload.get("title") or "").strip()

    if kind == "matter_updated":
        parts = [
            f"{c['field']} {c.get('from', '?')} → {c.get('to', '?')}"
            for c in changes
            if c.get("field") in {"status", "health", "priority", "due_at"}
        ]
        if parts:
            return "、".join(parts)
        return "更新了进展摘要" if _has_narrative(payload) else None
    if kind == "item_created":
        return f"新增{_item_kind_cn(payload.get('kind'))}「{title}」" if title else None
    if kind == "item_updated":
        for c in changes:
            if c.get("field") == "status" and c.get("to") == "done":
                return f"完成行动项「{title}」" if title else "完成一条行动项"
        for c in changes:
            if c.get("field") == "status":
                return f"「{title}」{c.get('from', '?')} → {c['to']}" if title else None
        return None
    if kind == "update_accepted":
        return "采纳了一条跟进提案"
    if kind == "update_proposed":
        return "跟进 Agent 提了一条待审提案"
    if kind == "resource_linked":
        return "关联了新资料"
    if kind == "attention_opened":
        return "出现新的关注信号"
    if kind == "attention_resolved":
        return "一条关注信号已解除"
    return None


def _has_narrative(payload: Dict[str, Any]) -> bool:
    narrative = payload.get("narrative")
    return isinstance(narrative, dict) and bool(str(narrative.get("text") or "").strip())


def _item_kind_cn(kind: Any) -> str:
    return {
        "action": "行动项",
        "milestone": "里程碑",
        "decision": "决策",
        "blocker": "阻塞",
        "question": "待解问题",
        "note": "备注",
    }.get(str(kind or ""), "条目")


def _open_actions(conn: sqlite3.Connection, matter_ids: List[int]) -> Dict[int, List[str]]:
    """未完成的行动项 top-3（按 position,id —— 与详情页列条目同口径）。"""
    rows = conn.execute(
        "SELECT matter_id, title, status FROM matter_item "
        f"WHERE matter_id IN ({_placeholders(matter_ids)}) AND deleted_at IS NULL "
        "AND kind = 'action' AND (status IS NULL OR status NOT IN ('done','canceled')) "
        "ORDER BY matter_id, position, id",
        tuple(matter_ids),
    ).fetchall()
    out: Dict[int, List[str]] = {}
    for row in rows:
        items = out.setdefault(int(row["matter_id"]), [])
        if len(items) >= _MAX_OPEN_ACTIONS:
            continue
        title = str(row["title"] or "").strip()
        if title:
            items.append(title)
    return out


def _waiting_on(conn: sqlite3.Connection, matter_ids: List[int]) -> Dict[int, List[str]]:
    """在等谁（``is_waiting_on`` 干系人）。

    🔴 有意**不**读 tier —— 「在等回复」是这个字段自己的语义，与干系人分层无关。
    """
    rows = conn.execute(
        "SELECT matter_id, display_name, email_normalized FROM matter_stakeholder "
        f"WHERE matter_id IN ({_placeholders(matter_ids)}) AND deleted_at IS NULL "
        "AND is_waiting_on = 1 ORDER BY matter_id, id",
        tuple(matter_ids),
    ).fetchall()
    out: Dict[int, List[str]] = {}
    for row in rows:
        names = out.setdefault(int(row["matter_id"]), [])
        if len(names) >= _MAX_WAITING_ON:
            continue
        name = str(row["display_name"] or "").strip() or str(
            row["email_normalized"] or ""
        ).strip()
        if name:
            names.append(name)
    return out


def _open_signals(conn: sqlite3.Connection, matter_ids: List[int]) -> Dict[int, List[str]]:
    """open attention 的 why 文案（severity 降序，top-3）。"""
    rows = conn.execute(
        "SELECT matter_id, severity, why FROM matter_attention "
        f"WHERE matter_id IN ({_placeholders(matter_ids)}) AND state = 'open' "
        "ORDER BY matter_id, last_observed_at DESC, id DESC",
        tuple(matter_ids),
    ).fetchall()
    buckets: Dict[int, List[Tuple[int, str]]] = {}
    for row in rows:
        why = str(row["why"] or "").strip()
        if not why:
            continue
        rank = _SEVERITY_RANK.get(str(row["severity"] or ""), 0)
        buckets.setdefault(int(row["matter_id"]), []).append((rank, why))
    return {
        mid: [why for _, why in sorted(items, key=lambda x: -x[0])][:_MAX_SIGNALS]
        for mid, items in buckets.items()
    }


def _window_email_ids(
    conn: sqlite3.Connection,
    matter_ids: List[int],
    window_start: datetime,
    window_end: datetime,
) -> Dict[int, List[int]]:
    """事项关联邮件里**落在本窗口**的那些（internal_id）。

    两步：先取关联的 email 资料键（``resource.external_key`` = ``email:<internal_id>``），
    再用 email_metadata 按窗口过滤 —— ``date_received`` 存的是各封邮件原始本地时区
    （混合偏移），所以必须走 ``julianday()`` 按真实时刻比，不能字符串比（同 data.py）。
    """
    link_rows = conn.execute(
        "SELECT mr.matter_id AS matter_id, r.external_key AS external_key "
        "FROM matter_resource mr JOIN resource r ON r.id = mr.resource_id "
        f"WHERE mr.matter_id IN ({_placeholders(matter_ids)}) AND mr.deleted_at IS NULL "
        "AND r.provider = 'mailagent' AND r.kind = 'email' "
        "ORDER BY mr.matter_id, mr.id",
        tuple(matter_ids),
    ).fetchall()
    pairs: List[Tuple[int, int]] = []
    for row in link_rows:
        key = str(row["external_key"] or "")
        if not key.startswith("email:"):
            continue
        try:
            pairs.append((int(row["matter_id"]), int(key[len("email:") :])))
        except ValueError:
            continue
    if not pairs:
        return {}

    candidate_ids = sorted({iid for _, iid in pairs})
    in_window = {
        int(r["internal_id"])
        for r in conn.execute(
            "SELECT internal_id FROM email_metadata "
            f"WHERE internal_id IN ({_placeholders(candidate_ids)}) "
            "AND date_received IS NOT NULL "
            "AND julianday(date_received) >= julianday(?) "
            "AND julianday(date_received) <  julianday(?)",
            (*candidate_ids, window_start.isoformat(), window_end.isoformat()),
        ).fetchall()
    }
    out: Dict[int, List[int]] = {}
    for matter_id, internal_id in pairs:
        if internal_id not in in_window:
            continue
        ids = out.setdefault(matter_id, [])
        if len(ids) < _MAX_EMAIL_IDS and internal_id not in ids:
            ids.append(internal_id)
    return out


# ── 时间格式（prompt 用；block payload 存原始 epoch ms，本地化是前端的事）────

def fmt_due(due_at: Optional[int], now: Optional[datetime] = None) -> str:
    """due_at（epoch ms）→ ``'08-20（还剩 2 天）'`` / ``'08-14（已逾期 4 天）'``。"""
    if due_at is None:
        return ""
    now = now or datetime.now(_BEIJING)
    due = datetime.fromtimestamp(due_at / _MS, tz=now.tzinfo or _BEIJING)
    days = (due.date() - now.date()).days
    if days < 0:
        tail = f"已逾期 {-days} 天"
    elif days == 0:
        tail = "今天到期"
    else:
        tail = f"还剩 {days} 天"
    return f"{due.strftime('%m-%d')}（{tail}）"
