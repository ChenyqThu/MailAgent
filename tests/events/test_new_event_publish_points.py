"""perf-sse-realtime R1 — 新增 SSE 发布点的行为闸（folder.changed / contact.changed /
matter.run.changed / matter.attention public_ids）。

统一 patch ``src.events.publisher.safe_publish``：这些发布点全部走**调用时**懒 import
（``from src.events.publisher import safe_publish``），patch 模块属性即可拦截。
钉死的语义：

- folder_pref 写：真动了行才发（无行迁移/无删除 = 无事件），事件带 action + imap_name
- 扫描 tick：processed=0 的空轮**不发**（否则每个空 tick 都打一次事件桥）
- matter run lifecycle：queued/started/终态各一条，payload 是 **public_id**（硬规则，
  ``docs/reference/integrations/sse-events.md``）；幂等 finish 不重复发
- matter.attention 的 id 映射：内部数字主键 → public_id，映射失败返 [] 让消费端
  回落全量失效
"""

from __future__ import annotations

import sqlite3
from unittest.mock import patch

from src.mail.email_address import derive_sender_email
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import MatterService
from src.matters.worker import MatterAgendaWorker

NOW = 1_800_000_000_000


def _events(mock, event_type):
    """按事件名过滤 mock 捕获的 (event_type, kwargs) 列表。"""
    return [
        call.kwargs
        for call in mock.call_args_list
        if call.args and call.args[0] == event_type
    ]


# ============================================================
# folder.changed — folder_pref 写点 (sync_store.py)
# ============================================================

def test_folder_pref_upsert_publishes_folder_changed(tmp_path):
    store = SyncStore(str(tmp_path / "a.db"))
    with patch("src.events.publisher.safe_publish") as publish:
        row = store.upsert_folder_pref("Projects/X", notify_enabled=True)
    assert row is not None
    events = _events(publish, "folder.changed")
    assert len(events) == 1
    assert events[0]["data"] == {"action": "pref", "imap_name": "Projects/X"}


def test_folder_pref_rename_publishes_only_when_rows_moved(tmp_path):
    store = SyncStore(str(tmp_path / "b.db"))
    store.upsert_folder_pref("Projects/X", notify_enabled=True)
    with patch("src.events.publisher.safe_publish") as publish:
        moved = store.rename_folder_pref("Projects/X", "Projects/Y")
        # 无对应行的重命名 = 无可见变化 = 不发
        not_moved = store.rename_folder_pref("Nope", "Nope2")
    assert moved == 1 and not_moved == 0
    events = _events(publish, "folder.changed")
    assert [e["data"]["action"] for e in events] == ["pref_rename"]
    assert events[0]["data"]["imap_name"] == "Projects/Y"


def test_folder_pref_delete_publishes_only_when_rows_deleted(tmp_path):
    store = SyncStore(str(tmp_path / "c.db"))
    store.upsert_folder_pref("Projects/X")
    with patch("src.events.publisher.safe_publish") as publish:
        deleted = store.delete_folder_pref("Projects/X")
        none_deleted = store.delete_folder_pref("Projects/X")
    assert deleted == 1 and none_deleted == 0
    events = _events(publish, "folder.changed")
    assert [e["data"]["action"] for e in events] == ["pref_delete"]


# ============================================================
# contact.changed — 扫描 tick (contacts/scanner.py)
# ============================================================

def test_scan_publishes_contact_changed_only_when_processed(tmp_path):
    from src.contacts.scanner import run_scan

    db = str(tmp_path / "scan.db")
    SyncStore(db)
    # 空库首轮: processed=0 → 不发
    with patch("src.events.publisher.safe_publish") as publish:
        run_scan(db, self_addresses=frozenset({"me@corp.com"}), now_ms=NOW)
    assert _events(publish, "contact.changed") == []

    # 播一封邮件 (列形状对齐 tests/contacts/test_scanner.py 的生产口径)
    with sqlite3.connect(db) as conn:
        sender = "alice@x.com"
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sender, sender_email, "
            "sender_name, to_addr, cc_addr, date_received, mailbox) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (1, sender, derive_sender_email(sender), "Alice",
             "Me <me@corp.com>", None, "2026-08-01T08:00:00+00:00", "收件箱"),
        )
        conn.commit()
    with patch("src.events.publisher.safe_publish") as publish:
        totals = run_scan(db, self_addresses=frozenset({"me@corp.com"}), now_ms=NOW)
    assert totals["processed"] == 1
    events = _events(publish, "contact.changed")
    assert len(events) == 1
    assert events[0]["data"]["scope"] == "scan"


# ============================================================
# matter.run.changed — run lifecycle (matters/run_service.py)
# ============================================================

def _matter_services(tmp_path):
    path = str(tmp_path / "runs.db")
    SyncStore(path)
    repo = MatterRepository(path)
    return (
        MatterService(repo, clock_ms=lambda: NOW),
        MatterRunService(repo, clock_ms=lambda: NOW),
        repo,
    )


def test_matter_run_lifecycle_publishes_public_id(tmp_path):
    service, run_service, _repo = _matter_services(tmp_path)
    matter = service.create_matter(
        {"title": "t"}, idempotency_key="c", source="test"
    )["matter"]
    public_id = matter["public_id"]

    with patch("src.events.publisher.safe_publish") as publish:
        run = run_service.enqueue_run(
            public_id, idempotency_key="r1", source="test"
        )["run"]
        run_service.mark_started(run["id"])
        assert run_service.finish_run(run["id"], "ok") is True
        # 幂等 finish: 已终态 → False, 不再发事件
        assert run_service.finish_run(run["id"], "ok") is False

    events = _events(publish, "matter.run.changed")
    assert len(events) == 3, "queued/started/终态各一条, 幂等重放不发"
    for kwargs in events:
        assert kwargs["data"]["public_id"] == public_id, (
            "🔴 matter 系事件必须发 public_id, 不是内部数字主键"
        )
        assert kwargs["data"]["run_id"] == run["id"]


def test_matter_run_enqueue_idempotent_replay_does_not_publish(tmp_path):
    service, run_service, _repo = _matter_services(tmp_path)
    matter = service.create_matter(
        {"title": "t"}, idempotency_key="c", source="test"
    )["matter"]
    run_service.enqueue_run(matter["public_id"], idempotency_key="r1", source="test")
    with patch("src.events.publisher.safe_publish") as publish:
        replay = run_service.enqueue_run(
            matter["public_id"], idempotency_key="r1", source="test"
        )
    assert replay["coalesced"] is False
    assert _events(publish, "matter.run.changed") == []


# ============================================================
# matter.attention — 数字 id → public_id 映射 (matters/worker.py)
# ============================================================

def test_attention_public_id_mapping(tmp_path):
    service, _run_service, repo = _matter_services(tmp_path)
    a = service.create_matter({"title": "a"}, idempotency_key="a", source="test")["matter"]
    b = service.create_matter({"title": "b"}, idempotency_key="b", source="test")["matter"]
    worker = MatterAgendaWorker(repository=repo, sync_store=None)
    with repo.connect() as conn:
        ids = [
            int(conn.execute(
                "SELECT id FROM matter WHERE public_id=?", (pid,)
            ).fetchone()["id"])
            for pid in (a["public_id"], b["public_id"])
        ]
    assert worker._public_ids_for(ids) == [a["public_id"], b["public_id"]]
    # 未知 id 被丢弃 (不 raise、不产出 None 占位)
    assert worker._public_ids_for(ids + [999_999]) == [a["public_id"], b["public_id"]]
    assert worker._public_ids_for([]) == []
