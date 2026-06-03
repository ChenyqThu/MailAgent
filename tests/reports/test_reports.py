"""Tests for src.reports（报告 Agent 系统：models / data / store / assembler / summarizer / worker）。

建临时 SQLite（SyncStore 建 email_metadata + 种子 agent，LLMProcessingStore 建
llm_processing），直接 INSERT fixture rows。LLM 全 mock（不烧 token）。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src.llm_agent.client import LLMResult
from src.llm_agent.store import LLMProcessingStore
from src.mail.sync_store import SyncStore
from src.reports import data as rdata
from src.reports import models as m
from src.reports.assembler import assemble_fallback_doc, assemble_report_doc
from src.reports.store import ReportStore
from src.reports.summarizer import REPORT_TOOL_SCHEMA, ReportDraft, _parse
from src.reports.agent_tools import build_report_tools
from src.reports.worker import (
    _daily_window,
    _due_hour,
    _period_bounds,
    _sum_counts,
    run_report_once,
)

_BJ = timezone(timedelta(hours=8))
_NOW = datetime(2026, 6, 2, 9, 5, 0, tzinfo=_BJ)  # 周二 09:05


@pytest.fixture
def db(tmp_path: Path) -> Path:
    p = tmp_path / "t.db"
    SyncStore(str(p))            # email_metadata + report_agent(种子) + report
    LLMProcessingStore(str(p))   # llm_processing
    return p


def _iso(hours_ago: float) -> str:
    return (_NOW - timedelta(hours=hours_ago)).isoformat()


def _insert(
    db: Path,
    iid: int,
    *,
    subject: str = "S",
    sender: str = "a@x.com",
    sender_name: str = "A",
    hours_ago: float = 1,
    is_read: int = 0,
    is_flagged: int = 0,
    is_pinned: int = 0,
    mailbox: str = "收件箱",
    thread_id: str | None = None,
    notion_page_id: str | None = "page-x",
    labels: dict | None = None,
) -> None:
    now = time.time()
    conn = sqlite3.connect(str(db))
    conn.execute(
        """
        INSERT INTO email_metadata
            (internal_id, subject, sender, sender_name, date_received, mailbox,
             is_read, is_flagged, is_pinned, thread_id, sync_status, notion_page_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?, ?)
        """,
        (iid, subject, sender, sender_name, _iso(hours_ago), mailbox,
         is_read, is_flagged, is_pinned, thread_id, notion_page_id, now, now),
    )
    if labels is not None:
        conn.execute(
            "INSERT INTO llm_processing (internal_id, status, labels_json, created_at, updated_at) "
            "VALUES (?, 'success', ?, ?, ?)",
            (iid, json.dumps(labels, ensure_ascii=False), now, now),
        )
    conn.commit()
    conn.close()


def _labels(priority="🟡 重要", action="需要回复", category="📊 项目管理", ai_summary="摘要"):
    return {"priority": priority, "action_type": action, "category": category, "ai_summary": ai_summary}


# ============================================================
# models
# ============================================================

class TestModels:
    def test_notion_url(self):
        assert m.notion_url("ab-cd-ef") == "https://www.notion.so/abcdef"
        assert m.notion_url(None) is None

    def test_email_item_omits_empty_keeps_source(self):
        b = m.email_item(internal_id=7, subject="S", sender_name="A", time="t")
        assert b["type"] == "email_item" and b["internal_id"] == 7
        assert "category" not in b and "priority" not in b  # 空字段省略
        assert b["source"]["app_deeplink"] == "mailagent://email/7"
        assert b["source"]["notion_url"] is None

    def test_section_summary_optional(self):
        # 无 summary → 省略（向后兼容）；有 summary → 带上。
        assert "summary" not in m.section("a", "T")
        s = m.section("a", "T", summary="本组 [x](#email-1) 待办。")
        assert s["summary"] == "本组 [x](#email-1) 待办。"

    def test_reportdoc_to_dict_and_headline(self):
        doc = m.ReportDoc(
            agent_id="a", cadence="daily", report_date="2026-06-02",
            window_start="s", window_end="e", generated_at="g", model="mk",
            blocks=[m.header("邮件日报"), m.overview("今天 3 封紧急。"), m.divider()],
        )
        d = doc.to_dict()
        assert d["version"] == 1 and d["window"] == {"start": "s", "end": "e"}
        assert d["cadence"] == "daily" and len(d["blocks"]) == 3
        assert doc.derive_headline() == "今天 3 封紧急。"  # overview 优先


# ============================================================
# data
# ============================================================

class TestData:
    def test_fetch_reads_labels_and_sender(self, db: Path):
        _insert(db, 1, subject="预算", sender="gary@x.com", sender_name="Gary", labels=_labels())
        briefs = rdata.fetch_report_briefs(str(db), now=_NOW)
        assert len(briefs) == 1
        b = briefs[0]
        assert b.internal_id == 1 and b.subject == "预算"
        assert b.sender_addr == "gary@x.com" and b.sender_name == "Gary"
        assert b.priority == "🟡 重要" and b.action_type == "需要回复"
        assert b.notion_page_id == "page-x"

    def test_fetch_window_filter(self, db: Path):
        _insert(db, 1, hours_ago=1)     # 窗口内
        _insert(db, 2, hours_ago=48)    # 窗口外（24h）
        briefs = rdata.fetch_report_briefs(str(db), window_hours=24, now=_NOW)
        assert [b.internal_id for b in briefs] == [1]

    def test_grouping_rules(self, db: Path):
        # attention: 🟡重要 + 需要回复
        _insert(db, 1, labels=_labels(priority="🟡 重要", action="需要回复"))
        # fyi: 仅供参考
        _insert(db, 2, labels=_labels(priority="🟢 一般", action="仅供参考", category="🌐 外部沟通"))
        # fyi: 系统通知
        _insert(db, 3, labels=_labels(priority="🟢 一般", action="需要回复", category="🔔 系统通知"))
        # handled: 🟢一般 + 需要回复（非 urgent priority → 非 attention；非 fyi）
        _insert(db, 4, labels=_labels(priority="🟢 一般", action="需要回复", category="📊 项目管理"))
        # 🔴紧急 + 仅供参考 → fyi（不是 attention，因为 action 非 NEEDS_FLAG）
        _insert(db, 5, labels=_labels(priority="🔴 紧急", action="仅供参考", category="📊 项目管理"))
        briefs = rdata.fetch_report_briefs(str(db), now=_NOW)
        g = rdata.group_for_report(briefs)
        assert {b.internal_id for b in g["attention"]} == {1}
        assert {b.internal_id for b in g["fyi"]} == {2, 3, 5}
        assert {b.internal_id for b in g["handled"]} == {4}
        # 互斥：每封只在一组
        allids = [b.internal_id for grp in g.values() for b in grp]
        assert sorted(allids) == [1, 2, 3, 4, 5]

    def test_counts(self, db: Path):
        _insert(db, 1, is_read=0, labels=_labels(priority="🟡 重要", action="需要回复"))  # attention+unread
        _insert(db, 2, is_read=1, labels=_labels(priority="🟢 一般", action="仅供参考"))  # read
        _insert(db, 3, is_read=0, labels=None)  # 无 label → ai_handled 不计
        c = rdata.compute_report_counts(rdata.fetch_report_briefs(str(db), now=_NOW))
        assert c["total"] == 3 and c["unread"] == 2
        assert c["urgent"] == 1 and c["todo"] == 1
        assert c["ai_handled"] == 2  # 1,2 有 priority；3 无

    def test_sent_brought_in_replied_derived(self, db: Path):
        # 收件箱：紧急 + 需回复（thread t1）
        _insert(db, 1, thread_id="t1", labels=_labels(priority="🔴 紧急", action="需要回复"))
        # 同 thread 的发件箱回复（更晚 0.5h）→ 推出 replied；发件箱带入但不算收件条目
        _insert(db, 2, mailbox="发件箱", thread_id="t1", hours_ago=0.5)
        briefs = rdata.fetch_report_briefs(str(db), now=_NOW)
        inbound = [b for b in briefs if not b.is_outbound]
        outbound = [b for b in briefs if b.is_outbound]
        assert [b.internal_id for b in inbound] == [1]   # 发件箱不算收件条目
        assert [b.internal_id for b in outbound] == [2]  # 发件箱带入（供统计/上下文）
        assert inbound[0].replied is True                # 同 thread 有更晚发件箱邮件 → 已回复
        assert rdata.is_attention(inbound[0]) is False   # 已回复 → 不再算待办
        c = rdata.compute_report_counts(briefs)
        assert c["replied"] == 1 and c["urgent"] == 0
        assert c["sent"] == 1 and c["total"] == 1        # total 只数收件；sent 数发件箱

    def test_pinned_always_included(self, db: Path):
        # 置顶邮件在窗口外（48h 前）+ 非 urgent → 仍固定带入且算「需关注」
        _insert(db, 1, hours_ago=48, is_pinned=1,
                labels=_labels(priority="🟢 一般", action="仅供参考"))
        # 普通窗口外邮件（无置顶）→ 不带入
        _insert(db, 2, hours_ago=48, labels=_labels())
        briefs = rdata.fetch_report_briefs(str(db), window_hours=24, now=_NOW)
        assert {b.internal_id for b in briefs} == {1}    # 仅置顶的固定带入
        assert briefs[0].is_pinned is True
        assert rdata.is_attention(briefs[0]) is True     # 置顶（未回复）→ 需关注
        # 已回复的置顶不再算待办
        briefs[0].replied = True
        assert rdata.is_attention(briefs[0]) is False

    def test_flag_status_in_brief(self, db: Path):
        _insert(db, 1, is_flagged=1, labels=_labels())
        b = rdata.fetch_report_briefs(str(db), now=_NOW)[0]
        assert b.is_flagged is True and b.replied is False


# ============================================================
# store
# ============================================================

class TestStore:
    def test_agent_seed_and_patch_whitelist(self, db: Path):
        store = ReportStore(str(db))
        a = store.get_agent("daily_email_digest")
        assert a is not None and a["title"] == "邮件日报" and a["enabled"] == 0
        upd = store.update_agent("daily_email_digest",
                                 {"enabled": 1, "prompt": "P", "id": "HACK", "evil": 1})
        assert upd["enabled"] == 1 and upd["prompt"] == "P"
        assert upd["id"] == "daily_email_digest"  # 主键不被 patch

    def test_report_crud_and_list_excludes_blocks(self, db: Path):
        store = ReportStore(str(db))
        rid = "daily_email_digest:daily:2026-06-02"
        store.create_report(report_id=rid, agent_id="daily_email_digest", cadence="daily",
                            report_date="2026-06-02", window_start="s", window_end="e")
        assert store.get_report(rid)["status"] == "generating"
        store.finish_report(rid, status="ready", blocks_json='[{"type":"header"}]',
                           counts_json='{"total":1}', headline="H", input_tokens=10, output_tokens=5)
        got = store.get_report(rid)
        assert got["status"] == "ready" and got["headline"] == "H" and got["input_tokens"] == 10
        lst = store.list_reports(cadence="daily")
        assert len(lst) == 1 and "blocks_json" not in lst[0]  # 列表不返重字段


# ============================================================
# assembler
# ============================================================

class TestAssembler:
    def _briefs(self):
        return [
            rdata.ReportEmailBrief(1, "S1", "A", "a@x.com", _iso(1), "📊 项目管理", "🟡 重要", "需要回复", "sum1", False, "pg1"),
            rdata.ReportEmailBrief(2, "S2", "B", "b@x.com", _iso(2), "🔔 系统通知", "🟢 一般", "仅供参考", "", True, "pg2"),
        ]

    def test_assemble_drops_hallucinated_and_dedups(self):
        draft = ReportDraft(
            headline="h", overview="ov",
            sections=[
                {"id": "attention", "title": "关注", "icon": "alert", "intro": "i", "email_refs": [1, 999, 1]},
                {"id": "handled", "title": "已处理", "icon": "check", "intro": "", "email_refs": [2]},
            ],
            key_points=["kp"], highlights=[{"tone": "warn", "title": "T", "body": "B"}], model="mk",
        )
        doc = assemble_report_doc(draft=draft, briefs=self._briefs(), counts={"total": 2, "urgent": 1},
                                  agent_id="a", cadence="daily", report_date="2026-06-02",
                                  window_start="s", window_end="e", generated_at="g", model="mk", now=_NOW)
        d = doc.to_dict()
        eids = [b["internal_id"] for b in d["blocks"] if b["type"] == "email_item"]
        assert eids == [1, 2]  # 999 幻觉丢弃, 1 不重复
        sr = next(b for b in d["blocks"] if b["type"] == "stat_row")
        assert {s["key"]: s["value"] for s in sr["stats"]}["urgent"] == 1  # counts 来自代码
        assert any(b["type"] == "callout" for b in d["blocks"])
        assert any(b["type"] == "key_points" for b in d["blocks"])

    def test_assemble_summary_sanitizes_hallucinated_links(self):
        # summary 里真实 #email-1 保留跳转，幻觉 #email-999 降级为纯锚文本。
        draft = ReportDraft(
            headline="h", overview="ov",
            sections=[{
                "id": "attention", "title": "关注", "icon": "alert", "intro": "i",
                "summary": "见 [真实邮件](#email-1) 和 [假邮件](#email-999)，注意**截止**。",
                "email_refs": [1],
            }],
            model="mk",
        )
        doc = assemble_report_doc(draft=draft, briefs=self._briefs(), counts={"total": 2},
                                  agent_id="a", cadence="daily", report_date="2026-06-02",
                                  window_start="s", window_end="e", generated_at="g", model="mk", now=_NOW)
        sec = next(b for b in doc.blocks if b["type"] == "section")
        assert "[真实邮件](#email-1)" in sec["summary"]   # 命中真实 → 保留跳转
        assert "[假邮件](#email-999)" not in sec["summary"]  # 幻觉 → 去链接
        assert "假邮件" in sec["summary"]                  # 锚文本保留
        assert "**截止**" in sec["summary"]                # 其他标记不动

    def test_assemble_skips_empty_section(self):
        draft = ReportDraft(headline="h", overview="",
                            sections=[{"id": "x", "title": "空", "email_refs": [999], "intro": ""}])
        doc = assemble_report_doc(draft=draft, briefs=self._briefs(), counts={},
                                  agent_id="a", cadence="daily", report_date="2026-06-02",
                                  window_start="s", window_end="e", generated_at="g", model="mk", now=_NOW)
        assert not any(b["type"] == "section" for b in doc.blocks)  # 空 section 跳过

    def test_fallback_doc_groups_and_caps(self):
        briefs = self._briefs()
        doc = assemble_fallback_doc(briefs=briefs, counts={"total": 2, "urgent": 1, "unread": 1},
                                    agent_id="a", cadence="daily", report_date="2026-06-02",
                                    window_start="s", window_end="e", generated_at="g", model="", now=_NOW)
        titles = [b["title"] for b in doc.blocks if b["type"] == "section"]
        assert "需要你亲自关注" in titles  # brief 1 是 attention

    def test_outbound_not_rendered_even_if_referenced(self):
        # 发件箱 brief（is_outbound）即使被 LLM 放进 email_refs，也不渲染成条目。
        inbound = rdata.ReportEmailBrief(1, "收到的", "A", "a@x.com", _iso(1),
                                         "📊 项目管理", "🟡 重要", "需要回复", "", False, "pg1")
        outbound = rdata.ReportEmailBrief(3, "我发的", "Me", "me@x.com", _iso(0.5),
                                          "", "", "", "", True, None, is_outbound=True)
        draft = ReportDraft(headline="h", overview="",
                            sections=[{"id": "a", "title": "T", "email_refs": [1, 3]}])
        doc = assemble_report_doc(draft=draft, briefs=[inbound, outbound], counts={},
                                  agent_id="a", cadence="daily", report_date="2026-06-02",
                                  window_start="s", window_end="e", generated_at="g",
                                  model="mk", now=_NOW)
        eids = [b["internal_id"] for b in doc.blocks if b["type"] == "email_item"]
        assert eids == [1]  # 发件箱 id=3 被丢弃（不在 brief_map）

    def test_stat_row_includes_sent(self):
        draft = ReportDraft(headline="h", overview="ov",
                            sections=[{"id": "a", "title": "T", "email_refs": [1]}])
        doc = assemble_report_doc(draft=draft, briefs=self._briefs(),
                                  counts={"total": 2, "replied": 1, "sent": 4},
                                  agent_id="a", cadence="daily", report_date="2026-06-02",
                                  window_start="s", window_end="e", generated_at="g",
                                  model="mk", now=_NOW)
        sr = next(b for b in doc.blocks if b["type"] == "stat_row")
        kv = {s["key"]: s["value"] for s in sr["stats"]}
        assert kv["sent"] == 4 and kv["replied"] == 1  # 已发出/已回复 都进统计卡

    def test_email_item_badges_from_status(self):
        # replied + flagged → email_item.badges 含「已回复」「已标旗」
        b = rdata.ReportEmailBrief(
            7, "S", "A", "a@x.com", _iso(1), "📊 项目管理", "🔴 紧急", "需要回复",
            "", True, "pg", is_flagged=True, replied=True,
        )
        draft = ReportDraft(headline="h", overview="",
                            sections=[{"id": "a", "title": "T", "email_refs": [7]}])
        doc = assemble_report_doc(draft=draft, briefs=[b], counts={}, agent_id="a",
                                  cadence="daily", report_date="2026-06-02", window_start="s",
                                  window_end="e", generated_at="g", model="mk", now=_NOW)
        item = next(x for x in doc.blocks if x["type"] == "email_item")
        assert "已回复" in item["badges"] and "已标旗" in item["badges"]


# ============================================================
# summarizer
# ============================================================

class TestSummarizer:
    def test_schema_shape_no_counts_leak(self):
        assert REPORT_TOOL_SCHEMA["name"] == "build_report"
        props = REPORT_TOOL_SCHEMA["input_schema"]["properties"]
        assert set(REPORT_TOOL_SCHEMA["input_schema"]["required"]) == {"headline", "overview", "sections"}
        assert "counts" not in props and "stat_row" not in props  # counts 不交给 LLM
        sec_props = props["sections"]["items"]["properties"]
        assert sec_props["email_refs"]["items"]["type"] == "integer"
        assert "summary" in sec_props  # 设计稿新增：分组汇总（含跳转链接）

    def test_parse_filters(self):
        res = LLMResult(
            tool_input={
                "headline": "h", "overview": "ov",
                "sections": [{"id": "a", "title": "T", "summary": "组 [x](#email-1)", "email_refs": [1, "bad", 2]}],
                "key_points": ["k1", "  ", ""],
                "highlights": [{"tone": "warn", "body": "B"}, {"body": ""}],
            },
            input_tokens=10, output_tokens=5, cache_creation_input_tokens=0,
            cache_read_input_tokens=2, model="mk", latency_ms=1,
        )
        draft = _parse(res)
        assert draft.sections[0]["email_refs"] == [1, 2]  # 非 int 过滤
        assert draft.sections[0]["summary"] == "组 [x](#email-1)"  # summary 透传
        assert draft.key_points == ["k1"]                  # 空白过滤
        assert len(draft.highlights) == 1                  # 空 body 丢弃
        assert draft.model == "mk" and draft.input_tokens == 10


# ============================================================
# worker
# ============================================================

class TestDueHour:
    AGENT = {"id": "x", "type": "report", "schedule_json": '{"cadence":"daily","hours":[9]}'}

    def _at(self, h, mi, marker=None, agent=None, day=2):
        return _due_hour(agent or self.AGENT, datetime(2026, 6, day, h, mi, tzinfo=_BJ), marker)

    def test_fire_window(self):
        assert self._at(9, 5) == 9              # 落在即时 fire 窗口
        assert self._at(8, 0) is None           # 钟点前, 无可补
        # 9:35 超出即时窗口, 但当天未 fire → catchup 补 9 点（开机补推）
        assert self._at(9, 35) == 9
        # 9:35 当天已 fire → 不再触发
        assert self._at(9, 35, "20260602-09") is None

    def test_dedup(self):
        assert self._at(9, 5, "20260602-09") is None  # 本 slot 已 fire

    def test_catchup_once(self):
        assert self._at(14, 0, "20260601-09") == 9    # 昨天 fire → 今天补
        assert self._at(14, 0, "20260602-09") is None  # 今天已 fire → 不补

    def test_weekly_monthly_period(self):
        wk = {"id": "w", "schedule_json": '{"cadence":"weekly","hours":[9],"weekday":0}'}
        assert self._at(9, 5, agent=wk, day=1) == 9     # 2026-06-01 是周一(weekday 0)
        assert self._at(9, 5, agent=wk, day=2) is None  # 周二 → 不 fire
        mo = {"id": "m", "schedule_json": '{"cadence":"monthly","hours":[9],"day_of_month":1}'}
        assert self._at(9, 5, agent=mo, day=1) == 9
        assert self._at(9, 5, agent=mo, day=2) is None


class TestRunReportOnce:
    async def _mock_sum(self, **kw):
        ids = [b.internal_id for b in kw["briefs"]]
        return ReportDraft(headline="h", overview="ov",
                           sections=[{"id": "a", "title": "关注", "icon": "alert",
                                      "intro": "i", "email_refs": ids[:2] + [99999]}],
                           key_points=["kp"], highlights=[], model="mk",
                           input_tokens=12, output_tokens=8)

    def test_ready_with_mock(self, db: Path):
        _insert(db, 1, labels=_labels())
        _insert(db, 2, labels=_labels(priority="🟢 一般", action="仅供参考"))
        store = ReportStore(str(db))
        agent = store.get_agent("daily_email_digest")
        rid = asyncio.run(run_report_once(store=store, db_path=str(db), agent=agent,
                                          now=_NOW, summarize_fn=self._mock_sum,
                                          agentic_fn=self._mock_sum))  # daily 走 agentic_fn
        rep = store.get_report(rid)
        assert rep["status"] == "ready" and rep["input_tokens"] == 12
        doc = json.loads(rep["blocks_json"])
        eids = [b["internal_id"] for b in doc["blocks"] if b["type"] == "email_item"]
        assert 99999 not in eids and set(eids) == {1, 2}  # 幻觉丢弃

    def test_empty(self, db: Path):
        store = ReportStore(str(db))
        rid = asyncio.run(run_report_once(store=store, db_path=str(db),
                                          agent=store.get_agent("daily_email_digest"),
                                          now=_NOW, summarize_fn=self._mock_sum))
        assert store.get_report(rid)["status"] == "empty"

    def test_fallback_on_llm_error(self, db: Path):
        _insert(db, 1, labels=_labels())
        store = ReportStore(str(db))

        async def boom(**kw):
            raise RuntimeError("LLM down")

        rid = asyncio.run(run_report_once(store=store, db_path=str(db),
                                          agent=store.get_agent("daily_email_digest"),
                                          now=_NOW, summarize_fn=boom, agentic_fn=boom))
        rep = store.get_report(rid)
        assert rep["status"] == "ready" and "summarize_failed" in (rep["error"] or "")
        assert rep["blocks_json"]  # fallback 仍产出 blocks


# ============================================================
# M1-M6: agentic loop / 工具桥 / 触发窗口 / 聚合 / 正文预载
# ============================================================

class TestToolLoop:
    def _msg(self, blocks, in_tok=10, out_tok=5):
        from types import SimpleNamespace as NS
        return NS(
            content=blocks,
            usage=NS(input_tokens=in_tok, output_tokens=out_tok, cache_read_input_tokens=0),
            model="claude-x", stop_reason="tool_use",
        )

    def _tu(self, tid, name, inp):
        from types import SimpleNamespace as NS
        return NS(type="tool_use", id=tid, name=name, input=inp)

    def test_loop_runs_tool_then_final(self):
        from types import SimpleNamespace as NS
        from src.llm_agent.client import LLMClient
        seq = [
            self._msg([self._tu("t1", "get_x", {"q": "a"})]),
            self._msg([self._tu("t2", "build_report", {"headline": "H"})]),
        ]
        calls: list = []

        class FakeMessages:
            async def create(self, **kw):
                calls.append(kw)
                return seq[len(calls) - 1]

        client = LLMClient()
        client._client = NS(messages=FakeMessages())  # 注入 fake，跳过 _lazy / 真网络
        handled: list = []

        def h(inp):
            handled.append(inp)
            return "result-x"

        res = asyncio.run(client.run_tool_loop(
            system_blocks=[{"type": "text", "text": "s"}], user_content="u",
            tools=[{"name": "get_x"}, {"name": "build_report"}],
            tool_handlers={"get_x": h}, final_tool="build_report",
            model_chain=["claude-x"], max_iter=5,
        ))
        assert res.final_input == {"headline": "H"}   # final_tool 的 input
        assert res.iterations == 2
        assert handled == [{"q": "a"}]                 # 非 final 工具被执行
        assert res.input_tokens == 20                  # 两轮累加
        replayed = calls[1]["messages"]               # 第 2 轮回灌了 tool_result
        assert any(
            mm.get("role") == "user" and isinstance(mm.get("content"), list)
            and mm["content"][0].get("type") == "tool_result"
            for mm in replayed
        )

    def test_loop_requires_anthropic_model(self):
        from src.llm_agent.client import LLMCallError, LLMClient
        with pytest.raises(LLMCallError):
            asyncio.run(LLMClient().run_tool_loop(
                system_blocks=[], user_content="u", tools=[], tool_handlers={},
                final_tool="build_report", model_chain=["gpt-5.5"],  # 全 openai proto
            ))


class TestAgentTools:
    def test_kos_gate(self):
        tools_no, h_no = build_report_tools("x.db", kos_enabled=False)
        tools_yes, _ = build_report_tools("x.db", kos_enabled=True)
        assert "kos_query" not in {t["name"] for t in tools_no}
        assert "kos_query" in {t["name"] for t in tools_yes}
        assert set(h_no) == {"get_email_body", "search_emails", "search_attachments"}

    def test_handler_bad_input_returns_error(self, db: Path):
        _, handlers = build_report_tools(str(db), kos_enabled=False)
        assert handlers["get_email_body"]({"internal_id": "not-int"}).startswith("error:")
        assert handlers["search_emails"]({"query": ""}).startswith("error:")


class TestWindowBounds:
    def test_period_bounds_weekly(self):
        n = datetime(2026, 6, 3, 9, 0, tzinfo=_BJ)  # 周三
        assert _period_bounds("weekly", n) == ("2026-05-25", "2026-05-31", "2026-05-25", 7)

    def test_period_bounds_monthly(self):
        n = datetime(2026, 6, 3, 9, 0, tzinfo=_BJ)
        start, end, rdate, _ = _period_bounds("monthly", n)
        assert (start, end, rdate) == ("2026-05-01", "2026-05-31", "2026-05-01")

    def test_daily_window_rolling_vs_natural(self):
        n = datetime(2026, 6, 3, 9, 0, tzinfo=_BJ)
        # rolling_24h 固定回溯 24h，忽略遗留的 window_hours（窗口不再可配）。
        s, e, rd = _daily_window({"trigger_mode": "rolling_24h", "window_hours": 48}, n)
        assert rd == "2026-06-03" and (e - s) == timedelta(hours=24)
        s2, e2, rd2 = _daily_window({"trigger_mode": "natural_day"}, n)
        assert rd2 == "2026-06-02" and s2.hour == 0 and (e2 - s2) == timedelta(days=1)

    def test_sum_counts(self):
        subs = [
            {"counts_json": json.dumps({"total": 10, "replied": 2, "sent": 3})},
            {"counts_json": json.dumps({"total": 5, "replied": 1})},
            {"counts_json": "bad-json"},  # 容错
        ]
        c = _sum_counts(subs)
        assert c["total"] == 15 and c["replied"] == 3 and c["sent"] == 3


class TestBodyPreload:
    def test_important_email_preloads_body(self, db: Path):
        _insert(db, 1, labels=_labels(priority="🔴 紧急", action="需要回复"))  # 重要
        _insert(db, 2, labels=_labels(priority="🟢 一般", action="仅供参考"))  # 普通
        conn = sqlite3.connect(str(db))
        conn.execute(
            "INSERT INTO email_body (internal_id, body_markdown, body_format, "
            "body_size_bytes, fetched_at, fetched_source) VALUES (1, '紧急正文', 'text', 6, ?, 'test')",
            (time.time(),),
        )
        conn.commit()
        conn.close()
        briefs = rdata.fetch_report_briefs(str(db), now=_NOW, body_priorities=["🔴 紧急"])
        bm = {b.internal_id: b for b in briefs}
        assert bm[1].body_text == "紧急正文"   # 紧急（命中勾选优先级）→ 预载
        assert bm[2].body_text is None          # 一般（未命中）→ 不预载
        briefs_none = rdata.fetch_report_briefs(str(db), now=_NOW, body_priorities=None)
        assert all(b.body_text is None for b in briefs_none)  # None → 都不预载
        briefs_empty = rdata.fetch_report_briefs(str(db), now=_NOW, body_priorities=[])
        assert all(b.body_text is None for b in briefs_empty)  # [] → 都不预载


class TestAggregateRun:
    async def _mock_agg(self, **kw):
        return ReportDraft(
            headline="周报", overview="综合。" + kw.get("missing_note", ""), model="mk"
        )

    def test_weekly_aggregates_subreports_with_missing_note(self, db: Path):
        store = ReportStore(str(db))
        # _NOW=2026-06-02 周二 → 上周一 5-25 ~ 上周日 5-31；seed 2 份日报（缺 5）
        for d in ["2026-05-25", "2026-05-26"]:
            rid = f"daily_email_digest:daily:{d}"
            store.create_report(report_id=rid, agent_id="daily_email_digest", cadence="daily",
                                report_date=d, window_start="s", window_end="e")
            store.finish_report(rid, status="ready",
                                blocks_json=json.dumps([{"type": "overview", "text": f"{d} 概览"}]),
                                counts_json=json.dumps({"total": 10, "replied": 2}), headline=d)
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        wk = store.get_agent("weekly_email_digest")
        rid = asyncio.run(run_report_once(store=store, db_path=str(db), agent=wk,
                                          now=_NOW, aggregate_fn=self._mock_agg))
        rep = store.get_report(rid)
        assert rep["status"] == "ready"
        blocks = json.loads(rep["blocks_json"])["blocks"]
        ov = next((b["text"] for b in blocks if b["type"] == "overview"), "")
        assert "缺失" in ov                              # 缺数据标注
        c = json.loads(rep["counts_json"])
        assert c["total"] == 20 and c["replied"] == 4    # 子报告 counts 汇总

    def test_weekly_empty_when_no_subreports(self, db: Path):
        store = ReportStore(str(db))
        store.update_agent("weekly_email_digest", {"timezone": "Asia/Shanghai"})
        wk = store.get_agent("weekly_email_digest")
        rid = asyncio.run(run_report_once(store=store, db_path=str(db), agent=wk,
                                          now=_NOW, aggregate_fn=self._mock_agg))
        assert store.get_report(rid)["status"] == "empty"  # 无子报告 → empty
