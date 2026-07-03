"""new_watcher 第 5 hook (_maybe_trigger_custom_agents) 端到端（S4 W1, ADR D5）。

用 ``NewWatcher.__new__`` 绕过重构造，只装 hook 依赖属性。验证 flag off 零行为 /
命中入队 / 幂等去重 / 异常不阻断主流程。
"""
from __future__ import annotations

import asyncio
import json

import pytest

from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore
from src.reports.store import ReportStore
from src.sync.async_jobs import AsyncJobRepository


class _FakeEmail:
    def __init__(self, sender, subject, mailbox):
        self.sender = sender
        self.subject = subject
        self.mailbox = mailbox


def _watcher(enabled, store, repo):
    w = NewWatcher.__new__(NewWatcher)
    w._custom_agents_enabled = enabled
    w._agent_store = store
    w._agent_job_repo = repo
    w._bg_tasks = set()
    return w


def _seed_custom_agent(store, agent_id, trigger, enabled=True):
    store.create_agent(agent_id, type="custom", enabled=enabled, title="t")
    store.update_agent(agent_id, {"trigger_json": json.dumps(trigger)})


async def _drain(watcher):
    tasks = list(watcher._bg_tasks)
    if tasks:
        await asyncio.gather(*tasks)


@pytest.fixture
def env(tmp_path):
    db = tmp_path / "s.db"
    SyncStore(str(db))
    return ReportStore(str(db)), AsyncJobRepository(str(db))


@pytest.mark.asyncio
async def test_flag_off_no_dispatch(env):
    store, repo = env
    _seed_custom_agent(store, "a1", {"v": 1, "kind": "email_filter", "folders": ["收件箱"]})
    w = _watcher(False, store, repo)  # flag off
    w._maybe_trigger_custom_agents(_FakeEmail("a@b.com", "x", "收件箱"), 1)
    assert not w._bg_tasks            # 主循环立即返回，不派发
    await _drain(w)
    assert repo.count_agent_runs_since("a1", 0) == 0


@pytest.mark.asyncio
async def test_no_custom_agents_no_dispatch(env):
    store, repo = env
    # 只有 report agent（无 custom）→ 存在性检查为空 → 不派发 bg task。
    w = _watcher(True, store, repo)
    w._maybe_trigger_custom_agents(_FakeEmail("a@b.com", "x", "收件箱"), 1)
    assert not w._bg_tasks
    await _drain(w)


@pytest.mark.asyncio
async def test_matched_enqueues(env):
    store, repo = env
    _seed_custom_agent(store, "a1", {"v": 1, "kind": "email_filter", "subject_pattern": "DMS",
                                     "folders": ["收件箱"]})
    w = _watcher(True, store, repo)
    w._maybe_trigger_custom_agents(_FakeEmail("dms@corp.com", "DMS 审批", "收件箱"), 42)
    assert w._bg_tasks                # 派发了 bg task
    await _drain(w)
    assert repo.count_agent_runs_since("a1", 0) == 1


@pytest.mark.asyncio
async def test_unmatched_no_enqueue(env):
    store, repo = env
    _seed_custom_agent(store, "a1", {"v": 1, "kind": "email_filter", "subject_pattern": "DMS"})
    w = _watcher(True, store, repo)
    w._maybe_trigger_custom_agents(_FakeEmail("x@y.com", "普通邮件", "收件箱"), 42)
    await _drain(w)
    assert repo.count_agent_runs_since("a1", 0) == 0


@pytest.mark.asyncio
async def test_idempotent_same_internal_id(env):
    store, repo = env
    _seed_custom_agent(store, "a1", {"v": 1, "kind": "email_filter", "folders": ["收件箱"]})
    w = _watcher(True, store, repo)
    email = _FakeEmail("a@b.com", "x", "收件箱")
    w._maybe_trigger_custom_agents(email, 7)
    await _drain(w)
    w._bg_tasks = set()
    w._maybe_trigger_custom_agents(email, 7)  # 同 internal_id 重放
    await _drain(w)
    assert repo.count_agent_runs_since("a1", 0) == 1  # 幂等去重


@pytest.mark.asyncio
async def test_store_exception_does_not_raise(env):
    _, repo = env

    class _BadStore:
        def list_agents(self):
            raise RuntimeError("boom")

    w = _watcher(True, _BadStore(), repo)
    # 异常只 warning，不抛（不阻断主同步流程）。
    w._maybe_trigger_custom_agents(_FakeEmail("a@b.com", "x", "收件箱"), 1)
    assert not w._bg_tasks
