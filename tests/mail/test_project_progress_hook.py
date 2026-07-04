"""S5 W5a — new_watcher 项目周报 hook 行内热读的判定逻辑（4 态 + env 回退）。

只测 hook 的**派发决策**（是否 dispatch runner），不跑真 runner / Notion：
  - 总闸 off（_progress_hook_active=False）→ 恒不派发；
  - 行 disabled（row.enabled=0）→ 不派发；
  - 行 enabled + trigger 命中 → 派发；子串-sender / 正则-subject 语义（复用 detector）；
  - 行不存在（老库）→ 回退 env 构造（auto_sync + env sender/subject）。
"""
from __future__ import annotations

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
