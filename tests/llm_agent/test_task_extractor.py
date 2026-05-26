"""Tests for src.llm_agent.task_extractor (Phase 2 F3 convert_to_notion_task).

覆盖 _parse sanitize (enum 校验 / 时间过去清空 / 时区补全) + _sanitize_time + schema.
LLM call mock (不烧 token).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.llm_agent.client import LLMResult
from src.llm_agent.task_extractor import (
    SCHEDULE_TYPE_ENUM,
    TASK_PRIORITY_ENUM,
    TASK_TOOL_SCHEMA,
    TaskFields,
    _parse,
    _sanitize_time,
    extract_task_fields,
)

_BJ = timezone(timedelta(hours=8))
_NOW = datetime(2026, 5, 26, 10, 0, 0, tzinfo=_BJ)  # 周二 10:00


def _result(**tool_input) -> LLMResult:
    return LLMResult(
        tool_input=tool_input,
        input_tokens=50, output_tokens=20,
        cache_creation_input_tokens=0, cache_read_input_tokens=0,
        model="m", latency_ms=10,
    )


# ─────────────────────────────────────────────────────────────────────────────
# schema
# ─────────────────────────────────────────────────────────────────────────────


def test_task_tool_schema_shape():
    assert TASK_TOOL_SCHEMA["name"] == "extract_task"
    props = TASK_TOOL_SCHEMA["input_schema"]["properties"]
    assert set(TASK_TOOL_SCHEMA["input_schema"]["required"]) == {
        "task_title", "schedule_type", "priority",
    }
    assert props["schedule_type"]["enum"] == SCHEDULE_TYPE_ENUM
    assert props["priority"]["enum"] == TASK_PRIORITY_ENUM
    assert props["task_title"]["maxLength"] == 100
    assert props["description"]["maxLength"] == 500


def test_schedule_type_enum_matches_calendar_db_options():
    # 规范子集 — 必须是日程库 日程类型 select 真实 options 的子集
    assert "💼 工作·会议" in SCHEDULE_TYPE_ENUM
    assert "🎯 工作·专注" in SCHEDULE_TYPE_ENUM
    assert len(SCHEDULE_TYPE_ENUM) == 6


def test_priority_enum_matches_calendar_db():
    assert TASK_PRIORITY_ENUM == ["🔴 紧急", "🟠 高", "🟡 中", "🟢 低"]


# ─────────────────────────────────────────────────────────────────────────────
# _parse — enum 校验 / 默认值
# ─────────────────────────────────────────────────────────────────────────────


def test_parse_valid_fields():
    f = _parse(_result(
        task_title="Review PCI 合规文档",
        schedule_type="🎯 工作·专注",
        priority="🟠 高",
        suggested_time_iso="2026-05-27T14:00:00+08:00",
        is_all_day=False,
        description="Chi/Mengyue 起草, 需 R&D 核查高亮部分",
    ), _NOW)
    assert f.task_title == "Review PCI 合规文档"
    assert f.schedule_type == "🎯 工作·专注"
    assert f.priority == "🟠 高"
    assert f.suggested_time_iso == "2026-05-27T14:00:00+08:00"
    assert f.is_all_day is False
    assert "R&D" in f.description


def test_parse_invalid_schedule_type_defaults_to_focus():
    f = _parse(_result(
        task_title="X", schedule_type="瞎编类型", priority="🟡 中",
    ), _NOW)
    assert f.schedule_type == "🎯 工作·专注"


def test_parse_invalid_priority_defaults_to_medium():
    f = _parse(_result(
        task_title="X", schedule_type="📚 阅读", priority="P999",
    ), _NOW)
    assert f.priority == "🟡 中"


def test_parse_empty_title_fallback():
    f = _parse(_result(
        task_title="", schedule_type="📚 阅读", priority="🟢 低",
    ), _NOW)
    assert f.task_title == "(未命名任务)"


def test_parse_title_truncated_to_100():
    f = _parse(_result(
        task_title="标题" * 80, schedule_type="📚 阅读", priority="🟢 低",
    ), _NOW)
    assert len(f.task_title) == 100


def test_parse_description_truncated_to_500():
    f = _parse(_result(
        task_title="X", schedule_type="📚 阅读", priority="🟢 低",
        description="详情" * 400,
    ), _NOW)
    assert len(f.description) == 500


# ─────────────────────────────────────────────────────────────────────────────
# _sanitize_time
# ─────────────────────────────────────────────────────────────────────────────


def test_sanitize_time_future_kept():
    out = _sanitize_time("2026-05-27T14:00:00+08:00", _NOW)
    assert out == "2026-05-27T14:00:00+08:00"


def test_sanitize_time_past_cleared():
    # 昨天 → 清空 (让用户手排)
    out = _sanitize_time("2026-05-25T09:00:00+08:00", _NOW)
    assert out == ""


def test_sanitize_time_no_tz_gets_beijing():
    # 无时区 → 补北京 +08:00
    out = _sanitize_time("2026-05-27T14:00:00", _NOW)
    assert out == "2026-05-27T14:00:00+08:00"


def test_sanitize_time_invalid_iso_cleared():
    assert _sanitize_time("明天下午", _NOW) == ""
    assert _sanitize_time("not-a-date", _NOW) == ""


def test_sanitize_time_empty_or_none():
    assert _sanitize_time("", _NOW) == ""
    assert _sanitize_time(None, _NOW) == ""
    assert _sanitize_time(123, _NOW) == ""  # type: ignore[arg-type]


def test_parse_past_time_cleared_in_full_parse():
    f = _parse(_result(
        task_title="X", schedule_type="📚 阅读", priority="🟢 低",
        suggested_time_iso="2020-01-01T09:00:00+08:00",  # 过去
    ), _NOW)
    assert f.suggested_time_iso == ""


# ─────────────────────────────────────────────────────────────────────────────
# extract_task_fields — mock client
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


def test_extract_task_fields_uses_injected_client():
    import asyncio

    fake = _FakeClient(_result(
        task_title="回复 Gary 预算问题",
        schedule_type="🎯 工作·专注",
        priority="🟠 高",
        suggested_time_iso="2026-05-27T09:00:00+08:00",
        description="Gary 问 Q3 预算, 需本周回",
    ))
    f = asyncio.run(extract_task_fields(
        subject="Q3 budget", body_markdown="...", ai_summary="Gary 问预算",
        ai_priority="🟡 重要", sender="gary@acme.com",
        now=_NOW, client=fake,
    ))
    assert f.task_title == "回复 Gary 预算问题"
    assert f.schedule_type == "🎯 工作·专注"
    # 注入 client 不应被 close (caller 拥有)
    assert fake.closed is False
    # classify 收到 extract_task tool
    assert fake.calls[0]["tool_name"] == "extract_task"
    # user content 含 subject + ai_summary + priority hint
    user = fake.calls[0]["user_content"]
    assert "Q3 budget" in user
    assert "Gary 问预算" in user
    assert "🟠 高" in user  # priority hint 映射 (🟡 重要 → 🟠 高)
