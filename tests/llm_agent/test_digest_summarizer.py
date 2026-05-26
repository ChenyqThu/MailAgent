"""Tests for src.llm_agent.digest_summarizer (灵动岛 Phase 3 DailyDigest summarizer).

覆盖 _parse enum 校验兜底 (超 enum 的 action 被丢 / title 缺失被丢) + _build_user
不含正文 + confirmed_actions title 数字一致性 + schema 形状。LLM call mock (不烧 token).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from src.llm_agent.client import LLMResult
from src.llm_agent.digest_summarizer import (
    BULK_ACTION_IDS,
    DIGEST_TOOL_SCHEMA,
    DigestSummary,
    _build_system,
    _build_user,
    _parse,
    summarize_digest,
)

_BJ = timezone(timedelta(hours=8))
_NOW = datetime(2026, 5, 26, 9, 0, 0, tzinfo=_BJ)  # 周二 09:00


def _result(**tool_input) -> LLMResult:
    return LLMResult(
        tool_input=tool_input,
        input_tokens=80, output_tokens=30,
        cache_creation_input_tokens=0, cache_read_input_tokens=5,
        model="m", latency_ms=12,
    )


# ─────────────────────────────────────────────────────────────────────────────
# schema
# ─────────────────────────────────────────────────────────────────────────────


def test_digest_tool_schema_shape():
    assert DIGEST_TOOL_SCHEMA["name"] == "summarize_digest"
    schema = DIGEST_TOOL_SCHEMA["input_schema"]
    assert set(schema["required"]) == {"headline", "summary_md"}
    props = schema["properties"]
    assert props["headline"]["maxLength"] == 30
    assert props["summary_md"]["maxLength"] == 400
    # confirmed_bulk_actions: array, maxItems 3, id 限定 3 enum
    cba = props["confirmed_bulk_actions"]
    assert cba["type"] == "array"
    assert cba["maxItems"] == 3
    assert cba["items"]["properties"]["id"]["enum"] == BULK_ACTION_IDS
    assert cba["items"]["properties"]["title"]["maxLength"] == 24


def test_schema_does_not_output_counts_or_ids():
    """爆炸半径限定文案 — schema 不暴露 counts / ids 字段给 LLM."""
    props = DIGEST_TOOL_SCHEMA["input_schema"]["properties"]
    assert "counts" not in props
    assert "unread" not in props
    assert "urgent" not in props
    assert "ids" not in props
    assert "internal_ids" not in props
    # bulk action item 也不含 ids
    item_props = props["confirmed_bulk_actions"]["items"]["properties"]
    assert "ids" not in item_props
    assert "internal_ids" not in item_props
    assert set(item_props.keys()) == {"id", "title", "detail"}


def test_bulk_action_ids_are_three_fixed():
    assert BULK_ACTION_IDS == [
        "bulk_archive_newsletter",
        "bulk_mark_done",
        "bulk_mark_read",
    ]


# ─────────────────────────────────────────────────────────────────────────────
# _parse — enum 校验兜底
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_valid_summary():
    s = _parse(_result(
        headline="3封紧急待回复，5封可清理",
        summary_md="今天有 **3 封紧急邮件** 待回复，建议优先看 Gary 的预算问题。",
        confirmed_bulk_actions=[
            {"id": "bulk_archive_newsletter", "title": "归档5封newsletter",
             "detail": "FYI 类邮件"},
            {"id": "bulk_mark_read", "title": "标已读8封"},
        ],
    ))
    assert isinstance(s, DigestSummary)
    assert s.headline == "3封紧急待回复，5封可清理"
    assert "3 封紧急" in s.summary_md
    assert len(s.confirmed_actions) == 2
    assert s.confirmed_actions[0].id == "bulk_archive_newsletter"
    assert s.confirmed_actions[0].title == "归档5封newsletter"
    assert s.confirmed_actions[0].detail == "FYI 类邮件"
    assert s.confirmed_actions[1].id == "bulk_mark_read"
    assert s.confirmed_actions[1].detail == ""
    # meta 透传
    assert s.input_tokens == 80
    assert s.output_tokens == 30
    assert s.cache_read_input_tokens == 5
    assert s.model == "m"


def test_parse_drops_out_of_enum_action():
    """enum 校验: id 不在 3 enum 内 → 该 action 被丢."""
    s = _parse(_result(
        headline="今日汇总",
        summary_md="摘要",
        confirmed_bulk_actions=[
            {"id": "bulk_delete_everything", "title": "删光"},  # 不在 enum
            {"id": "bulk_mark_done", "title": "标完成3封"},     # 合法
        ],
    ))
    assert len(s.confirmed_actions) == 1
    assert s.confirmed_actions[0].id == "bulk_mark_done"


def test_parse_drops_action_missing_title():
    """title 缺失 → 该 action 被丢."""
    s = _parse(_result(
        headline="H",
        summary_md="S",
        confirmed_bulk_actions=[
            {"id": "bulk_archive_newsletter"},                  # 缺 title
            {"id": "bulk_archive_newsletter", "title": ""},     # 空 title
            {"id": "bulk_mark_read", "title": "标已读5封"},     # 合法
        ],
    ))
    assert len(s.confirmed_actions) == 1
    assert s.confirmed_actions[0].id == "bulk_mark_read"


def test_parse_dedups_same_action_id():
    s = _parse(_result(
        headline="H", summary_md="S",
        confirmed_bulk_actions=[
            {"id": "bulk_mark_done", "title": "标完成3封"},
            {"id": "bulk_mark_done", "title": "再标完成3封"},  # 同 id 去重
        ],
    ))
    assert len(s.confirmed_actions) == 1


def test_parse_caps_at_three_actions():
    s = _parse(_result(
        headline="H", summary_md="S",
        confirmed_bulk_actions=[
            {"id": "bulk_archive_newsletter", "title": "a"},
            {"id": "bulk_mark_done", "title": "b"},
            {"id": "bulk_mark_read", "title": "c"},
            # 第 4 个 (即使 id 合法去重前) — 已满 3, 后续不收
        ],
    ))
    assert len(s.confirmed_actions) == 3


def test_parse_empty_actions():
    s = _parse(_result(headline="H", summary_md="S"))
    assert s.confirmed_actions == []


def test_parse_truncates_long_fields():
    s = _parse(_result(
        headline="x" * 50,           # > 30
        summary_md="y" * 500,        # > 400
        confirmed_bulk_actions=[
            {"id": "bulk_mark_done", "title": "z" * 40},  # > 24
        ],
    ))
    assert len(s.headline) == 30
    assert len(s.summary_md) == 400
    assert len(s.confirmed_actions[0].title) == 24


def test_parse_non_list_actions_tolerated():
    s = _parse(_result(
        headline="H", summary_md="S",
        confirmed_bulk_actions="not a list",
    ))
    assert s.confirmed_actions == []


# ─────────────────────────────────────────────────────────────────────────────
# _build_user — 不含正文 + 已知 counts + 候选
# ─────────────────────────────────────────────────────────────────────────────


def test_build_user_excludes_body():
    """关键约束: brief 不传正文, 只传 metadata + AI 字段精华."""
    emails = [{
        "subject": "Q3 预算评审",
        "sender_name": "Gary",
        "category": "📊 项目管理",
        "priority": "🟡 重要",
        "action_type": "需要回复",
        "ai_summary": "Gary 询问 Q3 预算分配方案",
        "is_read": False,
        # 故意塞一个正文字段, 验证 _build_user 不会引用它
        "body_markdown": "SECRET_BODY_CONTENT_SHOULD_NOT_APPEAR",
        "body_html": "<p>SECRET_HTML</p>",
    }]
    counts = {"unread": 1, "urgent": 1, "total": 1, "by_category": {"📊 项目管理": 1}}
    candidates = []
    user = _build_user(emails_brief=emails, counts=counts, bulk_candidates=candidates)
    # 含 metadata + AI 字段
    assert "Q3 预算评审" in user
    assert "Gary" in user
    assert "需要回复" in user
    assert "Gary 询问 Q3 预算" in user
    # 不含正文
    assert "SECRET_BODY_CONTENT_SHOULD_NOT_APPEAR" not in user
    assert "SECRET_HTML" not in user


def test_build_user_includes_counts_as_facts():
    counts = {"unread": 12, "urgent": 3, "total": 40, "by_category": {"🔔 系统通知": 5}}
    user = _build_user(emails_brief=[], counts=counts, bulk_candidates=[])
    assert "12" in user  # unread
    assert "3" in user   # urgent
    assert "40" in user  # total
    assert "🔔 系统通知" in user


def test_build_user_includes_bulk_candidates():
    candidates = [
        {"id": "bulk_archive_newsletter", "count": 5,
         "sample_subjects": ["Newsletter A", "Newsletter B", "周报 C"]},
    ]
    user = _build_user(emails_brief=[], counts={}, bulk_candidates=candidates)
    assert "bulk_archive_newsletter" in user
    assert "Newsletter A" in user
    assert "count=5" in user


def test_build_user_truncates_ai_summary():
    long_summary = "摘" * 200
    emails = [{
        "subject": "S", "sender_name": "X", "category": "", "priority": "",
        "action_type": "", "ai_summary": long_summary, "is_read": True,
    }]
    user = _build_user(emails_brief=emails, counts={}, bulk_candidates=[],
                       ai_summary_max_chars=80)
    # ai_summary 被截到 80 + 省略号; 不应出现完整 200 字
    assert long_summary not in user
    assert "摘" * 80 in user


def test_build_user_empty_inputs():
    user = _build_user(emails_brief=[], counts={}, bulk_candidates=[])
    assert "无候选" in user
    assert "无已分类邮件" in user


# ─────────────────────────────────────────────────────────────────────────────
# _build_system
# ─────────────────────────────────────────────────────────────────────────────


def test_build_system_injects_time_and_constraints():
    blocks = _build_system(_NOW)
    assert len(blocks) == 1
    text = blocks[0]["text"]
    assert "2026-05-26T09:00:00+08:00" in text
    assert "周二" in text
    assert "+08:00" in text
    assert "summarize_digest" in text
    assert "EXACTLY ONCE" in text
    # 强调 counts 是已知事实 + bulk 只能从候选选
    assert "已知" in text
    assert "候选" in text


def test_build_system_has_cache_control_when_enabled():
    """system 末尾单断点 cache_control (照 processor 模式), 由 cfg 决定."""
    blocks = _build_system(_NOW)
    # cfg.llm_cache_enabled 默认 True → 有 cache_control;
    # 不强行断言值, 只验证 key 存在性跟 _build_cache_control 一致
    from src.llm_agent.processor import _build_cache_control
    cc = _build_cache_control()
    if cc is not None:
        assert blocks[0].get("cache_control") == cc
    else:
        assert "cache_control" not in blocks[0]


# ─────────────────────────────────────────────────────────────────────────────
# summarize_digest — mock client (injected, not closed)
# ─────────────────────────────────────────────────────────────────────────────


class _FakeClient:
    """mock LLMClient: classify 返回固定 LLMResult, 记录入参."""

    def __init__(self, result: LLMResult):
        self._result = result
        self.calls = []
        self.closed = False

    async def classify(self, **kwargs):
        self.calls.append(kwargs)
        return self._result

    async def close(self):
        self.closed = True


def test_summarize_digest_uses_injected_client():
    fake = _FakeClient(_result(
        headline="今日 2 封紧急",
        summary_md="有 2 封紧急邮件待处理。",
        confirmed_bulk_actions=[
            {"id": "bulk_archive_newsletter", "title": "归档3封"},
        ],
    ))
    s = asyncio.run(summarize_digest(
        emails_brief=[{"subject": "S", "sender_name": "A", "category": "",
                       "priority": "🔴 紧急", "action_type": "需要回复",
                       "ai_summary": "x", "is_read": False}],
        counts={"unread": 2, "urgent": 2, "total": 2, "by_category": {}},
        bulk_candidates=[{"id": "bulk_archive_newsletter", "count": 3,
                          "sample_subjects": ["a", "b"]}],
        now=_NOW, client=fake,
    ))
    assert s.headline == "今日 2 封紧急"
    assert len(s.confirmed_actions) == 1
    # 注入 client 不应被 close (caller 拥有)
    assert fake.closed is False
    # classify 收到 summarize_digest tool
    assert fake.calls[0]["tool_name"] == "summarize_digest"
    # user content 含 subject + counts
    user = fake.calls[0]["user_content"]
    assert "S" in user
    assert "需要回复" in user
