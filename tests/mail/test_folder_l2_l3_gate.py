"""P2 — 多文件夹同步 L2 (LLM) / L3 (通知) per-folder gate + 下游 pipeline 零改动验证。

- L3 通知降噪: 自定义文件夹默认不刷飞书, FOLDER_NOTIFY_ENABLED 可开。
- L2 LLM gate: 自定义文件夹默认跑 LLM, FOLDER_LLM_DISABLED 可关。
- 下游零改动: 自定义文件夹邮件 save_email → FTS 可搜 + mailbox 过滤正确 (Notion/线程 透传)。
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import List

import pytest

from src.config import Config
from src.mail.backend.imap_client import parse_folder_csv_or_json
from src.mail.new_watcher import (
    NewWatcher,
    is_custom_folder_mailbox,
    should_skip_feishu_for_folder,
    should_skip_llm_for_folder,
)
from src.mail.sync_store import SyncStore


# ============================================================
# is_custom_folder_mailbox
# ============================================================

@pytest.mark.parametrize("mb,expected", [
    ("Jira", True), ("Notion", True), ("DMS固件发布", True),
    ("收件箱", False), ("发件箱", False), ("已发送邮件", False),
    ("草稿", False), ("草稿箱", False), ("", False),
])
def test_is_custom_folder_mailbox(mb, expected):
    assert is_custom_folder_mailbox(mb) is expected


# ============================================================
# L3 通知降噪
# ============================================================

def test_l3_custom_folder_default_no_notify():
    """自定义文件夹默认不通知 (skip=True)。"""
    assert should_skip_feishu_for_folder("Jira", frozenset()) is True


def test_l3_inbox_still_notifies():
    """收件箱不受 gate 影响 (skip=False)。"""
    assert should_skip_feishu_for_folder("收件箱", frozenset()) is False


def test_l3_enabled_folder_notifies():
    """FOLDER_NOTIFY_ENABLED 内的自定义文件夹通知 (skip=False)。"""
    assert should_skip_feishu_for_folder("Jira", frozenset({"Jira"})) is False
    assert should_skip_feishu_for_folder("Notion", frozenset({"Jira"})) is True  # 不在白名单


# ============================================================
# L2 LLM gate
# ============================================================

def test_l2_custom_folder_default_runs_llm():
    """自定义文件夹默认跑 LLM (skip=False)。"""
    assert should_skip_llm_for_folder("Jira", frozenset()) is False


def test_l2_disabled_folder_skips_llm():
    """FOLDER_LLM_DISABLED 内的自定义文件夹跳过 LLM (skip=True)。"""
    assert should_skip_llm_for_folder("Jira", frozenset({"Jira"})) is True
    assert should_skip_llm_for_folder("Notion", frozenset({"Jira"})) is False  # 不在黑名单


def test_l2_inbox_never_skipped():
    """收件箱不受 gate 影响 (即便误配也不 skip)。"""
    assert should_skip_llm_for_folder("收件箱", frozenset({"收件箱"})) is False


# ============================================================
# L2 gate 在 hook 内集成 (dispatch + retry 队列)
# ============================================================

class _StubRunner:
    def __init__(self, ready_rows=None):
        self.calls: List[int] = []
        self._store = self
        self._ready = ready_rows or []

    async def run_for_internal_id(self, internal_id, **kwargs):
        self.calls.append(internal_id)
        return {"ok": True, "internal_id": internal_id, "labels": {}}

    def get_ready_for_retry(self, limit=3):
        return self._ready


class _FakeEmail:
    def __init__(self, mailbox):
        self.subject = "S"
        self.sender = "a@b"
        self.sender_name = "A"
        self.mailbox = mailbox


def _make_watcher(llm_disabled=frozenset(), notify_enabled=frozenset(), ready_rows=None, mailbox_map=None):
    w = NewWatcher.__new__(NewWatcher)
    w._llm_runner = _StubRunner(ready_rows)
    w._folder_llm_disabled = llm_disabled
    w._folder_notify_enabled = notify_enabled
    w._maybe_dispatch_island_reviewed = lambda *a, **k: None
    w._feishu = None

    class _Store:
        def get(self, iid):
            return {"mailbox": (mailbox_map or {}).get(iid, "")}

    w.sync_store = _Store()
    return w


def test_l2_dispatch_skips_disabled_custom_folder():
    """_maybe_trigger_llm_hook: 黑名单自定义文件夹邮件不派发 LLM。"""
    w = _make_watcher(llm_disabled=frozenset({"Jira"}))

    async def _run():
        w._maybe_trigger_llm_hook(_FakeEmail("Jira"), 1, "page")
        await asyncio.sleep(0.02)

    asyncio.run(_run())
    assert w._llm_runner.calls == []   # LLM 未被调用


def test_l2_dispatch_runs_custom_folder_by_default():
    """_maybe_trigger_llm_hook: 非黑名单自定义文件夹默认派发 LLM。"""
    w = _make_watcher(llm_disabled=frozenset())

    async def _run():
        w._maybe_trigger_llm_hook(_FakeEmail("Jira"), 2, "page")
        await asyncio.sleep(0.02)

    asyncio.run(_run())
    assert w._llm_runner.calls == [2]   # LLM 被调用


def test_l2_retry_queue_skips_disabled_folder():
    """_process_llm_retry_queue: 黑名单文件夹的 retry 行也跳过 (codex P2 #1)。"""
    w = _make_watcher(
        llm_disabled=frozenset({"Jira"}),
        ready_rows=[{"internal_id": 10}, {"internal_id": 11}],
        mailbox_map={10: "Jira", 11: "收件箱"},
    )
    asyncio.run(w._process_llm_retry_queue())
    # Jira(10) 跳过; 收件箱(11) 仍 retry
    assert 10 not in w._llm_runner.calls
    assert 11 in w._llm_runner.calls


def test_l2_retry_queue_missing_meta_does_not_skip():
    """retry gate: sync_store.get 返 None (邮件已删/查不到) → mailbox='' 非自定义 → 不跳过, 照常 retry。"""
    w = _make_watcher(
        llm_disabled=frozenset({"Jira"}),
        ready_rows=[{"internal_id": 20}],
        mailbox_map={},   # get() 返 {"mailbox": ""} (无映射)
    )

    # 进一步模拟 get() 返 None 的极端情况
    class _NoneStore:
        def get(self, iid):
            return None

    w.sync_store = _NoneStore()
    asyncio.run(w._process_llm_retry_queue())
    assert 20 in w._llm_runner.calls   # 查不到 folder → 安全默认: 照常处理 (不静默吞)


# ============================================================
# 配置 + 解析
# ============================================================

def test_config_l2_l3_fields_declared():
    f = Config.model_fields
    assert f["folder_notify_enabled"].default == ""
    assert f["folder_llm_disabled"].default == ""


def test_parse_folder_csv_or_json_json():
    assert parse_folder_csv_or_json('["Jira","Notion"]') == ["Jira", "Notion"]


def test_parse_folder_csv_or_json_csv_and_dedup():
    assert parse_folder_csv_or_json("Jira, Notion ,Jira") == ["Jira", "Notion"]


def test_parse_folder_csv_or_json_empty():
    assert parse_folder_csv_or_json("") == []
    assert parse_folder_csv_or_json("  ") == []


# ============================================================
# 下游 pipeline 零改动 (FTS / mailbox 过滤)
# ============================================================

@pytest.fixture
def store(tmp_path: Path) -> SyncStore:
    return SyncStore(str(tmp_path / "s.db"))


def _save_custom_email(store: SyncStore, internal_id: int, mailbox: str, subject: str):
    store.save_email({
        "internal_id": internal_id,
        "message_id": f"<m{internal_id}@x>",
        "subject": subject,
        "sender": "bot@jira.example.com",
        "sender_name": "Jira Bot",
        "date_received": "2026-06-08 10:00:00",
        "mailbox": mailbox,
        "is_read": False,
        "is_flagged": False,
        "thread_id": None,
        "sync_status": "pending",
        "backend_origin": "davmail",
        "imap_uid": internal_id - 1_000_000_000,
        "imap_uidvalidity": 1,
    })


def test_custom_folder_email_saved_with_mailbox(store):
    """自定义文件夹邮件落库 mailbox 字段透传 (Notion 同步据此写 Mailbox Select)。"""
    _save_custom_email(store, 1_000_000_001, "Jira", "PROJ-123 build failed")
    row = store.get(1_000_000_001)
    assert row is not None
    assert row["mailbox"] == "Jira"
    assert row["backend_origin"] == "davmail"


def test_custom_folder_mailbox_filter(store):
    """列表查询按 mailbox 过滤自定义文件夹 (listEnriched/Sidebar 零改动透传)。"""
    _save_custom_email(store, 1_000_000_010, "Jira", "PROJ-1")
    _save_custom_email(store, 1_000_000_011, "Notion", "page updated")
    _save_custom_email(store, 1_000_000_012, "Jira", "PROJ-2")
    res = store.search_emails({"mailbox": "Jira"}, limit=50)
    rows = res.get("emails", res) if isinstance(res, dict) else res
    ids = {r["internal_id"] for r in rows}
    assert 1_000_000_010 in ids and 1_000_000_012 in ids
    assert 1_000_000_011 not in ids  # Notion 不在 Jira 过滤结果


def test_custom_folder_thread_id_passthrough(store):
    """线程 thread_id 透传 (零改动, Parent Item 据此关联)。"""
    store.save_email({
        "internal_id": 1_000_000_020, "message_id": "<reply@x>",
        "subject": "Re: PROJ-5", "sender": "bot@jira", "sender_name": "Jira",
        "date_received": "2026-06-08 11:00:00", "mailbox": "Jira",
        "is_read": False, "is_flagged": False, "thread_id": "<head@x>",
        "sync_status": "pending", "backend_origin": "davmail",
        "imap_uid": 20, "imap_uidvalidity": 1,
    })
    row = store.get(1_000_000_020)
    assert row["thread_id"] == "<head@x>"


def test_custom_folder_email_fts_searchable(store, tmp_path):
    """自定义文件夹邮件进 FTS5 + mailbox 过滤 (零改动, email_body 触发器自动入库)。"""
    import sqlite3

    from src.repository.email_repository import EmailRepository

    _save_custom_email(store, 1_000_000_030, "Jira", "PROJ-999 build status")
    # 插 email_body → 触发 email_body_fts_insert 自动索引 body+subject+sender
    conn = sqlite3.connect(str(store.db_path))
    try:
        conn.execute(
            """INSERT INTO email_body
                 (internal_id, message_id, body_html, body_markdown, body_format,
                  body_size_bytes, has_inline_images, raw_mime_sha256, fetched_at,
                  fetched_source, schema_version)
               VALUES (?, ?, ?, ?, 'html', ?, 0, ?, ?, 'davmail', 1)""",
            (1_000_000_030, "<m1000000030@x>", "<p>redis timeout</p>",
             "redis timeout in custom folder build", 40, "ab" * 32, time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    repo = EmailRepository(str(store.db_path))
    hits = repo.search_email_bodies("redis timeout", limit=10)
    assert 1_000_000_030 in {h.internal_id for h in hits}
    # mailbox 过滤命中
    hits_jira = repo.search_email_bodies("redis timeout", limit=10, mailbox="Jira")
    assert 1_000_000_030 in {h.internal_id for h in hits_jira}
    # 错误 mailbox 不命中
    hits_inbox = repo.search_email_bodies("redis timeout", limit=10, mailbox="收件箱")
    assert 1_000_000_030 not in {h.internal_id for h in hits_inbox}
