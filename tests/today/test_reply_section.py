"""今日页「待回邮件」节 + 「已回」判据下沉后的行为不变（task 08-27 P4c）。

建临时 SQLite（SyncStore 建 email_metadata），直接 INSERT fixture 行。无 LLM。

🔴 时区 fixture 是本文件的重点：``date_received`` 存的是**各封邮件原始本地时区**
（混合 -08 / +08 / +00 / naive），字符串比会把 `2026-08-30T23:00:00+08:00`（= UTC 15:00）
排在 `2026-08-30T20:00:00-07:00`（= UTC 次日 03:00）后面。窗口与已回判定都必须按真实时刻。
"""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.llm_agent.schema import ACTION_NEEDS_FLAG, URGENT_PRIORITY_LABELS
from src.mail.sync_store import SyncStore
from src.today.aggregate import (
    REPLY_ACTIONS,
    REPLY_WINDOW_DAYS,
    build_reply_section,
    waited_label,
)

_UTC = timezone.utc
_NOW = datetime(2026, 8, 31, 12, 0, 0, tzinfo=_UTC)


@pytest.fixture
def db(tmp_path: Path) -> Path:
    p = tmp_path / "t.db"
    SyncStore(str(p))
    return p


def _insert(
    db: Path,
    iid: int,
    *,
    subject: str = "S",
    sender: str = "a@x.com",
    sender_name: str = "A",
    date_received: str,
    mailbox: str = "收件箱",
    thread_id: str | None = None,
    ai_action: str | None = "需要回复",
) -> None:
    now = time.time()
    conn = sqlite3.connect(str(db))
    conn.execute(
        """
        INSERT INTO email_metadata
            (internal_id, subject, sender, sender_name, date_received, mailbox,
             thread_id, ai_action, sync_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)
        """,
        (iid, subject, sender, sender_name, date_received, mailbox, thread_id,
         ai_action, now, now),
    )
    conn.commit()
    conn.close()


def _iso(hours_ago: float, offset_hours: int = 0) -> str:
    """``_NOW - hours_ago``，写成 ``offset_hours`` 那个时区的本地串。"""
    tz = timezone(timedelta(hours=offset_hours))
    return (_NOW - timedelta(hours=hours_ago)).astimezone(tz).isoformat()


def _ids(items) -> list[str]:
    return [it["id"] for it in items]


# ============================================================
# 常量下沉（岛模块 → llm_agent.schema）
# ============================================================


class TestActionConstantsSunk:
    def test_island_module_reexports_the_same_objects(self):
        """岛模块的 import 指回新位置后，三个消费方拿到的是**同一个**集合对象。

        这一条守的是「下沉零行为变化」：不是内容相等，是同一份 —— 复制一份出来内容也
        相等，但改一处就漂开了。
        """
        from src.notify import digest_query as dq
        from src.notify import island_dispatch as isl
        from src.reports import data as rdata

        assert isl.ACTION_NEEDS_FLAG is ACTION_NEEDS_FLAG
        assert isl.URGENT_PRIORITY_LABELS is URGENT_PRIORITY_LABELS
        assert dq.ACTION_NEEDS_FLAG is ACTION_NEEDS_FLAG
        assert dq.URGENT_PRIORITY_LABELS is URGENT_PRIORITY_LABELS
        assert rdata.ACTION_NEEDS_FLAG is ACTION_NEEDS_FLAG
        assert rdata.URGENT_PRIORITY_LABELS is URGENT_PRIORITY_LABELS

    def test_members_unchanged(self):
        """下沉时集合内容一字未改（对照下沉前 island_dispatch.py:58-61 的字面量）。"""
        assert ACTION_NEEDS_FLAG == {
            "需要回复", "需要决策", "需要Review", "需要会议", "需要跟进", "等待响应",
        }
        assert URGENT_PRIORITY_LABELS == {"🔴 紧急", "🟡 重要"}

    def test_reply_actions_is_a_strict_subset(self):
        """待回节的 action 集是 ACTION_NEEDS_FLAG 的真子集（但**不由它推导**）。"""
        assert set(REPLY_ACTIONS) < ACTION_NEEDS_FLAG


# ============================================================
# waited_label
# ============================================================


class TestWaitedLabel:
    def test_under_an_hour(self):
        assert waited_label(59 * 60_000) == "等了不到 1 小时"

    def test_hours(self):
        assert waited_label(26 * 3600_000) == "等了 26 小时"

    def test_days_after_two_full_days(self):
        assert waited_label(48 * 3600_000) == "等了 2 天"
        assert waited_label(47 * 3600_000) == "等了 47 小时"


# ============================================================
# 口径
# ============================================================


class TestReplySectionScope:
    def test_only_reply_actions(self, db: Path):
        _insert(db, 1, date_received=_iso(2), ai_action="需要回复")
        _insert(db, 2, date_received=_iso(2), ai_action="需要决策")
        # 同在 ACTION_NEEDS_FLAG 里，但下一步不是回信 —— 有意不进这一节。
        _insert(db, 3, date_received=_iso(2), ai_action="需要会议")
        _insert(db, 4, date_received=_iso(2), ai_action="仅供参考")
        _insert(db, 5, date_received=_iso(2), ai_action=None)
        assert _ids(build_reply_section(str(db), now=_NOW)) == ["mail:1", "mail:2"]

    def test_inbox_only_but_accepts_the_INBOX_variant(self, db: Path):
        _insert(db, 1, date_received=_iso(2), mailbox="收件箱")
        _insert(db, 2, date_received=_iso(2), mailbox="INBOX")
        _insert(db, 3, date_received=_iso(2), mailbox="发件箱")
        _insert(db, 4, date_received=_iso(2), mailbox="存档")
        assert set(_ids(build_reply_section(str(db), now=_NOW))) == {"mail:1", "mail:2"}

    def test_window_is_seven_days(self, db: Path):
        _insert(db, 1, date_received=_iso(REPLY_WINDOW_DAYS * 24 - 1))
        _insert(db, 2, date_received=_iso(REPLY_WINDOW_DAYS * 24 + 1))
        assert _ids(build_reply_section(str(db), now=_NOW)) == ["mail:1"]

    def test_window_bound_compares_real_instants_not_strings(self, db: Path):
        """🔴 混合时区：两封的**本地串**一个像在窗内一个像在窗外，真实时刻正相反。

        窗口下界 = ``_NOW - 7d`` = 2026-08-24T12:00Z。
          · id=1 本地串 `2026-08-24T04:00:00-07:00`（= 11:00Z）→ 真实时刻在窗**外**，
            但按字符串比 '2026-08-24T04…' < '2026-08-24T12…' 也在窗外 —— 不是判别用例。
          · id=2 本地串 `2026-08-24T20:00:00+08:00`（= 12:00Z 整）→ 字符串比看着比下界
            '2026-08-24T12:00:00+00:00' **大**（'20' > '12'），julianday 比是**恰好等于**
            下界 ⇒ 含在半开区间里。
          · id=3 本地串 `2026-08-24T05:00:00-08:00`（= 13:00Z）→ 字符串比看着**小于**
            下界（'05' < '12'）会被误判成窗外；真实时刻在窗内。
        字符串比会漏掉 id=3。
        """
        _insert(db, 1, date_received="2026-08-24T04:00:00-07:00")
        _insert(db, 2, date_received="2026-08-24T20:00:00+08:00")
        _insert(db, 3, date_received="2026-08-24T05:00:00-08:00")
        assert set(_ids(build_reply_section(str(db), now=_NOW))) == {"mail:2", "mail:3"}

    def test_replied_threads_are_excluded(self, db: Path):
        # t-A：收件 5h 前，我 2h 前回了 → 已回。
        _insert(db, 1, date_received=_iso(5), thread_id="t-A")
        _insert(db, 2, date_received=_iso(2), thread_id="t-A", mailbox="发件箱", ai_action=None)
        # t-B：我 5h 前发过，但对方 2h 前又来了一封 → 球在我这边，仍算未回。
        _insert(db, 3, date_received=_iso(5), thread_id="t-B", mailbox="发件箱", ai_action=None)
        _insert(db, 4, date_received=_iso(2), thread_id="t-B")
        # t-C：无发件 → 未回。
        _insert(db, 5, date_received=_iso(3), thread_id="t-C")
        assert set(_ids(build_reply_section(str(db), now=_NOW))) == {"mail:4", "mail:5"}

    def test_replied_judgement_uses_full_history_not_the_window(self, db: Path):
        """我方回复落在 7 天窗口**之外**（这封收件在窗内）—— 仍要算已回。

        这正是 ``thread_history`` 全历史查询存在的理由（报告那边 owner 案例踩过）。
        """
        _insert(db, 1, date_received=_iso(REPLY_WINDOW_DAYS * 24 - 1), thread_id="t-D")
        _insert(
            db, 2,
            date_received=_iso(REPLY_WINDOW_DAYS * 24 - 2),  # 比收件晚 1h, 但仍在窗内
            thread_id="t-D", mailbox="发件箱", ai_action=None,
        )
        assert build_reply_section(str(db), now=_NOW) == []

    def test_replied_compare_is_instant_based_across_timezones(self, db: Path):
        """🔴 收件与发件写在不同时区：字符串比会把「已回」判成「未回」。

        收件本地串 `2026-08-30T22:00:00+08:00`（= 14:00Z）；发件本地串
        `2026-08-30T09:00:00-07:00`（= 16:00Z，确实更晚）。字符串比 '09…' < '22…'
        ⇒ 判成还没回，这一封会错误地留在待回列表里。
        """
        _insert(db, 1, date_received="2026-08-30T22:00:00+08:00", thread_id="t-E")
        _insert(
            db, 2, date_received="2026-08-30T09:00:00-07:00",
            thread_id="t-E", mailbox="发件箱", ai_action=None,
        )
        assert build_reply_section(str(db), now=_NOW) == []


class TestReplySectionShape:
    def test_sorted_by_wait_age_desc(self, db: Path):
        _insert(db, 1, date_received=_iso(2))
        _insert(db, 2, date_received=_iso(30))
        _insert(db, 3, date_received=_iso(10))
        assert _ids(build_reply_section(str(db), now=_NOW)) == ["mail:2", "mail:3", "mail:1"]

    def test_limit_keeps_the_oldest(self, db: Path):
        _insert(db, 1, date_received=_iso(2))
        _insert(db, 2, date_received=_iso(30))
        _insert(db, 3, date_received=_iso(10))
        assert _ids(build_reply_section(str(db), now=_NOW, limit=2)) == ["mail:2", "mail:3"]

    def test_why_and_meta(self, db: Path):
        _insert(db, 1, date_received=_iso(26), ai_action="需要决策", sender_name="张三")
        (item,) = build_reply_section(str(db), now=_NOW)
        assert item["why"] == "需要决策 · 等了 26 小时"
        assert item["meta"] == "张三"
        assert item["actionable"] is True
        assert item["link"] == {"kind": "mail", "internalId": 1}
        assert item["atIso"] == (_NOW - timedelta(hours=26)).isoformat()

    def test_meta_falls_back_to_the_address_when_the_name_is_blank(self, db: Path):
        _insert(db, 1, date_received=_iso(3), sender_name="", sender="b@x.com")
        (item,) = build_reply_section(str(db), now=_NOW)
        assert item["meta"] == "b@x.com"

    def test_unparseable_date_is_dropped_not_rendered_without_a_why(self, db: Path):
        _insert(db, 1, date_received=_iso(3))
        # julianday() 认得的但 fromisoformat 认不得的形状（RFC-2822 残留）。
        _insert(db, 2, date_received="2026-08-30 04:00:00")
        items = build_reply_section(str(db), now=_NOW)
        assert all(it["why"] for it in items), "没有 why 的行不该出现"
