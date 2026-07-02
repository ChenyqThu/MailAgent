"""Tests for EventHandlers.handle_fetch_mail_content (v4 SQLite SSoT path).

Covers:
- SQLite hit (full + text format)
- Fallback to AppleScript when body missing / empty / repo None / metadata missing
- AppleScript path still works end-to-end
- Latency / source fields on response
- Stats counters incremented correctly
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import pytest

from src.events.handlers import EventHandlers


# ============================================================
# Fakes — light-weight stand-ins for AppleScript / SyncStore / EmailRepository
# ============================================================

class _FakeArm:
    def __init__(self, returns: Optional[Dict] = None):
        self._returns = returns
        self.calls: List[tuple] = []

    def fetch_email_content_by_id(self, internal_id, mailbox):
        self.calls.append((internal_id, mailbox))
        return self._returns


class _FakeSyncStore:
    def __init__(self, metadata_by_id: Dict[int, Dict]):
        self._data = metadata_by_id

    def get(self, internal_id: int):
        return self._data.get(internal_id)


@dataclass
class _FakeBody:
    html: Optional[str]
    markdown: Optional[str]
    body_format: str = "html"
    message_id: Optional[str] = None


class _FakeRepo:
    def __init__(self, bodies: Optional[Dict[int, _FakeBody]] = None, *, raise_on=None):
        self._bodies = bodies or {}
        self._raise_on = raise_on
        self.calls: List[int] = []

    def get_body(self, internal_id: int):
        self.calls.append(internal_id)
        if self._raise_on == internal_id:
            raise RuntimeError("simulated SQLite read error")
        return self._bodies.get(internal_id)


def _make_handler(
    *,
    repo: Optional[_FakeRepo] = None,
    metadata: Optional[Dict[int, Dict]] = None,
    arm_returns: Optional[Dict] = None,
):
    """Build an EventHandlers with all real deps stubbed out."""
    captured: Dict[str, Any] = {}

    async def _capture(event_id, payload):
        captured["event_id"] = event_id
        captured["payload"] = payload

    h = EventHandlers(
        backend=_FakeArm(returns=arm_returns),
        sync_store=_FakeSyncStore(metadata or {}),
        feishu=None,
        notion_sync=None,
        result_callback=_capture,
        email_repo=repo,
    )
    return h, captured


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)


# ============================================================
# Tests
# ============================================================

def test_missing_internal_id_returns_error():
    h, captured = _make_handler()
    _run(h.handle_fetch_mail_content({"id": "e1", "properties": {}}))
    assert captured["payload"]["status"] == "error"
    assert "internal_id" in captured["payload"]["error"]


def test_sqlite_hit_full_format():
    """v4 path: SQLite has body + metadata → return markdown + html + source=sqlite-cache."""
    repo = _FakeRepo(bodies={
        42: _FakeBody(
            html="<p>Hi</p>",
            markdown="# Hi from SQLite",
            body_format="html",
            message_id="<msg-42@example.com>",
        )
    })
    metadata = {42: {
        "subject": "Hello",
        "sender": "alice@example.com",
        "sender_name": "Alice",
        "date_received": "2026-05-15T10:00:00+08:00",
        "message_id": "<msg-42@example.com>",
        "thread_id": "<thread-42>",
        "is_read": True,
        "is_flagged": False,
        "notion_page_id": "abc123-def456",
    }}
    h, captured = _make_handler(repo=repo, metadata=metadata)

    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))

    p = captured["payload"]
    assert p["status"] == "success"
    assert p["source"] == "sqlite-cache"
    assert p["internal_id"] == 42
    assert p["subject"] == "Hello"
    assert p["sender"] == "Alice <alice@example.com>"
    assert p["content"] == "# Hi from SQLite"
    assert p["html"] == "<p>Hi</p>"
    assert p["is_read"] is True
    assert p["is_flagged"] is False
    assert p["thread_id"] == "<thread-42>"
    assert p["message_id"] == "<msg-42@example.com>"
    assert p["notion_page_id"] == "abc123-def456"
    assert p["notion_url"] == "https://www.notion.so/abc123def456"
    assert "latency_ms" in p
    assert h._stats["fetch_mail_content_sqlite_hit"] == 1
    assert h._stats["fetch_mail_content_sqlite_miss"] == 0


def test_sqlite_hit_text_format_strips_html_fields():
    """format=text → 不返回 html / is_read / is_flagged / thread_id / message_id."""
    repo = _FakeRepo(bodies={
        42: _FakeBody(html="<p>X</p>", markdown="text body", body_format="html"),
    })
    metadata = {42: {
        "subject": "Hi", "sender": "a@x.com", "sender_name": "",
        "date_received": "2026-05-15", "is_read": False, "is_flagged": False,
    }}
    h, captured = _make_handler(repo=repo, metadata=metadata)

    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "text"},
    }))

    p = captured["payload"]
    assert p["status"] == "success"
    assert p["source"] == "sqlite-cache"
    assert p["content"] == "text body"
    assert p["sender"] == "a@x.com"
    assert "html" not in p
    assert "is_read" not in p
    assert "is_flagged" not in p
    assert "thread_id" not in p


def test_sqlite_miss_falls_back_to_applescript():
    """email_body 没行 → AppleScript fallback，source=applescript-fresh."""
    repo = _FakeRepo(bodies={})  # nothing in SQLite
    metadata = {42: {"subject": "old", "sender": "x@y.com"}}
    h, captured = _make_handler(
        repo=repo,
        metadata=metadata,
        arm_returns={
            "message_id": "<as@x.com>",
            "subject": "From AppleScript",
            "sender": "x@y.com",
            "date": "2026-04-01",
            "content": "AppleScript plaintext",
            "is_read": True,
            "is_flagged": False,
            "thread_id": "<t1>",
            "source": "",
        },
    )

    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))

    p = captured["payload"]
    assert p["status"] == "success"
    assert p["source"] == "applescript-fresh"
    assert p["subject"] == "From AppleScript"
    assert p["content"] == "AppleScript plaintext"
    assert h._stats["fetch_mail_content_sqlite_hit"] == 0
    assert h._stats["fetch_mail_content_sqlite_miss"] == 1


def test_empty_body_format_falls_back():
    """body_format='empty' → SQLite 路径不算 hit，走 fallback."""
    repo = _FakeRepo(bodies={
        42: _FakeBody(html=None, markdown="", body_format="empty"),
    })
    metadata = {42: {"subject": "x", "sender": "x@y.com"}}
    h, captured = _make_handler(
        repo=repo,
        metadata=metadata,
        arm_returns={"subject": "AS", "content": "as-body", "sender": "x@y.com"},
    )
    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))
    assert captured["payload"]["source"] == "applescript-fresh"


def test_empty_markdown_falls_back():
    """markdown='' 即便 body_format 不是 empty 也 fallback —— 没东西可给 LLM."""
    repo = _FakeRepo(bodies={
        42: _FakeBody(html="<p></p>", markdown="", body_format="html"),
    })
    metadata = {42: {"subject": "x", "sender": "x@y.com"}}
    h, captured = _make_handler(
        repo=repo, metadata=metadata,
        arm_returns={"subject": "AS", "content": "as-body", "sender": "x@y.com"},
    )
    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))
    assert captured["payload"]["source"] == "applescript-fresh"


def test_no_repo_falls_back():
    """email_repo=None → 立刻走 AppleScript（保持向后兼容部署）."""
    h, captured = _make_handler(
        repo=None,
        metadata={42: {"subject": "x"}},
        arm_returns={"subject": "AS", "content": "as", "sender": "x@y.com"},
    )
    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))
    assert captured["payload"]["source"] == "applescript-fresh"


def test_no_metadata_falls_back():
    """sync_store metadata 缺失（极端情况）→ fallback，避免拼半截结果."""
    repo = _FakeRepo(bodies={42: _FakeBody(html="<p>x</p>", markdown="md")})
    h, captured = _make_handler(
        repo=repo,
        metadata={},  # no metadata row
        arm_returns={"subject": "AS", "content": "as", "sender": "x@y.com"},
    )
    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))
    assert captured["payload"]["source"] == "applescript-fresh"


def test_sqlite_exception_falls_back():
    """repo.get_body 抛异常 → warning + fallback，不让查询整体失败."""
    repo = _FakeRepo(bodies={}, raise_on=42)
    h, captured = _make_handler(
        repo=repo,
        metadata={42: {"subject": "x", "sender": "x@y.com"}},
        arm_returns={"subject": "AS", "content": "as", "sender": "x@y.com"},
    )
    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))
    assert captured["payload"]["source"] == "applescript-fresh"


def test_applescript_also_fails_returns_error():
    """SQLite miss + AppleScript 也返回 None → 整体 error."""
    h, captured = _make_handler(
        repo=None,
        metadata={},
        arm_returns=None,  # arm returns None too
    )
    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))
    assert captured["payload"]["status"] == "error"
    assert "Failed to fetch email 42" in captured["payload"]["error"]


def test_sender_display_no_name():
    """metadata 没 sender_name → 只显示 sender 邮箱，不带尖括号."""
    repo = _FakeRepo(bodies={42: _FakeBody(html="<p>x</p>", markdown="m")})
    metadata = {42: {
        "subject": "s", "sender": "only-email@x.com", "sender_name": "",
        "date_received": "2026-05-15",
    }}
    h, captured = _make_handler(repo=repo, metadata=metadata)
    _run(h.handle_fetch_mail_content({
        "id": "e1",
        "properties": {"internal_id": 42, "format": "full"},
    }))
    assert captured["payload"]["sender"] == "only-email@x.com"


def test_latency_recorded_on_both_paths():
    """SQLite hit 和 AppleScript fallback 都要带 latency_ms."""
    # SQLite path
    repo = _FakeRepo(bodies={42: _FakeBody(html="<p>x</p>", markdown="m")})
    metadata = {42: {"subject": "s", "sender": "x@y.com"}}
    h1, c1 = _make_handler(repo=repo, metadata=metadata)
    _run(h1.handle_fetch_mail_content({"id": "e1", "properties": {"internal_id": 42}}))
    assert "latency_ms" in c1["payload"]
    assert isinstance(c1["payload"]["latency_ms"], int)

    # AppleScript path
    h2, c2 = _make_handler(
        repo=None, metadata={},
        arm_returns={"subject": "AS", "content": "as", "sender": "x@y.com"},
    )
    _run(h2.handle_fetch_mail_content({"id": "e1", "properties": {"internal_id": 42}}))
    assert "latency_ms" in c2["payload"]


# ===== P2-04: P99 latency tracker =====

def test_get_stats_includes_p99_p50_keys():
    """get_stats() 应导出 sqlite + applescript 两条路径的 P99/P50."""
    h, _ = _make_handler()
    s = h.get_stats()
    assert "fetch_mail_content_sqlite_p99_ms" in s
    assert "fetch_mail_content_sqlite_p50_ms" in s
    assert "fetch_mail_content_applescript_p99_ms" in s
    assert "fetch_mail_content_applescript_p50_ms" in s
    # empty buffers → 0
    assert s["fetch_mail_content_sqlite_p99_ms"] == 0


def test_p99_p50_reflect_sqlite_hit_latency():
    """SQLite hit 应被 record_latency 累加到 sqlite buffer."""
    repo = _FakeRepo(bodies={42: _FakeBody(html="<p>x</p>", markdown="m")})
    metadata = {42: {"subject": "s", "sender": "x@y.com"}}
    h, _ = _make_handler(repo=repo, metadata=metadata)
    for _ in range(10):
        _run(h.handle_fetch_mail_content({"id": "e1", "properties": {"internal_id": 42}}))
    s = h.get_stats()
    # 10 个采样都进了 sqlite buffer
    assert len(h._latency_sqlite_ms) == 10
    assert len(h._latency_applescript_ms) == 0
    # P50 / P99 应该是非负整数
    assert s["fetch_mail_content_sqlite_p50_ms"] >= 0
    assert s["fetch_mail_content_sqlite_p99_ms"] >= s["fetch_mail_content_sqlite_p50_ms"]


def test_p99_reflects_applescript_fallback_latency():
    """AppleScript fallback 应累加到 applescript buffer."""
    h, _ = _make_handler(
        repo=None, metadata={},
        arm_returns={"subject": "AS", "content": "as", "sender": "x@y.com"},
    )
    for _ in range(5):
        _run(h.handle_fetch_mail_content({"id": "e1", "properties": {"internal_id": 42}}))
    assert len(h._latency_applescript_ms) == 5
    assert len(h._latency_sqlite_ms) == 0


def test_latency_buffer_caps_at_1000():
    """rolling buffer 上限 1000，超出后老样本被丢弃."""
    h, _ = _make_handler()
    # 手动注入 1100 个样本
    for i in range(1100):
        h._record_latency(h._latency_sqlite_ms, i)
    assert len(h._latency_sqlite_ms) == 1000
    # 最早的 100 个被丢弃，最早保留的应该是 100
    assert h._latency_sqlite_ms[0] == 100
    assert h._latency_sqlite_ms[-1] == 1099


def test_percentile_math():
    """P50/P99 计算正确性."""
    h, _ = _make_handler()
    samples = list(range(100))  # 0..99
    assert h._percentile(samples, 0.50) == 50
    assert h._percentile(samples, 0.99) == 99
    # 空 buffer
    assert h._percentile([], 0.99) == 0
