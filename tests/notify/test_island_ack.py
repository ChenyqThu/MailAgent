"""单测：island_ack 解耦 ack pending 登记（契约 §6/§9-4）.

register (mail-sync 进程) / resolve (serve-api 进程) 经 SQLite 跨进程共享；单次消费 +
TTL + evict 旧 token。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.notify import island_ack


@pytest.fixture()
def db(tmp_path: Path) -> str:
    return str(tmp_path / "sync_store.db")


def test_register_resolve_roundtrip(db):
    token = island_ack.register(
        db, kind="mail", session_key="mailagent:email:42",
        event_type="LLMReviewedUrgent",
        metadata={"mailagent.internalId": "42", "mailagent.subject": "Hi"},
        choices={"mark_done", "skip"}, internal_id=42,
    )
    assert token and isinstance(token, str)
    pending = island_ack.resolve(db, token, "mark_done")
    assert pending is not None
    assert pending.kind == "mail"
    assert pending.internal_id == 42
    assert pending.metadata["mailagent.internalId"] == "42"
    assert pending.metadata["mailagent.subject"] == "Hi"
    assert "mark_done" in pending.choices and "skip" in pending.choices


def test_single_use_consumption(db):
    token = island_ack.register(
        db, kind="mail", session_key="mailagent:email:1",
        event_type="LLMReviewedUrgent", metadata={}, choices={"mark_done"},
    )
    assert island_ack.resolve(db, token, "mark_done") is not None
    # 第二次 → None（DELETE...RETURNING 原子单次消费，杜绝双执行）
    assert island_ack.resolve(db, token, "mark_done") is None


def test_choice_not_in_options_rejected(db):
    token = island_ack.register(
        db, kind="mail", session_key="k", event_type="e",
        metadata={}, choices={"mark_done"},
    )
    # choice 不在该 envelope 的 options → None（防伪造/串号）
    assert island_ack.resolve(db, token, "create_draft") is None


def test_expired_pending_rejected(db):
    token = island_ack.register(
        db, kind="mail", session_key="k", event_type="e",
        metadata={}, choices={"x"}, ttl_sec=1.0,
    )
    # 手动把 expires_at 拨到过去，模拟 TTL 过期
    import sqlite3
    conn = sqlite3.connect(db)
    conn.execute("UPDATE island_ack_pending SET expires_at = 1.0 WHERE ack_token=?", (token,))
    conn.commit()
    conn.close()
    assert island_ack.resolve(db, token, "x") is None


def test_reregister_evicts_old_token(db):
    t1 = island_ack.register(
        db, kind="mail", session_key="mailagent:email:9",
        event_type="LLMReviewedUrgent", metadata={}, choices={"x"},
    )
    t2 = island_ack.register(
        db, kind="mail", session_key="mailagent:email:9",
        event_type="LLMReviewedUrgent", metadata={}, choices={"x"},
    )
    assert t1 != t2
    # 同 (session_key, event_type) 重发 → 旧 token 被 evict（只保留最新 envelope 的 ack）
    assert island_ack.resolve(db, t1, "x") is None
    assert island_ack.resolve(db, t2, "x") is not None


def test_different_event_type_coexist(db):
    """同邮件不同 scenario (event_type) 的 ack 并存，互不 evict。"""
    t_mail = island_ack.register(
        db, kind="mail", session_key="mailagent:email:9",
        event_type="MailReceivedUrgent", metadata={}, choices={"x"},
    )
    t_llm = island_ack.register(
        db, kind="mail", session_key="mailagent:email:9",
        event_type="LLMReviewedUrgent", metadata={}, choices={"x"},
    )
    assert island_ack.resolve(db, t_mail, "x") is not None
    assert island_ack.resolve(db, t_llm, "x") is not None


def test_unknown_token_returns_none(db):
    # 表尚未建也不炸（resolve 内 _ensure_table）
    assert island_ack.resolve(db, "bogus-token", "x") is None


def test_empty_inputs_return_none(db):
    assert island_ack.resolve(db, "", "x") is None
    assert island_ack.resolve(db, "tok", "") is None
