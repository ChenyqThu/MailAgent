"""报告数据层 —— 取数 + 分组 + counts（确定性，无 LLM）。

平行 src/notify/digest_query（灵动岛），但投影更富（含 sender_addr + date）
且按报告语义分组（attention / handled / fyi）。**counts 与分组由代码确定，
LLM 不碰** —— 防幻觉（同 DailyDigest 纪律）。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from loguru import logger

from src.llm_agent.schema import PRIORITY_ENUM
from src.mail.mailbox_semantics import DRAFT_LABEL_VARIANTS, SENT_LABEL_VARIANTS
from src.notify.island_dispatch import ACTION_NEEDS_FLAG, URGENT_PRIORITY_LABELS
from src.repository.email_repository import EmailRepository

_BEIJING = timezone(timedelta(hours=8))

# FYI 语义（与 digest_query 一致）：系统通知类 + "仅供参考/已完结" action。
_FYI_ACTION_TYPES = {"仅供参考", "已完结"}
_FYI_CATEGORIES = {"🔔 系统通知"}

# 发件箱（用户自己发的）—— 从报告**条目**里排除（不是待办），但用来推「已回复」。
# issue #42 C 案起单源 mailbox_semantics（宽集，多收录 '已发送' 变体）。
_SENT_MAILBOXES = SENT_LABEL_VARIANTS

# 草稿不进报告：未发出的内容既不是"收到"也不是"已发出"，铺进日/周/月报是噪音。
_DRAFT_MAILBOXES = DRAFT_LABEL_VARIANTS

# priority DESC 排序权重（越前越紧急）。
_PRIORITY_RANK: Dict[str, int] = {
    label: len(PRIORITY_ENUM) - i for i, label in enumerate(PRIORITY_ENUM)
}

# 置顶邮件固定带入的上限（无视时间窗口，按收件时间倒序取最近 N 封），防历史置顶刷屏。
_PINNED_EXTRA_CAP = 50

# agentic 日报预载正文的单封截断（省 token；AI 要全文再用 get_email_body 工具取 12K）。
_BODY_PRELOAD_CHARS = 4000

# brief 投影列（窗口查询 + 置顶补充查询共用）。
_BRIEF_SELECT = """
    SELECT m.internal_id        AS internal_id,
           COALESCE(m.subject, '') AS subject,
           m.sender_name        AS sender_name,
           m.sender             AS sender_addr,
           m.date_received      AS date_received,
           m.is_read            AS is_read,
           m.is_flagged         AS is_flagged,
           m.is_pinned          AS is_pinned,
           m.is_important       AS is_important,
           m.mailbox            AS mailbox,
           m.thread_id          AS thread_id,
           m.notion_page_id     AS notion_page_id,
           l.labels_json        AS labels_json
      FROM email_metadata m
      LEFT JOIN llm_processing l ON l.internal_id = m.internal_id
"""


def _row_to_brief(r: sqlite3.Row, *, is_outbound: bool) -> "ReportEmailBrief":
    labels = _parse_labels(r["labels_json"])
    return ReportEmailBrief(
        internal_id=int(r["internal_id"]),
        subject=r["subject"] or "",
        sender_name=(r["sender_name"] or ""),
        sender_addr=(r["sender_addr"] or ""),
        date_received=(r["date_received"] or ""),
        category=(labels.get("category") or "").strip(),
        priority=(labels.get("priority") or "").strip(),
        action_type=(labels.get("action_type") or "").strip(),
        ai_summary=(labels.get("ai_summary") or "").strip(),
        reply_suggestion=(labels.get("reply_suggestion_md") or "").strip(),
        is_read=bool(r["is_read"]),
        notion_page_id=r["notion_page_id"],
        is_flagged=bool(r["is_flagged"]),
        is_pinned=bool(r["is_pinned"]),
        is_important=bool(r["is_important"]),
        mailbox=(r["mailbox"] or ""),
        thread_id=(r["thread_id"] or ""),
        is_outbound=is_outbound,
    )


@dataclass
class ReportEmailBrief:
    """报告投影：metadata + AI 字段 + 当前状态（够 email_item block 用）。"""

    internal_id: int
    subject: str
    sender_name: str
    sender_addr: str
    date_received: str
    category: str
    priority: str
    action_type: str
    ai_summary: str
    is_read: bool
    notion_page_id: Optional[str]
    # 状态（新字段带默认，兼容旧位置构造）。
    is_flagged: bool = False
    is_pinned: bool = False
    is_important: bool = False
    mailbox: str = ""
    thread_id: str = ""
    replied: bool = False  # 同 thread 有更晚的发件箱邮件 → 已回复
    is_outbound: bool = False  # mailbox ∈ 发件箱 —— 你自己发出的，仅用于统计「已发出」/讲处理情况，不铺成条目
    body_text: Optional[str] = None  # 重要邮件预载正文（agentic 日报）；None=未载，AI 可用 get_email_body 工具按需取
    reply_suggestion: str = ""  # llm_processing.labels_json["reply_suggestion_md"]（仅部分邮件有）


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    """ISO（可能带任意 ±HH:MM 偏移或 naive）→ tz-aware datetime（naive 视为 UTC）。
    用于按**真实时刻**比较（date_received 混合本地时区，字符串比会错）。"""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _parse_labels(raw: Any) -> Dict[str, Any]:
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def fetch_report_briefs(
    db_path: str,
    *,
    window_hours: int = 24,
    max_emails: int = 0,
    now: Optional[datetime] = None,
    body_priorities: Optional[List[str]] = None,
) -> List[ReportEmailBrief]:
    """取窗口 ``[now - window_hours, now)`` 内邮件 brief（metadata + AI 字段）。

    ``now`` = 窗口**上界**（exclusive）。worker 传「今天 00:00（北京）」→ daily 即
    昨天一整天、weekly 即过去 7 个完整日（见 worker 锚定逻辑）。

    JOIN email_metadata + llm_processing（labels_json）。LEFT JOIN：没跑过 LLM 的
    邮件 AI 字段为空仍计入。

    **时区**：``date_received`` 存的是**各封邮件原始本地时区**（混合 -08/-07/+00…，
    未归一化），所以**不能字符串比较**——用 SQLite ``julianday()`` 按真实时刻比
    （它能正确解析 ±HH:MM 偏移转 UTC）。窗口边界传 tz-aware ISO，julianday 同样归一。
    """
    now = now or datetime.now(_BEIJING)
    since_iso = (now - timedelta(hours=window_hours)).isoformat()
    until_iso = now.isoformat()
    sent_ph = ", ".join("?" * len(_SENT_MAILBOXES))

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    briefs: List[ReportEmailBrief] = []
    history: _ThreadHistory = {}
    try:
        # ① 窗口查询：**含**发件箱（按 mailbox 现场判 is_outbound）。发件箱邮件不铺成
        #    报告条目，但带入用于「已发出」统计 + 让 LLM 了解你回复/处理了什么。
        draft_ph = ", ".join("?" * len(_DRAFT_MAILBOXES))
        window_rows = conn.execute(
            _BRIEF_SELECT
            + f"""
             WHERE m.date_received IS NOT NULL
               AND julianday(m.date_received) >= julianday(?)
               AND julianday(m.date_received) <  julianday(?)
               AND (m.mailbox IS NULL OR m.mailbox NOT IN ({draft_ph}))
            """,
            (since_iso, until_iso, *_DRAFT_MAILBOXES),
        ).fetchall()
        seen: set = set()
        for r in window_rows:
            is_out = (r["mailbox"] or "") in _SENT_MAILBOXES
            briefs.append(_row_to_brief(r, is_outbound=is_out))
            seen.add(int(r["internal_id"]))

        # ② 置顶邮件固定带入（**无视时间窗口** —— 置顶=重要且通常未处理，应在每次报告
        #    都浮现，直到取消置顶/处理掉）。排除发件箱 + 已在窗口内的，取最近 N 封。
        pinned_rows = conn.execute(
            _BRIEF_SELECT
            + f"""
             WHERE m.is_pinned = 1
               AND m.date_received IS NOT NULL
               AND m.mailbox NOT IN ({sent_ph})
               AND (m.mailbox IS NULL OR m.mailbox NOT IN ({draft_ph}))
             ORDER BY m.date_received DESC
             LIMIT ?
            """,
            (*_SENT_MAILBOXES, *_DRAFT_MAILBOXES, _PINNED_EXTRA_CAP),
        ).fetchall()
        for r in pinned_rows:
            if int(r["internal_id"]) in seen:
                continue
            briefs.append(_row_to_brief(r, is_outbound=False))
            seen.add(int(r["internal_id"]))

        # 线程全历史状态一次算好：per-email replied 判定 + 每线程正文预载决策共用。
        history = _thread_history(conn, sorted({b.thread_id for b in briefs if b.thread_id}))
        _mark_replied(briefs, history)
    except sqlite3.OperationalError as e:
        logger.warning(f"[report] fetch_report_briefs query failed: {e}")
        return []
    finally:
        conn.close()

    # 收件类排序 + cap（置顶/紧急靠 is_attention 排最前，保证不被 cap 截掉）；
    # 发件箱（outbound）不参与 cap，整体附在尾部（仅供统计 + LLM 上下文，不渲染）。
    inbound = [b for b in briefs if not b.is_outbound]
    outbound = [b for b in briefs if b.is_outbound]
    inbound.sort(
        key=lambda b: (is_attention(b), _PRIORITY_RANK.get(b.priority, 0), b.date_received),
        reverse=True,
    )
    # max_emails ≤0 = 不限制（取窗口内全部 inbound）；否则按排序取前 N。
    capped = inbound if max_emails <= 0 else inbound[:max_emails]
    # agentic 日报：每线程只给最新一封收件预载正文（priority 门 / 球已踢出线程跳过，
    # 见 _preload_bodies）；其余只摘要，AI 用 get_email_body 按需查。
    priorities = set(body_priorities or [])
    if priorities:
        _preload_bodies(db_path, capped, priorities, history)
    return capped + outbound


# 线程全历史状态：thread_id → (最后发件时刻, 最后收件时刻)。
_ThreadHistory = Dict[str, Tuple[Optional[datetime], Optional[datetime]]]

# 组内按真实时刻排序时 date_received 解析失败的兜底（排最前，不抛）。
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _thread_history(conn: sqlite3.Connection, thread_ids: List[str]) -> _ThreadHistory:
    """按**全历史**（不限报告窗口）算每线程的 (最后发件时刻, 最后收件时刻)。

    🔴 必须全历史：owner 案例 —— 7-13 的回复在 24h 窗口外，只看窗口会把已表态的
    线程判成未回复。草稿排除；date_received 混合时区 → _parse_dt 后按真实时刻比。
    查询失败返回空（调用方降级为无线程状态，不阻断报告）。
    """
    if not thread_ids:
        return {}
    tid_ph = ", ".join("?" * len(thread_ids))
    draft_ph = ", ".join("?" * len(_DRAFT_MAILBOXES))
    try:
        rows = conn.execute(
            f"""
            SELECT thread_id, date_received, mailbox FROM email_metadata
             WHERE thread_id IN ({tid_ph})
               AND date_received IS NOT NULL
               AND (mailbox IS NULL OR mailbox NOT IN ({draft_ph}))
            """,
            (*thread_ids, *_DRAFT_MAILBOXES),
        ).fetchall()
    except sqlite3.OperationalError:
        return {}
    out: Dict[str, List[Optional[datetime]]] = {}
    for r in rows:
        d = _parse_dt(r["date_received"])
        if d is None:
            continue
        slot = out.setdefault(r["thread_id"], [None, None])
        idx = 0 if (r["mailbox"] or "") in _SENT_MAILBOXES else 1
        if slot[idx] is None or d > slot[idx]:
            slot[idx] = d
    return {tid: (s[0], s[1]) for tid, s in out.items()}


def _mark_replied(briefs: List[ReportEmailBrief], history: _ThreadHistory) -> None:
    """对每封 brief：同 thread_id 若存在**更晚**的发件箱邮件 → 标 replied=True。

    严格 per-email 语义（发件须晚于**这一封**收件，误杀不可能）—— assembler 的
    「replied 不进 attention」硬闸依赖它。发件时刻来自全历史（_thread_history）。
    """
    for b in briefs:
        sent_dt = history.get(b.thread_id, (None, None))[0]
        recv_dt = _parse_dt(b.date_received)
        if sent_dt and recv_dt and sent_dt >= recv_dt:
            b.replied = True


def is_attention(b: ReportEmailBrief) -> bool:
    """需要用户亲自关注（**fallback 分组用**；主分组由 LLM 在 summarizer 里决定）。

    规则（满足任一即关注，但发件箱/已回复一律排除）：
    - **置顶（is_pinned）**：置顶=重要且通常未处理 → 固定算待办。
    - priority 命中 URGENT_PRIORITY_LABELS 且 action 命中 ACTION_NEEDS_FLAG
      —— 与灵动岛 / 飞书 "urgent" 定义一致，避免把大半邮件都塞进"需关注"。
    发件箱（outbound）是你发出的、不是待办；**已回复（replied）**即使紧急也归"已处理"。
    """
    if b.is_outbound or b.replied:
        return False
    if b.is_pinned:
        return True
    return b.priority in URGENT_PRIORITY_LABELS and b.action_type in ACTION_NEEDS_FLAG


# 预载正文 safety cap（防极端"全勾"导致整窗口线程都塞正文撑爆 token）；不暴露给用户。
_BODY_PRELOAD_SAFETY_CAP = 60


def _solo_key(b: ReportEmailBrief) -> str:
    """无 thread_id 的邮件各自成单封线程的分组 key。"""
    return b.thread_id or f"__solo:{b.internal_id}"


def _preload_bodies(
    db_path: str,
    briefs: List[ReportEmailBrief],
    priorities: set,
    history: _ThreadHistory,
) -> None:
    """就地预载正文（截断）—— **每线程只载最新一封收件**（owner 拍板：最新邮件通常
    带引用历史，够用），且线程须满足：

    - 组内任一邮件 priority ∈ priorities（body_full_priorities 门维持，按线程放宽到
      任一成员命中 —— 紧急线程的最新跟进即使标普通也载它，引用链才完整）；
    - 线程最新一封（**全历史**）不是我方发件 —— 球已踢出，正文价值低，省 token。

    无 thread_id 的邮件各自成单封线程（= 旧 per-email 判定）。safety cap 60 维持；
    正文缺失 / 读失败跳过（保持 None，AI 仍可用 get_email_body 工具按需取全文）。
    """
    groups: Dict[str, List[ReportEmailBrief]] = {}
    order: List[str] = []
    for b in briefs:
        key = _solo_key(b)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(b)
    targets: List[ReportEmailBrief] = []
    for key in order:
        members = groups[key]
        if not any(m.priority in priorities for m in members):
            continue
        sent_dt, inbound_dt = history.get(key, (None, None))
        if sent_dt is not None and (inbound_dt is None or sent_dt >= inbound_dt):
            continue  # 线程最新一封是我方发件 → 不预载
        targets.append(max(members, key=lambda m: _parse_dt(m.date_received) or _EPOCH))
    if not targets:
        return
    if len(targets) > _BODY_PRELOAD_SAFETY_CAP:
        logger.warning(
            f"[report] preload bodies: {len(targets)} worthy threads exceed safety cap "
            f"{_BODY_PRELOAD_SAFETY_CAP}, truncating (其余仅摘要，AI 可按需取正文)"
        )
        targets = targets[:_BODY_PRELOAD_SAFETY_CAP]
    repo = EmailRepository(db_path)
    for b in targets:
        try:
            md = repo.get_body_markdown(b.internal_id, max_chars=_BODY_PRELOAD_CHARS)
            if md:
                b.body_text = md
        except Exception as e:  # noqa: BLE001 — 预载失败不阻断报告
            logger.debug(f"[report] preload body {b.internal_id} failed: {e}")


def is_fyi(b: ReportEmailBrief) -> bool:
    """FYI / 系统通知 / 仅供参考 / 已完结 —— 看过即可。"""
    return b.category in _FYI_CATEGORIES or b.action_type in _FYI_ACTION_TYPES


def group_for_report(
    briefs: List[ReportEmailBrief],
) -> Dict[str, List[ReportEmailBrief]]:
    """分三组（互斥，按 attention → fyi → handled 优先级）。

    发件箱（outbound）不进任何渲染分组 —— 它只用于统计/上下文，不铺成条目。
    """
    attention: List[ReportEmailBrief] = []
    fyi: List[ReportEmailBrief] = []
    handled: List[ReportEmailBrief] = []
    for b in briefs:
        if b.is_outbound:
            continue
        if is_attention(b):
            attention.append(b)
        elif is_fyi(b):
            fyi.append(b)
        else:
            handled.append(b)
    return {"attention": attention, "handled": handled, "fyi": fyi}


@dataclass
class ThreadGroup:
    """线程聚合投影（日报 payload 按事件串联用；不进块 schema，纯 LLM 输入侧）。

    emails = 本次报告带入的该线程邮件（**收发双向混合**，按真实时刻升序）；
    last_sent_at / last_inbound_at 按**全历史**算（不只报告窗口 —— 窗口外的历史
    回复也算「你已表态」），草稿排除。
    """

    thread_id: str
    emails: List[ReportEmailBrief] = field(default_factory=list)
    last_sent_at: Optional[datetime] = None
    last_inbound_at: Optional[datetime] = None

    @property
    def inbound_count(self) -> int:
        return sum(1 for b in self.emails if not b.is_outbound)

    @property
    def outbound_count(self) -> int:
        return sum(1 for b in self.emails if b.is_outbound)

    @property
    def replied_by_me(self) -> bool:
        """线程级软信号：你在该线程回复过（全历史）——对方可能有新进展，只作
        叙事输入（「待跟进」），不做硬过滤。"""
        return self.last_sent_at is not None

    @property
    def latest_is_outbound(self) -> bool:
        """线程最新一封（全历史）是我方发件 → 球已踢出（对方未再来信）。"""
        return self.last_sent_at is not None and (
            self.last_inbound_at is None or self.last_sent_at >= self.last_inbound_at
        )


def build_thread_groups(db_path: str, briefs: List[ReportEmailBrief]) -> List[ThreadGroup]:
    """briefs（含 outbound）→ 按 thread_id 聚合的 ThreadGroup 列表（agentic 日报
    payload 用）。

    组序 = briefs 里首次出现的顺序（inbound 已按 attention / priority 排前，
    outbound-only 组自然殿后）；组内按真实时刻升序。无 thread_id 的邮件各自成组。
    线程状态（last_sent_at / last_inbound_at）按全历史查库；查失败降级为无状态
    （payload 少线程状态标记，不阻断报告）。
    """
    groups: Dict[str, ThreadGroup] = {}
    order: List[str] = []
    for b in briefs:
        key = _solo_key(b)
        g = groups.get(key)
        if g is None:
            g = ThreadGroup(thread_id=b.thread_id)
            groups[key] = g
            order.append(key)
        g.emails.append(b)

    history: _ThreadHistory = {}
    tids = sorted({b.thread_id for b in briefs if b.thread_id})
    if tids:
        try:
            conn = sqlite3.connect(db_path, timeout=30.0)
            conn.row_factory = sqlite3.Row
            try:
                history = _thread_history(conn, tids)
            finally:
                conn.close()
        except sqlite3.Error as e:
            logger.warning(f"[report] build_thread_groups history query failed: {e}")

    out: List[ThreadGroup] = []
    for key in order:
        g = groups[key]
        g.emails.sort(key=lambda m: (_parse_dt(m.date_received) or _EPOCH, m.internal_id))
        g.last_sent_at, g.last_inbound_at = history.get(g.thread_id, (None, None))
        out.append(g)
    return out


def compute_report_counts(briefs: List[ReportEmailBrief]) -> Dict[str, Any]:
    """确定性 counts。收件类指标（total/unread/urgent/ai_handled/replied/flagged）只数
    收件箱侧（非 outbound）；``sent`` = 本窗口你发出的邮件数（outbound）。"""
    inbound = [b for b in briefs if not b.is_outbound]
    total = len(inbound)
    unread = sum(1 for b in inbound if not b.is_read)
    urgent = sum(1 for b in inbound if is_attention(b))
    ai_handled = sum(1 for b in inbound if b.priority)  # priority 非空 = 跑过 LLM
    replied = sum(1 for b in inbound if b.replied)
    flagged = sum(1 for b in inbound if b.is_flagged)
    sent = sum(1 for b in briefs if b.is_outbound)
    by_category: Dict[str, int] = {}
    for b in inbound:
        if b.category:
            by_category[b.category] = by_category.get(b.category, 0) + 1
    return {
        "total": total,
        "unread": unread,
        "urgent": urgent,
        "ai_handled": ai_handled,
        "todo": urgent,
        "replied": replied,
        "flagged": flagged,
        "sent": sent,
        "by_category": by_category,
    }
