"""S5 W5a — new_watcher 项目周报 hook 行内热读的判定逻辑（4 态 + env 回退）。

只测 hook 的**派发决策**（是否 dispatch runner），不跑真 runner / Notion：
  - 总闸 off（_progress_hook_active=False）→ 恒不派发；
  - 行 disabled（row.enabled=0）→ 不派发；
  - 行 enabled + trigger 命中 → 派发；子串-sender / 正则-subject 语义（复用 detector）；
  - 行不存在（老库）→ 回退 env 构造（auto_sync + env sender/subject）。

task 08-20-notification-center M2-B2 追加（本文件末节）：派发出去的后台任务
**结果**进通知中心 —— 无人值守链路失败此前只有一行 log。
"""
from __future__ import annotations

import asyncio
import json
import sqlite3
import types

from src.mail import new_watcher as nw_mod
from src.mail.new_watcher import NewWatcher
from src.project_progress.agent_config import PROJECT_PROGRESS_AGENT_ID


def _email(sender, subject):
    return types.SimpleNamespace(sender=sender, subject=subject, mailbox="收件箱")


def _make_db_with_row(tmp_path, *, enabled, subject, sender):
    db = tmp_path / "s.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE report_agent (id TEXT PRIMARY KEY, type TEXT, enabled INTEGER, trigger_json TEXT)"
    )
    trig = json.dumps(
        {"v": 1, "kind": "email_filter", "subject_pattern": subject, "sender_pattern": sender}
    )
    conn.execute(
        "INSERT INTO report_agent (id, type, enabled, trigger_json) VALUES (?, 'project_progress', ?, ?)",
        (PROJECT_PROGRESS_AGENT_ID, 1 if enabled else 0, trig),
    )
    conn.commit()
    conn.close()
    return db


def _dispatched(monkeypatch, *, hook_active, db_path, email):
    """跑一次 hook，返回是否派发了后台 task（派发 = 命中并起 runner）。"""
    w = NewWatcher.__new__(NewWatcher)
    w._progress_hook_active = hook_active
    w._agent_db_path = str(db_path)

    calls: list = []
    monkeypatch.setattr(w, "_track_bg_task", lambda t: calls.append(t))
    # create_task：关掉协程避免 "never awaited" 警告 + 免 event loop 依赖，返回哨兵。
    monkeypatch.setattr(nw_mod.asyncio, "create_task", lambda coro: (coro.close(), "task")[1])

    # runner 构造成 no-op（命中路径会 `ProjectProgressRunner()`；真类需 Notion，patch 掉）。
    import src.project_progress.runner as runner_mod

    monkeypatch.setattr(runner_mod, "ProjectProgressRunner", lambda *a, **k: object())

    w._maybe_trigger_project_progress_hook(email, 1, "page-id")
    return len(calls) > 0


# ── 4 态 ─────────────────────────────────────────────────────────────────────


def test_master_off_never_dispatches(tmp_path, monkeypatch):
    """总闸 off（_progress_hook_active=False）→ 即便行 enabled + 命中也不派发。"""
    db = _make_db_with_row(tmp_path, enabled=True, subject=r"\[weekly\]", sender="")
    assert not _dispatched(
        monkeypatch, hook_active=False, db_path=db, email=_email("x@x.com", "[weekly] hi")
    )


def test_row_disabled_no_dispatch(tmp_path, monkeypatch):
    db = _make_db_with_row(tmp_path, enabled=False, subject=r"\[weekly\]", sender="")
    assert not _dispatched(
        monkeypatch, hook_active=True, db_path=db, email=_email("x@x.com", "[weekly] hi")
    )


def test_row_enabled_and_match_dispatches(tmp_path, monkeypatch):
    db = _make_db_with_row(tmp_path, enabled=True, subject=r"\[weekly\]", sender="")
    assert _dispatched(
        monkeypatch, hook_active=True, db_path=db, email=_email("x@x.com", "[weekly] hi")
    )


def test_row_enabled_but_no_match_no_dispatch(tmp_path, monkeypatch):
    """pattern 边界：subject 不命中正则 → 不派发。"""
    db = _make_db_with_row(tmp_path, enabled=True, subject=r"^WEEKLY:", sender="")
    assert not _dispatched(
        monkeypatch, hook_active=True, db_path=db, email=_email("x@x.com", "weekly: lower")
    )


def test_sender_substring_semantics(tmp_path, monkeypatch):
    """sender 是子串（非正则）：配 sender 后须双判定，含大小写不敏感。"""
    db = _make_db_with_row(tmp_path, enabled=True, subject=r"\[weekly\]", sender="weekly@corp.com")
    # sender 含子串 + subject 命中 → 派发。
    assert _dispatched(
        monkeypatch, hook_active=True, db_path=db,
        email=_email("WEEKLY@CORP.COM", "[weekly] hi"),
    )
    # sender 不含子串 → 不派发（即便 subject 命中）。
    assert not _dispatched(
        monkeypatch, hook_active=True, db_path=db,
        email=_email("other@x.com", "[weekly] hi"),
    )


# ── env 回退（老库未跑 v31 迁移，行不存在）────────────────────────────────────


def _empty_db(tmp_path):
    db = tmp_path / "old.db"
    conn = sqlite3.connect(str(db))
    conn.execute("CREATE TABLE report_agent (id TEXT PRIMARY KEY, enabled INTEGER, trigger_json TEXT)")
    conn.commit()
    conn.close()
    return db


def test_missing_row_falls_back_to_env(tmp_path, monkeypatch):
    """行不存在 → 回退 env：auto_sync=True + env subject 命中 → 派发。"""
    from src.config import config

    monkeypatch.setattr(config, "project_progress_auto_sync_enabled", True)
    monkeypatch.setattr(config, "project_progress_sender", "")
    monkeypatch.setattr(config, "project_progress_subject_pattern", r"\[weekly\]")
    db = _empty_db(tmp_path)
    assert _dispatched(
        monkeypatch, hook_active=True, db_path=db, email=_email("x@x.com", "[weekly] hi")
    )


def test_missing_row_env_auto_off_no_dispatch(tmp_path, monkeypatch):
    """行不存在 + env auto_sync=False → 不派发（行为等价旧代码 __init__ gate）。"""
    from src.config import config

    monkeypatch.setattr(config, "project_progress_auto_sync_enabled", False)
    monkeypatch.setattr(config, "project_progress_subject_pattern", r"\[weekly\]")
    db = _empty_db(tmp_path)
    assert not _dispatched(
        monkeypatch, hook_active=True, db_path=db, email=_email("x@x.com", "[weekly] hi")
    )


# ── 后台任务结果 → 通知中心（task 08-20-notification-center M2-B2）──────────


def _notify_db(tmp_path):
    """真实 sync_store.db（含 v68 notification 表）。"""
    from src.mail.sync_store import SyncStore

    path = tmp_path / "sync_store.db"
    SyncStore(str(path))
    return str(path)


def _notifications(db_path):
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return [
            dict(r)
            for r in conn.execute("SELECT * FROM notification ORDER BY id").fetchall()
        ]


def _run_hook_bg(monkeypatch, *, tmp_path, notify_db, results):
    """派发 hook 并把它起的后台协程真的跑掉；``results`` 是每次调用的返回值
    （``Exception`` 实例 = 抛出）。"""
    import src.project_progress.runner as runner_mod

    db = _make_db_with_row(tmp_path, enabled=True, subject=r"\[weekly\]", sender="")

    w = NewWatcher.__new__(NewWatcher)
    w._progress_hook_active = True
    w._agent_db_path = str(db)
    w.sync_store = types.SimpleNamespace(db_path=notify_db)

    pending = list(results)

    class _FakeRunner:
        async def sync_from_email(self, **_kw):
            outcome = pending.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    monkeypatch.setattr(runner_mod, "ProjectProgressRunner", lambda *a, **k: _FakeRunner())
    monkeypatch.setattr(w, "_track_bg_task", lambda t: None)

    real_create_task = nw_mod.asyncio.create_task
    coros: list = []
    monkeypatch.setattr(
        nw_mod.asyncio, "create_task", lambda coro: coros.append(coro) or "task"
    )
    for _ in results:
        w._maybe_trigger_project_progress_hook(
            _email("weekly@corp.com", "[weekly] hi"), 42, "page-id"
        )
    monkeypatch.setattr(nw_mod.asyncio, "create_task", real_create_task)

    async def _drain():
        for coro in coros:
            await coro

    asyncio.run(_drain())


def _summary(status, error=None):
    from src.project_progress.runner import SyncSummary

    return SyncSummary(internal_id=42, status=status, error=error)


def test_returned_failed_status_publishes_notification(tmp_path, monkeypatch):
    """🔴 判据是 summary.status —— runner 的多数失败路径**不抛异常**，
    只接 except 分支会漏掉大半失败面。"""
    notify_db = _notify_db(tmp_path)
    _run_hook_bg(
        monkeypatch,
        tmp_path=tmp_path,
        notify_db=notify_db,
        results=[_summary("failed", "parse_xlsx failed: bad zip")],
    )
    rows = _notifications(notify_db)
    assert len(rows) == 1
    assert rows[0]["dedupe_key"] == "project_progress_sync_failed"
    assert rows[0]["category"] == "results"
    assert rows[0]["severity"] == "warn"
    assert rows[0]["source"] == "project_progress"
    assert "parse_xlsx failed" in rows[0]["body"]


def test_raised_exception_also_publishes_and_aggregates(tmp_path, monkeypatch):
    """抛异常同样进通知；连续失败聚合计次，不刷屏。"""
    notify_db = _notify_db(tmp_path)
    _run_hook_bg(
        monkeypatch,
        tmp_path=tmp_path,
        notify_db=notify_db,
        results=[RuntimeError("notion 502"), _summary("failed", "all projects failed")],
    )
    rows = _notifications(notify_db)
    assert len(rows) == 1, "同 dedupe_key 恒一行"
    assert rows[0]["recurrence_no"] == 2
    assert "all projects failed" in rows[0]["body"], "文案刷新为最近一次"


def test_success_resolves_previous_failure(tmp_path, monkeypatch):
    """下一次成功 = 恢复 → 收掉条目。"""
    notify_db = _notify_db(tmp_path)
    _run_hook_bg(
        monkeypatch,
        tmp_path=tmp_path,
        notify_db=notify_db,
        results=[_summary("failed", "boom"), _summary("completed")],
    )
    rows = _notifications(notify_db)
    assert len(rows) == 1 and rows[0]["state"] == "resolved"


def test_skipped_status_is_neither_failure_nor_recovery(tmp_path, monkeypatch):
    """skipped（幂等命中 / 无匹配附件）在写 Notion 之前就短路了 —— 证明不了
    链路已好，不得收掉失败条目，也不新开条目。"""
    notify_db = _notify_db(tmp_path)
    _run_hook_bg(
        monkeypatch,
        tmp_path=tmp_path,
        notify_db=notify_db,
        results=[_summary("failed", "boom"), _summary("skipped")],
    )
    rows = _notifications(notify_db)
    assert len(rows) == 1 and rows[0]["state"] == "open"
    assert rows[0]["recurrence_no"] == 1


def test_notify_center_failure_does_not_break_hook(tmp_path, monkeypatch):
    """通知落库炸（空库没有 notification 表）→ 后台任务照常收尾，不抛。"""
    broken = tmp_path / "empty.db"
    sqlite3.connect(str(broken)).close()
    _run_hook_bg(
        monkeypatch,
        tmp_path=tmp_path,
        notify_db=str(broken),
        results=[_summary("failed", "boom")],
    )
