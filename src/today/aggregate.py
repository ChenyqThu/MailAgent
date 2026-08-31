"""今日页聚合 —— 只做前端拼不出来的两件事（task 08-27 P4c）。

范围（**有意小**，对 design §十「五节一次算出来」的显式偏离）
------------------------------------------------------------------

design 的前提是「『为什么是今天』需要跨邮件 / 事项 / 日历 / run 四个源判断，前端不该
自己拼」。实地核过之后这个前提只对**一节**成立：

  · 「待回邮件」—— 仓内没有任何端点能按 ``ai_action`` 过滤（``GET /api/emails`` 与
    ``/api/email-views/enriched`` 的 WHERE 都不含 ai 字段），而「已回」判定要跨线程
    **全历史**取最后一次我方发件。前端确实拼不出来 ⇒ 落这里。
  · 「下一个硬时间点」—— 要在「此刻 → 今天日末」这个窗口里跨源取最早一条 ⇒ 落这里。

另外三节 + 「今天的会」**有意不进本端点**：

  · 「临期事项」的「为什么」后端早就写好了 —— ``src/matters/attention.py`` 的
    ``AttentionFact.reason``（「事项今天到期」/「行动项『X』已逾期 N 天」）。
  · 「今天的会」= ``GET /api/calendar/agenda`` 收窄到当天，条目自带解释。
  · 「等你拍板」的四条源（agent run / 提案 / 关注信号 / 行动项派发）在前端已经聚合成熟，
    且四条 SSE 定向失效链（``agent.run.changed`` / ``matter.changed`` /
    ``matter.attention`` / ``matter.item.dispatch.changed``）全挂好了。搬到后端要么把
    实时链重接一遍，要么口径劈成两份（run 的 triage 说明是前端拼的、信号的 reason 是
    后端写的）。

⇒ 端点只出 ``{reply, nextHardPoint}``；其余节前端用现成端点拼，实时失效链白拿。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone, tzinfo
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from loguru import logger

from src.mail.mailbox_semantics import INBOX_LABEL_VARIANTS, sql_in_predicate

# 「已回」判据 **import 复用**，不抄第二份：`thread_history` 是全历史的最后一次我方发件，
# `is_replied_in_thread` 是严格 per-email 的比较。报告的 attention 分组与本节共用它们
# —— 各写一遍就是两个口径（而这个判据本身踩过坑：窗口内比会把窗口外的回复漏掉）。
from src.reports.data import is_replied_in_thread, thread_history

if TYPE_CHECKING:  # pragma: no cover
    from src.config import Config

#: 回看窗口。今日页要的是「还欠着的」，不是全部历史欠账 —— 7 天之外的不该出现在
#: 「今天」这一屏（真要翻旧账去搜索）。
REPLY_WINDOW_DAYS = 7

#: 「球在我这边、且要我写字」的 action 子集。
#:
#: 🔴 是 ``ACTION_NEEDS_FLAG`` 的**真子集**但**不从它推导**：那个集合是「还需要人动手」
#: （含「需要会议」「需要跟进」「等待响应」—— 那些的下一步不是回信）；这一节问的是更窄的
#: 「有没有一封在等我回复」。两者语义不同，推导会让往 ``ACTION_NEEDS_FLAG`` 加一个新的
#: 非回信型 action 时静默混进这一节。子集关系由 ``tests/today/test_reply_section.py`` 钉住。
REPLY_ACTIONS = ("需要回复", "需要决策")

#: 一屏封顶。这一节是「今天先把这几封回了」，不是收件箱第二遍 —— 实测活库 7 天窗口内
#: 未回候选约 40 封，不封顶会把下面四节整个挤出屏幕。按等龄降序取前 N（等最久的优先）。
REPLY_LIMIT = 30

_HOUR_MS = 3600_000
_DAY_MS = 24 * _HOUR_MS


def _parse_dt(raw: Optional[str]) -> Optional[datetime]:
    """ISO（可能带任意 ±HH:MM 偏移或 naive）→ aware datetime（naive 视为 UTC）。

    与 ``src/reports/data._parse_dt`` 同口径：``date_received`` 存的是**各封邮件原始
    本地时区**，只能按真实时刻比。
    """
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def waited_label(waited_ms: int) -> str:
    """等龄 → 一句中文。

    与 ``AttentionFact.reason`` 同一条取向：解释性文案由后端写成中文。前端另有
    locale-aware 的相对时间（``ageLabel``），但那是**时间列**；这一句是「为什么是今天」
    的一半，跟 action 一起出现才成句。
    """
    if waited_ms < _HOUR_MS:
        return "等了不到 1 小时"
    if waited_ms < 2 * _DAY_MS:
        return f"等了 {waited_ms // _HOUR_MS} 小时"
    return f"等了 {waited_ms // _DAY_MS} 天"


def build_reply_section(
    db_path: str,
    *,
    now: Optional[datetime] = None,
    limit: int = REPLY_LIMIT,
) -> List[Dict[str, Any]]:
    """「待回邮件」= 收件箱 + 需要我回信的 action + 线程里我还没回 + 近 7 天。

    口径逐条的实证依据（r11 §G.3 在活库上量过）：

      · **不能用 ``is_read``** —— 这台机器上近 7 天 417 封全是 ``is_read=1``（davmail
        路径下未读态不落地），拿它当判据得到空列表。
      · **不能用 ``is_flagged``** —— 近 30 天只有 14 封。
      · **不能用 ``in_reply_to`` 判「我回了」** —— 发件箱 1494 行里只有 64 行带它（4%）。
        thread 级判定（``is_replied_in_thread``）才是能用的那个。
      · ``ai_action`` 是 ``email_metadata`` 的主表列（v14 从 ``llm_processing.labels_json``
        提升，带部分索引 ``idx_email_ai_action``），可以直接 WHERE，不必 JOIN。

    🔴 ``date_received`` 混合时区（各封原始本地偏移，未归一化）⇒ 窗口比较必须走
    ``julianday()``，**字符串比会错**（同 ``fetch_report_briefs``）。

    **召回率**（2026-08-31 在活库实测）：thread 级「已回」判定依赖发件箱同步覆盖。
    实测发件箱 1494 行，最早 2025-04、最晚当天，逐月连续无断档；收件箱最早 2025-07。
    ⇒ 发件箱覆盖 ⊇ 收件箱覆盖，7 天窗口内的线程全历史都在库里，不存在「老线程被误判成
    未回」的边界。若将来 ``SYNC_FOLDERS`` 收窄发件箱同步范围，这一节会开始把已回的算成
    未回（多显示，不漏显示）—— 是安全方向的降级。
    """
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=REPLY_WINDOW_DAYS)
    inbox_pred, inbox_params = sql_in_predicate("m.mailbox", INBOX_LABEL_VARIANTS)
    action_marks = ", ".join("?" * len(REPLY_ACTIONS))

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            f"""
            SELECT m.internal_id            AS internal_id,
                   COALESCE(m.subject, '')  AS subject,
                   m.sender_name            AS sender_name,
                   m.sender                 AS sender_addr,
                   m.date_received          AS date_received,
                   COALESCE(m.thread_id,'') AS thread_id,
                   m.ai_action              AS ai_action
              FROM email_metadata m
             WHERE m.ai_action IN ({action_marks})
               AND {inbox_pred}
               AND m.date_received IS NOT NULL
               AND julianday(m.date_received) >= julianday(?)
               AND julianday(m.date_received) <  julianday(?)
            """,
            (*REPLY_ACTIONS, *inbox_params, since.isoformat(), now.isoformat()),
        ).fetchall()
        history = thread_history(conn, sorted({r["thread_id"] for r in rows if r["thread_id"]}))
    except sqlite3.OperationalError as exc:
        # 读失败降级成空节（今日页其余四节照常渲染），不把整页打成错误态。
        logger.warning(f"[today] reply section query failed: {exc}")
        return []
    finally:
        conn.close()

    now_ms = int(now.timestamp() * 1000)
    items: List[Dict[str, Any]] = []
    for row in rows:
        if is_replied_in_thread(history, row["thread_id"], row["date_received"]):
            continue
        received = _parse_dt(row["date_received"])
        if received is None:
            # ISO 解析不了 = 排不了序也算不了等龄；「为什么是今天」组装不出的行不渲染，
            # 比渲染一条没有理由的行诚实。
            continue
        waited_ms = max(0, now_ms - int(received.timestamp() * 1000))
        action = (row["ai_action"] or "").strip()
        sender = (row["sender_name"] or "").strip() or (row["sender_addr"] or "").strip()
        items.append(
            {
                "id": f"mail:{int(row['internal_id'])}",
                "source": "mail",
                "title": row["subject"] or "",
                # 「为什么是今天」= 它要我回 + 已经等了多久。组装不出（action 为空）时
                # 返空串 —— 调用方按缺席渲染，**不兜底成一句套话**。
                "why": f"{action} · {waited_label(waited_ms)}" if action else "",
                "meta": sender,
                "atIso": received.astimezone(timezone.utc).isoformat(),
                "waitedMs": waited_ms,
                "actionable": True,
                "link": {"kind": "mail", "internalId": int(row["internal_id"])},
            }
        )

    # 等龄降序 = 收件时刻升序（等最久的在最前）；同刻按 id 稳定。
    items.sort(key=lambda it: (-it["waitedMs"], it["id"]))
    return items[: max(0, limit)]


def _day_end(now: datetime, zone: tzinfo) -> datetime:
    """``zone`` 下「今天」的日末（= 明天 00:00）。"""
    local = now.astimezone(zone)
    tomorrow = (local + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return tomorrow


def build_next_hard_point(
    db_path: str,
    *,
    cfg: Optional["Config"],
    now: Optional[datetime] = None,
    zone: tzinfo = timezone.utc,
) -> Optional[Dict[str, Any]]:
    """今天剩下的时间里最早的一条日程 —— 页头「下一个硬时间点」的那一行。

    🔴 **「硬」没有字段**。``AgendaEntry`` 没有 required/optional 标记，``calendar_event``
    的 ``status``（Confirmed/Tentative/Cancelled）说的是会议状态不是「硬不硬」。这里用
    「今天剩下的最早一条日程」近似，**不假装它是判据**。真要区分硬/软得先有那个字段。

    源取 ``mail`` + ``matter``（会议与截止都是别人在等你的时刻）；**不取 ``agent``** ——
    agent 排程是它自己会跑的事，不构成对人的时间约束。

    返回值直接是一条 ``AgendaEntry``（``build_agenda`` 的条目形状）而不是另造
    ``{atIso, what, source, refId}``：那四个字段 ``AgendaEntry`` 全有（``startIso`` /
    ``title`` / ``source`` / 各源的定位键），而且它是**已有的跨语言契约类型**，前端能把
    它原样喂给现成的 ``useAgendaEntryClick`` 分流 —— 另造一份就是再开一个镜像。
    """
    from src.calendar_sync.agenda import build_agenda

    now = now or datetime.now(timezone.utc)
    window_end = _day_end(now, zone)
    if window_end <= now:
        # 理论上不可能（日末恒 > 此刻），留一道防御：build_agenda 对空窗口是抛 ValueError。
        return None
    try:
        data = build_agenda(
            db_path=db_path,
            cfg=cfg,
            window_start=now,
            window_end=window_end,
            sources=("mail", "matter"),
            zone=zone,
        )
    except (ValueError, sqlite3.OperationalError) as exc:
        logger.warning(f"[today] next hard point query failed: {exc}")
        return None
    entries = data["entries"]
    # build_agenda 已按 (startIso, id) 升序 —— 第一条就是最早的。
    return entries[0] if entries else None


def build_today(
    db_path: str,
    *,
    cfg: Optional["Config"],
    now: Optional[datetime] = None,
    zone: tzinfo = timezone.utc,
    reply_limit: int = REPLY_LIMIT,
) -> Dict[str, Any]:
    """端点的 ``data`` 体：``{reply, nextHardPoint}``。"""
    now = now or datetime.now(timezone.utc)
    return {
        "reply": build_reply_section(db_path, now=now, limit=reply_limit),
        "nextHardPoint": build_next_hard_point(db_path, cfg=cfg, now=now, zone=zone),
    }


__all__ = [
    "REPLY_ACTIONS",
    "REPLY_LIMIT",
    "REPLY_WINDOW_DAYS",
    "build_next_hard_point",
    "build_reply_section",
    "build_today",
    "waited_label",
]
