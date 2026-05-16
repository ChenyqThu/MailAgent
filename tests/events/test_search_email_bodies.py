"""Tests for EventHandlers.handle_search_email_bodies (v4 Phase 3).

Covers:
- 基本搜索成功 → hits 拼装
- 缺 query / 空 query → error
- email_repo=None → error
- limit cap 到 200
- mailbox / since_date / until_date 透传给 repo
- repo 抛异常 → error，stats 计数
- 命中/空命中分别走 hits/empty 计数
- latency_ms 与 P50/P99 buffer
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import pytest

from src.events.handlers import EventHandlers
from src.repository import EmailSearchHit


# ============================================================
# Fakes
# ============================================================

class _FakeArm:
    def fetch_email_content_by_id(self, internal_id, mailbox):
        return None


class _FakeSyncStore:
    def get(self, internal_id):
        return None

    def get_by_message_id(self, mid):
        return None


class _FakeRepo:
    """记录调用参数 + 可配置返回值/异常."""

    def __init__(self, hits: Optional[List[EmailSearchHit]] = None, *, raises: Optional[Exception] = None):
        self._hits = hits or []
        self._raises = raises
        self.calls: List[Dict[str, Any]] = []

    def search_email_bodies(self, query, *, limit=50, mailbox=None, since_date=None, until_date=None):
        self.calls.append({
            "query": query, "limit": limit, "mailbox": mailbox,
            "since_date": since_date, "until_date": until_date,
        })
        if self._raises:
            raise self._raises
        return self._hits

    # handle_fetch_mail_content 也会拿到 repo，但单测里不会触发它的路径


def _make_handler(*, repo: Optional[_FakeRepo] = None):
    captured: Dict[str, Any] = {}

    async def _capture(event_id, payload):
        captured["event_id"] = event_id
        captured["payload"] = payload

    h = EventHandlers(
        arm=_FakeArm(),
        sync_store=_FakeSyncStore(),
        feishu=None,
        notion_sync=None,
        result_callback=_capture,
        email_repo=repo,
    )
    return h, captured


def _run(coro):
    return asyncio.run(coro)


def _hit(internal_id=1, **overrides):
    base = dict(
        internal_id=internal_id,
        subject="s",
        sender="a@b.c",
        date_received="2026-05-15",
        mailbox="收件箱",
        snippet="...<mark>x</mark>...",
        rank=-1.5,
        notion_page_id="pg",
        notion_url="https://www.notion.so/pg",
    )
    base.update(overrides)
    return EmailSearchHit(**base)


# ============================================================
# Validation
# ============================================================

def test_missing_query_returns_error():
    h, captured = _make_handler(repo=_FakeRepo())
    _run(h.handle_search_email_bodies({"id": "e1", "properties": {}}))
    p = captured["payload"]
    assert p["status"] == "error"
    assert "query" in p["error"].lower()
    assert h._stats["search_email_bodies_error"] == 1


def test_empty_query_string_returns_error():
    h, captured = _make_handler(repo=_FakeRepo())
    _run(h.handle_search_email_bodies({"id": "e1", "properties": {"query": "   "}}))
    assert captured["payload"]["status"] == "error"


def test_no_repo_returns_error():
    """email_repo=None → 上层未启用 v4 → search 不可用."""
    h, captured = _make_handler(repo=None)
    _run(h.handle_search_email_bodies({
        "id": "e1", "properties": {"query": "test"},
    }))
    p = captured["payload"]
    assert p["status"] == "error"
    assert "EmailRepository" in p["error"]


# ============================================================
# Success path
# ============================================================

def test_basic_search_returns_hits():
    hits = [_hit(internal_id=10), _hit(internal_id=20, rank=-1.0)]
    repo = _FakeRepo(hits=hits)
    h, captured = _make_handler(repo=repo)

    _run(h.handle_search_email_bodies({
        "id": "e1", "properties": {"query": "meeting"},
    }))

    p = captured["payload"]
    assert p["status"] == "success"
    assert p["query"] == "meeting"
    assert p["total_hits"] == 2
    assert len(p["hits"]) == 2
    assert p["hits"][0]["internal_id"] == 10
    assert p["hits"][0]["snippet"] == "...<mark>x</mark>..."
    assert p["hits"][0]["rank"] == -1.5
    assert p["hits"][0]["notion_url"] == "https://www.notion.so/pg"
    assert "latency_ms" in p
    assert h._stats["search_email_bodies"] == 1
    assert h._stats["search_email_bodies_hits"] == 2


def test_empty_hits_counted_as_empty():
    repo = _FakeRepo(hits=[])
    h, captured = _make_handler(repo=repo)
    _run(h.handle_search_email_bodies({
        "id": "e1", "properties": {"query": "nomatch"},
    }))
    p = captured["payload"]
    assert p["status"] == "success"
    assert p["total_hits"] == 0
    assert p["hits"] == []
    assert h._stats["search_email_bodies_hits"] == 0
    assert h._stats["search_email_bodies_empty"] == 1


# ============================================================
# Parameter passthrough
# ============================================================

def test_limit_passthrough_and_caps_at_200():
    repo = _FakeRepo()
    h, _ = _make_handler(repo=repo)

    _run(h.handle_search_email_bodies({
        "id": "e1", "properties": {"query": "x", "limit": 25},
    }))
    assert repo.calls[-1]["limit"] == 25

    # cap 200
    _run(h.handle_search_email_bodies({
        "id": "e2", "properties": {"query": "x", "limit": 10000},
    }))
    assert repo.calls[-1]["limit"] == 200

    # 负数 → 至少 1
    _run(h.handle_search_email_bodies({
        "id": "e3", "properties": {"query": "x", "limit": -5},
    }))
    assert repo.calls[-1]["limit"] == 1


def test_invalid_limit_falls_back_to_50():
    repo = _FakeRepo()
    h, _ = _make_handler(repo=repo)
    _run(h.handle_search_email_bodies({
        "id": "e1", "properties": {"query": "x", "limit": "abc"},
    }))
    assert repo.calls[-1]["limit"] == 50


def test_mailbox_and_date_filters_passthrough():
    repo = _FakeRepo()
    h, _ = _make_handler(repo=repo)
    _run(h.handle_search_email_bodies({
        "id": "e1",
        "properties": {
            "query": "x",
            "mailbox": "发件箱",
            "since_date": "2026-01-01",
            "until_date": "2026-06-01",
        },
    }))
    c = repo.calls[-1]
    assert c["mailbox"] == "发件箱"
    assert c["since_date"] == "2026-01-01"
    assert c["until_date"] == "2026-06-01"


def test_missing_optional_filters_pass_none():
    repo = _FakeRepo()
    h, _ = _make_handler(repo=repo)
    _run(h.handle_search_email_bodies({
        "id": "e1", "properties": {"query": "x"},
    }))
    c = repo.calls[-1]
    assert c["mailbox"] is None
    assert c["since_date"] is None
    assert c["until_date"] is None


# ============================================================
# Error handling
# ============================================================

def test_repo_exception_returns_error():
    repo = _FakeRepo(raises=RuntimeError("simulated repo failure"))
    h, captured = _make_handler(repo=repo)
    _run(h.handle_search_email_bodies({
        "id": "e1", "properties": {"query": "x"},
    }))
    p = captured["payload"]
    assert p["status"] == "error"
    assert "simulated repo failure" in p["error"]
    assert h._stats["search_email_bodies_error"] == 1


# ============================================================
# Latency / stats
# ============================================================

def test_latency_recorded_to_search_buffer():
    repo = _FakeRepo(hits=[_hit()])
    h, _ = _make_handler(repo=repo)
    for _ in range(5):
        _run(h.handle_search_email_bodies({
            "id": "e1", "properties": {"query": "x"},
        }))
    assert len(h._latency_search_ms) == 5


def test_get_stats_includes_search_p99_p50():
    h, _ = _make_handler(repo=_FakeRepo())
    s = h.get_stats()
    assert "search_email_bodies_p99_ms" in s
    assert "search_email_bodies_p50_ms" in s
    assert s["search_email_bodies_p50_ms"] == 0  # 空 buffer


def test_error_path_does_not_pollute_search_buffer():
    """validation 失败的请求不应该污染 latency 统计."""
    h, _ = _make_handler(repo=None)  # 让请求走 error 路径
    _run(h.handle_search_email_bodies({"id": "e1", "properties": {"query": "x"}}))
    assert len(h._latency_search_ms) == 0
