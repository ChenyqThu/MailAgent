"""Issue #44 回归: fetch / parse / not-found 失败路径必须走 mark_failed 记账。

根因: ``run_for_internal_id`` 的 LLM 调用失败路径 (runner.py :217/:223/:237) 有完整
``mark_failed`` 记账 (retry_count += 1、退避表推 next_retry_at、超 LLM_MAX_RETRIES 转
gave_up), 但 fetch 失败 (:183) / parse 失败 (:196) / not-found (:152) 三条路径裸
``return {"ok": False, ...}`` 不记账。后果: 已在 LLM retry 队列 (status='failed',
next_retry_at 已过期) 的坏邮件, 每轮 ``get_ready_for_retry`` 选中 → 重跑 → fetch/parse
再失败 → next_retry_at 永不后移 → 无限重试 (生产实测 8911 次), AppleScript 超时场景每轮
烧 ~3min serial executor。本测试对三条路径断言与 LLM-fail 路径一致的记账 + 返回值 merge。
"""
from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from src.config import config as cfg
from src.llm_agent.runner import LLMRunner
from src.llm_agent.store import LLMProcessingStore


_META = {
    "internal_id": 7,
    "message_id": "<m1@x>",
    "notion_page_id": "page123",  # 非空 → 跳过 "not synced to Notion yet" 早退
    "mailbox": "收件箱",
    "subject": "s",
    "is_read": 0,
    "is_flagged": 0,
}


def _patch_lookup(monkeypatch, meta):
    monkeypatch.setattr(
        "src.llm_agent.runner._lookup_by_internal_id",
        lambda iid, db_path=None: (dict(meta) if meta is not None else None),
    )


def _build_runner(tmp_path, *, fetch_result, parse_result):
    """真 store (可断言落库态) + 注入 backend/processor/writer/reader。

    fetch/parse 失败应在 LLM 之前短路, 故 processor/writer 一旦被调即断言失败。
    """
    db_path = str(tmp_path / "s.db")
    store = LLMProcessingStore(db_path=db_path)
    processor = SimpleNamespace(
        process_email=AsyncMock(
            side_effect=AssertionError("LLM must not run on fetch/parse failure")
        ),
        close=AsyncMock(),
    )
    writer = SimpleNamespace(
        write=AsyncMock(side_effect=AssertionError("Notion write must not run"))
    )
    backend = SimpleNamespace(
        fetch_email_content_by_id=Mock(return_value=fetch_result)
    )
    runner = LLMRunner(
        processor=processor,
        writer=writer,
        store=store,
        db_path=db_path,
        backend=backend,
    )
    runner._reader = SimpleNamespace(
        parse_email_source=Mock(return_value=parse_result)
    )
    return runner, store


# ---------------------------------------------------------------------------
# fetch 失败路径 (runner.py :183)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_failure_marks_failed(monkeypatch, tmp_path):
    monkeypatch.setattr(cfg, "llm_max_retries", 3)
    _patch_lookup(monkeypatch, _META)
    runner, store = _build_runner(tmp_path, fetch_result=None, parse_result=None)

    result = await runner.run_for_internal_id(7, force=True)

    assert result["ok"] is False
    # 返回值 merge mark_failed 的 info → new_watcher 日志 retry=/status= 有真值
    assert result["retry_count"] == 1
    assert result["status"] == "failed"
    assert result["next_retry_at"] is not None
    assert result["next_retry_at"] > time.time()
    # DB 态真的落了
    row = store.get(7)
    assert row is not None
    assert row["retry_count"] == 1
    assert row["status"] == "failed"
    assert row["next_retry_at"] is not None


@pytest.mark.asyncio
async def test_fetch_failure_escalates_to_gave_up(monkeypatch, tmp_path):
    monkeypatch.setattr(cfg, "llm_max_retries", 3)
    _patch_lookup(monkeypatch, _META)
    runner, store = _build_runner(tmp_path, fetch_result=None, parse_result=None)

    # retry_count 1(failed) → 2(failed) → 3(gave_up)
    r1 = await runner.run_for_internal_id(7, force=True)
    r2 = await runner.run_for_internal_id(7, force=True)
    r3 = await runner.run_for_internal_id(7, force=True)

    assert (r1["retry_count"], r1["status"]) == (1, "failed")
    assert (r2["retry_count"], r2["status"]) == (2, "failed")
    # 退避后移: next_retry_at 递增 (不再每轮被 get_ready_for_retry 选中)
    assert r2["next_retry_at"] > r1["next_retry_at"]
    assert (r3["retry_count"], r3["status"]) == (3, "gave_up")
    assert r3["next_retry_at"] is None
    assert store.get(7)["status"] == "gave_up"
    # gave_up 后 retry 队列不再选中 → 无限循环止血
    assert store.get_ready_for_retry() == []


# ---------------------------------------------------------------------------
# parse 失败路径 (runner.py :196)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_parse_failure_marks_failed(monkeypatch, tmp_path):
    monkeypatch.setattr(cfg, "llm_max_retries", 3)
    _patch_lookup(monkeypatch, _META)
    runner, store = _build_runner(
        tmp_path,
        fetch_result={"source": "raw", "message_id": "<m1@x>"},
        parse_result=None,
    )

    result = await runner.run_for_internal_id(7, force=True)

    assert result["ok"] is False
    assert "parse_email_source returned None" in result["error"]
    assert result["retry_count"] == 1
    assert result["status"] == "failed"
    assert result["next_retry_at"] is not None
    row = store.get(7)
    assert row["retry_count"] == 1
    assert row["status"] == "failed"


@pytest.mark.asyncio
async def test_parse_failure_escalates_to_gave_up(monkeypatch, tmp_path):
    monkeypatch.setattr(cfg, "llm_max_retries", 3)
    _patch_lookup(monkeypatch, _META)
    runner, store = _build_runner(
        tmp_path,
        fetch_result={"source": "raw", "message_id": "<m1@x>"},
        parse_result=None,
    )

    r1 = await runner.run_for_internal_id(7, force=True)
    r2 = await runner.run_for_internal_id(7, force=True)
    r3 = await runner.run_for_internal_id(7, force=True)

    assert (r1["retry_count"], r1["status"]) == (1, "failed")
    assert (r2["retry_count"], r2["status"]) == (2, "failed")
    assert (r3["retry_count"], r3["status"]) == (3, "gave_up")
    assert store.get(7)["status"] == "gave_up"
    assert store.get_ready_for_retry() == []


# ---------------------------------------------------------------------------
# not-found 路径 (runner.py :152) —— sync_store lookup 返回 None
# ---------------------------------------------------------------------------


def _build_not_found_runner(tmp_path, store):
    return LLMRunner(
        processor=SimpleNamespace(process_email=AsyncMock(), close=AsyncMock()),
        writer=SimpleNamespace(write=AsyncMock()),
        store=store,
        db_path=str(tmp_path / "s.db"),
        backend=SimpleNamespace(fetch_email_content_by_id=Mock()),
    )


@pytest.mark.asyncio
async def test_not_found_with_existing_row_accounts(monkeypatch, tmp_path):
    """llm_processing 有行但 sync_store 无行 (metadata 被删 / 幽灵行清理但 LLM 行仍在
    retry 队列) → 走同一退避记账 → 最终 gave_up, 止住无限重试。"""
    monkeypatch.setattr(cfg, "llm_max_retries", 3)
    store = LLMProcessingStore(db_path=str(tmp_path / "s.db"))
    # 预置一个已在 retry 队列的 failed 行 (retry_count=1)
    store.mark_failed(7, "prior llm failure", max_retries=3)
    assert store.get(7)["retry_count"] == 1

    _patch_lookup(monkeypatch, None)  # sync_store lookup 返回 None
    runner = _build_not_found_runner(tmp_path, store)

    result = await runner.run_for_internal_id(7, force=True)

    assert result["ok"] is False
    assert "not found in sync_store" in result["error"]
    # 记账推进 1 → 2, 且未触碰 fetch (backend 不应被调)
    assert result["retry_count"] == 2
    assert result["status"] == "failed"
    runner._backend.fetch_email_content_by_id.assert_not_called()
    assert store.get(7)["retry_count"] == 2


@pytest.mark.asyncio
async def test_not_found_without_row_no_orphan(monkeypatch, tmp_path):
    """id 在任何表都不存在 (CLI typo 等) → 返回错误但不建 llm_processing 孤儿行
    (不在任何 retry 队列 → 无无限循环风险, 无需引入新状态语义)。"""
    store = LLMProcessingStore(db_path=str(tmp_path / "s.db"))
    _patch_lookup(monkeypatch, None)
    runner = _build_not_found_runner(tmp_path, store)

    result = await runner.run_for_internal_id(999, force=True)

    assert result["ok"] is False
    assert "not found in sync_store" in result["error"]
    assert store.get(999) is None  # 无孤儿行
