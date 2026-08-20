"""S5 —— 日报/周报的事项汇总（取数层 + matter_item 块 + 装配 + prompt 段）。

判据集中在两处容易静默出错的地方：① 纳入 / 排除判据（多收一条会灌噪音，少收一条会让
「今天有动静的事」从报告里消失）；② 事项挂了不许拖垮报告（flag off / 取数抛异常 /
LLM 编 id 三种降级都要能生出报告）。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from loguru import logger

from src.llm_agent.store import LLMProcessingStore
from src.mail.sync_store import SyncStore
from src.reports import models as m
from src.reports.assembler import assemble_fallback_doc, assemble_report_doc
from src.reports.matter_data import MatterBrief, fetch_matter_briefs, matter_stats
from src.reports.store import ReportStore
from src.reports.summarizer import _matters_block, _parse_draft_fields, ReportDraft
from src.reports.worker import run_report_once

_BJ = timezone(timedelta(hours=8))
_NOW = datetime(2026, 6, 2, 9, 5, 0, tzinfo=_BJ)  # 周二 09:05（与 test_reports 同一时刻）
_WIN_START = _NOW - timedelta(hours=24)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


@pytest.fixture
def db(tmp_path: Path) -> Path:
    p = tmp_path / "t.db"
    SyncStore(str(p))  # email_metadata + matter* + report_agent(种子) + report
    LLMProcessingStore(str(p))
    return p


# ── 建 matter 域测试数据（直接写表：service 层不在本批范围，且这里只读）─────────

def _conn(db: Path) -> sqlite3.Connection:
    c = sqlite3.connect(str(db))
    c.row_factory = sqlite3.Row
    return c


def _matter(
    db: Path,
    public_id: str,
    *,
    title: str = "事项",
    status: str = "active",
    health: str = "unknown",
    priority: str = "p1",
    due_at: int | None = None,
    summary: str | None = None,
    goal_checks: list | None = None,
    archived: bool = False,
    deleted: bool = False,
    last_activity_at: int | None = None,
) -> int:
    now = _ms(_NOW)
    conn = _conn(db)
    cur = conn.execute(
        "INSERT INTO matter (public_id, title, status, health, priority, due_at, "
        "current_summary, goal_checks_json, archived_at, deleted_at, last_activity_at, "
        "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            public_id, title, status, health, priority, due_at, summary,
            json.dumps(goal_checks or []),
            now if archived else None,
            now if deleted else None,
            last_activity_at,
            now, now,
        ),
    )
    conn.commit()
    mid = int(cur.lastrowid)
    conn.close()
    return mid


def _event(
    db: Path, matter_id: int, *, kind: str, happened_at: datetime, payload: dict | None = None
) -> None:
    conn = _conn(db)
    conn.execute(
        "INSERT INTO matter_event (matter_id, kind, happened_at, actor_kind, source, "
        "dedupe_key, payload_json, created_at) VALUES (?,?,?,'user','test',?,?,?)",
        (
            matter_id, kind, _ms(happened_at),
            f"{matter_id}:{kind}:{happened_at.isoformat()}:{time.time_ns()}",
            json.dumps(payload or {}, ensure_ascii=False), _ms(happened_at),
        ),
    )
    conn.commit()
    conn.close()


def _item(db: Path, matter_id: int, *, title: str, status: str = "open", position: int = 0) -> None:
    now = _ms(_NOW)
    conn = _conn(db)
    conn.execute(
        "INSERT INTO matter_item (matter_id, kind, title, position, status, checklist_json, "
        "created_by_kind, created_at, updated_at) VALUES (?,'action',?,?,?,'[]','user',?,?)",
        (matter_id, title, position, status, now, now),
    )
    conn.commit()
    conn.close()


def _stakeholder(db: Path, matter_id: int, *, name: str, waiting: bool = True) -> None:
    now = _ms(_NOW)
    conn = _conn(db)
    conn.execute(
        "INSERT INTO matter_stakeholder (matter_id, person_key, display_name, is_waiting_on, "
        "created_at, updated_at) VALUES (?,?,?,?,?,?)",
        (matter_id, name.lower(), name, 1 if waiting else 0, now, now),
    )
    conn.commit()
    conn.close()


def _attention(db: Path, matter_id: int, *, why: str, severity: str = "warn", state: str = "open") -> None:
    now = _ms(_NOW)
    conn = _conn(db)
    conn.execute(
        "INSERT INTO matter_attention (matter_id, kind, subject_key, state, severity, why, "
        "first_opened_at, last_observed_at) VALUES (?,'wait_overdue',?,?,?,?,?,?)",
        (matter_id, why, state, severity, why, now, now),
    )
    conn.commit()
    conn.close()


def _pending_update(db: Path, matter_id: int) -> None:
    conn = _conn(db)
    conn.execute(
        "INSERT INTO matter_update (matter_id, review_status, anchored_matter_version, "
        "created_by_kind, created_at) VALUES (?,'pending',1,'agent',?)",
        (matter_id, _ms(_NOW)),
    )
    conn.commit()
    conn.close()


def _link_email(db: Path, matter_id: int, internal_id: int, *, hours_ago: float = 2) -> None:
    """挂一封邮件到事项（resource + matter_resource + email_metadata 行）。"""
    now = _ms(_NOW)
    received = (_NOW - timedelta(hours=hours_ago)).isoformat()
    conn = _conn(db)
    conn.execute(
        "INSERT INTO email_metadata (internal_id, subject, sender, date_received, mailbox, "
        "sync_status, created_at, updated_at) VALUES (?,?,?,?,'收件箱','synced',?,?)",
        (internal_id, f"邮件{internal_id}", "a@x.com", received, time.time(), time.time()),
    )
    cur = conn.execute(
        "INSERT INTO resource (kind, provider, external_key, metadata_json, created_at, updated_at) "
        "VALUES ('email','mailagent',?, '{}', ?, ?)",
        (f"email:{internal_id}", now, now),
    )
    conn.execute(
        "INSERT INTO matter_resource (matter_id, resource_id, added_by_kind, created_at, updated_at) "
        "VALUES (?,?,'user',?,?)",
        (matter_id, int(cur.lastrowid), now, now),
    )
    conn.commit()
    conn.close()


def _fetch(db: Path, **kw) -> list[MatterBrief]:
    return fetch_matter_briefs(str(db), _WIN_START, _NOW, **kw)


# ============================================================
# 取数：纳入 / 排除判据
# ============================================================

class TestFetchSelection:
    def test_window_event_pulls_in_otherwise_quiet_matter(self, db: Path):
        # monitoring 不在「推进中」集里，但窗口内有动静 → 该进报告。
        mid = _matter(db, "MAT-0001", status="monitoring")
        _event(db, mid, kind="matter_updated", happened_at=_NOW - timedelta(hours=3),
               payload={"changes": [{"field": "status", "from": "active", "to": "monitoring"}]})
        assert [b.public_id for b in _fetch(db)] == ["MAT-0001"]

    def test_active_status_pulls_in_without_any_activity(self, db: Path):
        _matter(db, "MAT-0002", status="waiting")
        assert [b.public_id for b in _fetch(db)] == ["MAT-0002"]

    def test_quiet_planned_matter_is_excluded(self, db: Path):
        # 计划中 + 无动静 + 无到期 + 无信号 = 报告里提它只是噪音。
        _matter(db, "MAT-0003", status="planned")
        assert _fetch(db) == []

    def test_due_soon_and_overdue_pull_in(self, db: Path):
        _matter(db, "MAT-0004", status="planned", due_at=_ms(_NOW + timedelta(days=2)))
        _matter(db, "MAT-0005", status="planned", due_at=_ms(_NOW - timedelta(days=5)))
        _matter(db, "MAT-0006", status="planned", due_at=_ms(_NOW + timedelta(days=30)))
        assert {b.public_id for b in _fetch(db)} == {"MAT-0004", "MAT-0005"}

    def test_open_signal_and_pending_update_pull_in(self, db: Path):
        a = _matter(db, "MAT-0007", status="planned")
        _attention(db, a, why="等待超期")
        b = _matter(db, "MAT-0008", status="planned")
        _pending_update(db, b)
        c = _matter(db, "MAT-0009", status="planned")
        _attention(db, c, why="已解除", state="resolved")  # 非 open → 不算信号
        assert {x.public_id for x in _fetch(db)} == {"MAT-0007", "MAT-0008"}

    def test_archived_and_deleted_never_appear(self, db: Path):
        _matter(db, "MAT-0010", status="active", archived=True)
        _matter(db, "MAT-0011", status="active", deleted=True)
        assert _fetch(db) == []

    def test_cap_logs_how_many_were_dropped(self, db: Path):
        for i in range(5):
            _matter(db, f"MAT-01{i:02d}", status="active")
        records: list = []
        sink = logger.add(lambda msg: records.append(msg.record), level="INFO")
        try:
            briefs = _fetch(db, limit=2)
        finally:
            logger.remove(sink)
        assert len(briefs) == 2
        # 🔴 silent truncation 会让报告读起来像「覆盖全了」——必须留痕说明丢了几条。
        assert any("未纳入 3 条" in r["message"] for r in records), records

    def test_sort_is_priority_then_signal_then_due(self, db: Path):
        _matter(db, "MAT-A", status="active", priority="p2")
        b = _matter(db, "MAT-B", status="active", priority="p2")
        _attention(db, b, why="卡住了")
        _matter(db, "MAT-C", status="active", priority="p0")
        _matter(db, "MAT-D", status="active", priority="p2",
                due_at=_ms(_NOW + timedelta(days=1)))
        assert [x.public_id for x in _fetch(db)] == ["MAT-C", "MAT-B", "MAT-D", "MAT-A"]


# ============================================================
# 取数：每条 brief 携带什么
# ============================================================

class TestFetchProjection:
    def test_brief_carries_progress_actions_waiting_signals_and_emails(self, db: Path):
        mid = _matter(
            db, "MAT-0100", title="合同签署", status="waiting", health="at_risk", priority="p0",
            due_at=_ms(_NOW + timedelta(days=2)), summary="等对方法务回签",
            goal_checks=[{"t": "双签", "done": False}, {"t": "初稿", "done": True}],
        )
        _item(db, mid, title="催一下法务", position=0)
        _item(db, mid, title="已完成的事", status="done", position=1)
        _stakeholder(db, mid, name="张三")
        _stakeholder(db, mid, name="李四", waiting=False)
        _attention(db, mid, why="等待超期 6 天", severity="critical")
        _pending_update(db, mid)
        _link_email(db, mid, 53675, hours_ago=2)
        _link_email(db, mid, 53680, hours_ago=100)  # 窗口外 → 不算本窗口往来

        (b,) = _fetch(db)
        assert (b.title, b.status, b.health, b.priority) == ("合同签署", "waiting", "at_risk", "p0")
        assert b.current_summary == "等对方法务回签"
        assert (b.goal_done, b.goal_total) == (1, 2)
        assert b.open_actions == ["催一下法务"]  # done 的不算未完成
        assert b.waiting_on == ["张三"]  # 只有 is_waiting_on 的
        assert b.signals == ["等待超期 6 天"] and b.signal_count == 1
        assert b.pending_updates == 1
        assert b.email_ids == [53675]  # 🔴 窗口外那封不进

    def test_event_lines_read_like_sentences(self, db: Path):
        mid = _matter(db, "MAT-0101", status="active")
        _event(db, mid, kind="matter_updated", happened_at=_NOW - timedelta(hours=5),
               payload={"changes": [{"field": "status", "from": "active", "to": "waiting"}]})
        _event(db, mid, kind="item_updated", happened_at=_NOW - timedelta(hours=4),
               payload={"title": "发合同", "changes": [{"field": "status", "from": "open", "to": "done"}]})
        _event(db, mid, kind="update_accepted", happened_at=_NOW - timedelta(hours=3))
        _event(db, mid, kind="resource_access_policy_changed", happened_at=_NOW - timedelta(hours=2))
        (b,) = _fetch(db)
        assert b.event_lines == [
            "status active → waiting",
            "完成行动项「发合同」",
            "采纳了一条跟进提案",
        ]  # 技术性事件（access_policy）讲不出内容 → 不占额度

    def test_events_outside_window_do_not_leak_in(self, db: Path):
        mid = _matter(db, "MAT-0102", status="active")
        _event(db, mid, kind="update_accepted", happened_at=_NOW - timedelta(days=3))
        (b,) = _fetch(db)
        assert b.event_lines == [] and b.has_window_activity is False

    def test_matter_stats_counts_inflight_and_needs_decision(self, db: Path):
        assert matter_stats([]) == {"matters_active": 0, "matters_attention": 0}
        briefs = [
            MatterBrief(public_id="A", title="a", status="active", health="unknown", priority="p1"),
            MatterBrief(public_id="B", title="b", status="monitoring", health="unknown",
                        priority="p1", signal_count=2),
            MatterBrief(public_id="C", title="c", status="waiting", health="unknown",
                        priority="p1", pending_updates=1),
        ]
        assert matter_stats(briefs) == {"matters_active": 2, "matters_attention": 2}


# ============================================================
# 块 + 装配
# ============================================================

def _brief(public_id: str, **kw) -> MatterBrief:
    base = dict(title="事项", status="active", health="unknown", priority="p1")
    base.update(kw)
    return MatterBrief(public_id=public_id, **base)  # type: ignore[arg-type]


class TestMatterItemBlock:
    def test_builder_keeps_raw_enums_and_omits_empty(self):
        b = m.matter_item(
            public_id="MAT-0012", title="X", status="waiting", health="at_risk", priority="p0"
        )
        assert b["type"] == "matter_item" and b["status"] == "waiting"  # 原始枚举, 不本地化
        assert b["deeplink"] == "mailagent://matter/MAT-0012"
        for absent in ("due_at", "summary", "progress", "waiting_on", "next_action", "signal_count"):
            assert absent not in b

    def test_zero_total_progress_is_omitted(self):
        b = m.matter_item(
            public_id="MAT-1", title="X", status="active", health="unknown", priority="p1",
            progress={"done": 0, "total": 0},
        )
        assert "progress" not in b  # 0/0 的进度条只是噪音

    def test_block_type_is_in_public_vocabulary(self):
        assert "matter_item" in m.REPORT_BLOCK_TYPE_SET
        assert m.validate_report_blocks([{"type": "matter_item", "public_id": "MAT-1"}])


class TestAssembleMatterSection:
    def _doc(self, draft: ReportDraft, briefs) -> list:
        return assemble_report_doc(
            draft=draft, briefs=[], counts={"total": 3}, agent_id="a", cadence="daily",
            report_date="2026-06-02", window_start="s", window_end="e", generated_at="g",
            model="mk", now=_NOW, matter_briefs=briefs,
        ).blocks

    def test_section_sits_after_key_points_and_before_email_groups(self):
        draft = ReportDraft(
            overview="ov", key_points=["kp"],
            sections=[{"id": "attention", "title": "需要你关注", "icon": "alert",
                       "intro": "i", "email_refs": []}],
            matter_refs=["MAT-1"], matter_summary="主线推进了一步",
        )
        types = [b["type"] for b in self._doc(draft, [_brief("MAT-1")])]
        assert types.index("key_points") < types.index("matter_item")
        # 事项区自己的 section 在前、邮件分组的 section 在后（先看事，再看料）。
        sections = [i for i, b in enumerate(types) if b == "section"]
        assert sections[0] < types.index("matter_item") < sections[1]

    def test_hallucinated_public_id_is_dropped(self):
        draft = ReportDraft(matter_refs=["MAT-9999", "MAT-2"], matter_summary="s")
        ids = [
            b["public_id"] for b in self._doc(draft, [_brief("MAT-1"), _brief("MAT-2")])
            if b["type"] == "matter_item"
        ]
        assert ids == ["MAT-2"]  # 编造的 id 不出现，真实的照渲染

    def test_all_refs_hallucinated_falls_back_to_code_order(self):
        draft = ReportDraft(matter_refs=["MAT-9999"], matter_summary="s")
        ids = [
            b["public_id"] for b in self._doc(draft, [_brief("MAT-1"), _brief("MAT-2")])
            if b["type"] == "matter_item"
        ]
        assert ids == ["MAT-1", "MAT-2"]

    def test_no_briefs_means_no_section_at_all(self):
        draft = ReportDraft(matter_refs=["MAT-1"], matter_summary="凭空捏造的事项汇总")
        blocks = self._doc(draft, [])
        assert not any(b["type"] == "matter_item" for b in blocks)
        assert not any(b.get("id") == "matters" for b in blocks)  # 不是空框, 是整段不出现

    def test_stat_row_gains_two_cells_only_when_matters_present(self):
        draft = ReportDraft()
        with_matters = next(b for b in self._doc(draft, [_brief("MAT-1")]) if b["type"] == "stat_row")
        keys = [s["key"] for s in with_matters["stats"]]
        assert keys[-2:] == ["matters_active", "matters_attention"]
        without = next(b for b in self._doc(draft, []) if b["type"] == "stat_row")
        assert all(not k.startswith("matters_") for k in (s["key"] for s in without["stats"]))

    def test_fallback_doc_also_carries_matters(self):
        doc = assemble_fallback_doc(
            briefs=[], counts={"total": 0}, agent_id="a", cadence="daily",
            report_date="2026-06-02", window_start="s", window_end="e", generated_at="g",
            model="", now=_NOW, matter_briefs=[_brief("MAT-1")],
        )
        assert any(b["type"] == "matter_item" for b in doc.blocks)


# ============================================================
# prompt / draft 解析
# ============================================================

class TestMatterPrompt:
    def test_block_is_empty_without_matters(self):
        assert _matters_block([], _NOW) == ""

    def test_block_states_facts_including_linked_email_ids(self):
        text = _matters_block(
            [_brief("MAT-1", title="合同", status="waiting", priority="p0",
                    current_summary="等回签", goal_done=1, goal_total=3,
                    event_lines=["完成行动项「发合同」"], open_actions=["催法务"],
                    waiting_on=["张三"], signals=["等待超期"], signal_count=1,
                    pending_updates=1, email_ids=[53675])],
            _NOW,
        )
        assert "MAT-1 合同（waiting / unknown / p0）" in text
        assert "1/3" in text and "催法务" in text and "张三" in text
        assert "53675" in text  # 事项↔邮件的连接点

    def test_no_activity_is_stated_explicitly(self):
        # 「本窗口动静：无」是月报判断长期停滞的唯一依据，不能省略成缺字段。
        assert "本窗口动静：无" in _matters_block([_brief("MAT-1")], _NOW)

    def test_draft_parses_matter_digest_and_filters_junk(self):
        parsed = _parse_draft_fields(
            {"matter_digest": {"summary": " 汇总 ", "matter_refs": ["MAT-1", "", 7, " MAT-2 "]}}
        )
        assert parsed["matter_summary"] == "汇总"
        assert parsed["matter_refs"] == ["MAT-1", "MAT-2"]

    def test_draft_without_digest_defaults_to_empty(self):
        parsed = _parse_draft_fields({"headline": "h"})
        assert parsed["matter_summary"] == "" and parsed["matter_refs"] == []

    def test_tool_schema_exposes_matter_digest(self):
        from src.reports.summarizer import REPORT_TOOL_SCHEMA

        digest = REPORT_TOOL_SCHEMA["input_schema"]["properties"]["matter_digest"]
        assert digest["properties"]["matter_refs"]["items"]["type"] == "string"


# ============================================================
# worker 接线 + 降级
# ============================================================

def _seed_email(db: Path, iid: int = 1) -> None:
    now = time.time()
    conn = _conn(db)
    conn.execute(
        "INSERT INTO email_metadata (internal_id, subject, sender, date_received, mailbox, "
        "sync_status, created_at, updated_at) VALUES (?,?,?,?,'收件箱','synced',?,?)",
        (iid, "S", "a@x.com", (_NOW - timedelta(hours=1)).isoformat(), now, now),
    )
    conn.commit()
    conn.close()


class TestWorkerWiring:
    def test_daily_report_carries_matter_blocks(self, db: Path):
        _seed_email(db)
        mid = _matter(db, "MAT-0200", title="主线", status="active", priority="p0")
        _item(db, mid, title="下一步动作")
        store = ReportStore(str(db))
        seen: dict = {}

        async def spy(**kw):
            seen["matter_briefs"] = kw.get("matter_briefs", "MISSING")
            return ReportDraft(headline="h", overview="ov", model="mk",
                               matter_refs=["MAT-0200"], matter_summary="推进中")

        rid = asyncio.run(run_report_once(store=store, db_path=str(db),
                                          agent=store.get_agent("daily_email_digest"),
                                          now=_NOW, agentic_fn=spy))
        assert [b.public_id for b in seen["matter_briefs"]] == ["MAT-0200"]
        blocks = json.loads(store.get_report(rid)["blocks_json"])["blocks"]
        item = next(b for b in blocks if b["type"] == "matter_item")
        assert item["public_id"] == "MAT-0200" and item["next_action"] == "下一步动作"

    def test_matter_fetch_exception_still_produces_report(
        self, db: Path, monkeypatch: pytest.MonkeyPatch
    ):
        _seed_email(db)
        store = ReportStore(str(db))

        def boom(*a, **kw):
            raise RuntimeError("matter db exploded")

        monkeypatch.setattr("src.reports.worker.fetch_matter_briefs", boom)

        async def fake(**kw):
            assert kw["matter_briefs"] == []
            return ReportDraft(headline="h", overview="ov", model="mk")

        rid = asyncio.run(run_report_once(store=store, db_path=str(db),
                                          agent=store.get_agent("daily_email_digest"),
                                          now=_NOW, agentic_fn=fake))
        assert store.get_report(rid)["status"] == "ready"

    def test_weekly_takes_matters_from_db_not_from_daily_text(self, db: Path):
        """🔴 周报的事项数据必须直接来自事项库的窗口内变化，不是日报文本的二次转述。"""
        store = ReportStore(str(db))
        for d in ["2026-05-27", "2026-05-28"]:
            rid = f"daily_email_digest:daily:{d}"
            store.create_report(report_id=rid, agent_id="daily_email_digest", cadence="daily",
                                report_date=d, window_start="s", window_end="e")
            store.finish_report(rid, status="ready",
                                blocks_json=json.dumps([{"type": "overview", "text": "概览"}]),
                                counts_json=json.dumps({"total": 3}), headline=d)
        mid = _matter(db, "MAT-0300", title="周主线", status="active")
        # 事件落在上周窗口（[5-26, 6-01]）内，且**没有**出现在任何一份日报文本里。
        _event(db, mid, kind="matter_updated",
               happened_at=datetime(2026, 5, 28, 10, 0, tzinfo=_BJ),
               payload={"changes": [{"field": "status", "from": "planned", "to": "active"}]})
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        seen: dict = {}

        async def spy(**kw):
            seen["matter_briefs"] = kw.get("matter_briefs", "MISSING")
            return ReportDraft(headline="周报", overview="ov", model="mk",
                               matter_refs=["MAT-0300"])

        rid = asyncio.run(run_report_once(store=store, db_path=str(db),
                                          agent=store.get_agent("weekly_email_digest"),
                                          now=_NOW, aggregate_fn=spy))
        briefs = seen["matter_briefs"]
        assert [b.public_id for b in briefs] == ["MAT-0300"]
        assert briefs[0].event_lines == ["status planned → active"]
        blocks = json.loads(store.get_report(rid)["blocks_json"])["blocks"]
        assert any(b["type"] == "matter_item" for b in blocks)
