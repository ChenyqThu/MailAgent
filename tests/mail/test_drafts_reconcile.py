"""草稿箱同步 (DRAFTS_SYNC_ENABLED) — reconcile 对账 + watcher 接线 + 草稿 gate。

- backend.reconcile_drafts: 静止态零 SELECT / 新增→to_add / 消失→to_delete /
  编辑(删旧加新) / UIDVALIDITY 变化→全删重拉 / 开关关→noop。
- watcher._reconcile_drafts: to_add 入库 (pending) + to_delete 走 delete_email_full;
  AppleScript backend (无 reconcile_drafts) → noop。
- watcher._sync_single_email_v3 草稿分支: 不进 Notion / 会议检测, dual-write 后
  mark_synced_local (sync_status='synced', notion_page_id NULL)。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from src.mail.backend.davmail_backend import DavMailBackend
from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore


# ============================================================
# FakeImap — reconcile 调用序列: STATUS → SELECT → UID SEARCH ALL →
# (_fetch_new_in_folder: SELECT → UID SEARCH UID csv → UID FETCH)
# ============================================================

class FakeImap:
    def __init__(self, uidvalidity: int, uids: list[int], messages: dict):
        # messages: uid -> (message_id, subject)
        self.uidvalidity = uidvalidity
        self.uids = list(uids)
        self.messages = messages
        self.untagged_responses = {}
        self.select_calls: list[str] = []
        self.status_calls: list[str] = []
        self.fetched: list[int] = []

    @staticmethod
    def _unquote(name):
        if len(name) >= 2 and name[0] == '"' and name[-1] == '"':
            return name[1:-1]
        return name

    def status(self, folder, what):
        self.status_calls.append(self._unquote(folder))
        uidnext = (max(self.uids) + 1) if self.uids else 1
        return (
            "OK",
            [
                f"{folder} (MESSAGES {len(self.uids)} UIDNEXT {uidnext} "
                f"UIDVALIDITY {self.uidvalidity})".encode()
            ],
        )

    def select(self, folder, readonly=False):
        self.select_calls.append(self._unquote(folder))
        self.untagged_responses = {"UIDVALIDITY": [str(self.uidvalidity).encode()]}
        return ("OK", [b"1 EXISTS"])

    def uid(self, cmd, *args):
        if cmd == "search":
            parts = [a for a in args if a is not None]
            if parts == ["ALL"]:
                hit = self.uids
            elif parts and parts[0] == "UID":
                want = {int(x) for x in str(parts[1]).split(",")}
                hit = [u for u in self.uids if u in want]
            else:  # pragma: no cover — 未预期 criteria
                raise AssertionError(f"unexpected search criteria {parts}")
            return ("OK", [" ".join(str(u) for u in hit).encode()])
        if cmd == "fetch":
            uids = [int(x) for x in str(args[0]).split(",")]
            self.fetched.extend(uids)
            data = []
            for u in uids:
                msgid, subj = self.messages[u]
                meta = f"1 (UID {u} FLAGS (\\Seen \\Draft) BODY[HEADER.FIELDS] {{50}}".encode()
                body = (
                    f"Message-ID: <{msgid}>\r\n"
                    f"Subject: {subj}\r\n"
                    f"Date: Sat, 1 Jan 2026 10:00:00 +0000\r\n\r\n"
                ).encode()
                data.append((meta, body))
            return ("OK", data)
        raise AssertionError(f"unexpected uid cmd {cmd}")


def _backend(
    fake: FakeImap,
    *,
    local: dict[int, int],
    sync_drafts: bool = True,
    drafts_folder: str | None = "Drafts",
    kv: dict | None = None,
):
    b = DavMailBackend.__new__(DavMailBackend)
    b.cfg = MagicMock()
    b.cfg.folder_sync_max_messages = 0
    b.cfg.folder_sync_past_days = 90
    b.cfg.sync_start_date = "2026-01-01"
    kv = {} if kv is None else kv
    b.sync_store = MagicMock()
    b.sync_store.get_state = lambda k: kv.get(k)
    b.sync_store.set_state = lambda k, v: kv.__setitem__(k, v) or True
    counter = {"n": 1_000_000_000}

    def _alloc():
        counter["n"] += 1
        return counter["n"]

    b.sync_store.allocate_davmail_internal_id = _alloc
    b.inbox_uidvalidity = None
    b.drafts_folder = drafts_folder
    b._sync_drafts = sync_drafts
    b._folder_imap_uid_map = MagicMock(return_value=dict(local))
    # grace window 直通 (真方法连 SQLite 查 created_at; 这里 sync_store 是 mock,
    # 连库会炸 → fail-safe 返回 [] 打翻 to_delete 断言)。grace 行为有独立用例。
    b._filter_recent_rows = lambda ids, grace_sec: ids
    b._fake = fake
    b._kv = kv
    return b


@pytest.fixture
def patch_session(monkeypatch):
    def _patch(backend):
        from contextlib import contextmanager

        @contextmanager
        def _sess(cfg, timeout=60):
            yield backend._fake

        monkeypatch.setattr(
            "src.mail.backend.davmail_backend.imap_session", _sess
        )

    return _patch


# ============================================================
# backend.reconcile_drafts
# ============================================================

def test_disabled_noop(patch_session):
    fake = FakeImap(7, [101], {101: ("m1", "d1")})
    b = _backend(fake, local={}, sync_drafts=False)
    patch_session(b)
    assert b.reconcile_drafts() == ([], [])
    assert fake.status_calls == []  # 开关关 → 零 IMAP 调用


def test_no_drafts_folder_noop(patch_session):
    fake = FakeImap(7, [101], {101: ("m1", "d1")})
    b = _backend(fake, local={}, drafts_folder=None)
    patch_session(b)
    assert b.reconcile_drafts() == ([], [])
    assert fake.status_calls == []


def test_steady_state_zero_select(patch_session):
    """STATUS 快照 (MESSAGES/UIDNEXT/UIDVALIDITY) 与本地一致 → 零 SELECT。"""
    fake = FakeImap(7, [101, 102], {101: ("m1", "d1"), 102: ("m2", "d2")})
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "103"}
    b = _backend(fake, local={101: 11, 102: 12}, kv=kv)
    patch_session(b)
    assert b.reconcile_drafts() == ([], [])
    assert fake.status_calls == ["Drafts"]
    assert fake.select_calls == []


def test_new_draft_to_add(patch_session):
    fake = FakeImap(7, [101, 105], {101: ("m1", "d1"), 105: ("m5", "d5")})
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "102"}
    b = _backend(fake, local={101: 11}, kv=kv)
    patch_session(b)
    to_add, to_delete = b.reconcile_drafts()
    assert to_delete == []
    assert len(to_add) == 1
    item = to_add[0]
    assert item["imap_uid"] == 105
    assert item["mailbox"] == "草稿箱"
    assert item["backend_origin"] == "davmail"
    assert item["message_id"] == "m5"  # _parse_batch_headers 剥尖括号
    assert fake.fetched == [105]  # 只拉新 UID
    assert b._kv["drafts_uidnext"] == "106"  # 快照推进


def test_vanished_draft_to_delete(patch_session):
    """草稿被发送/删除 → 本地行进 to_delete。"""
    fake = FakeImap(7, [101], {101: ("m1", "d1")})
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "103"}
    b = _backend(fake, local={101: 11, 102: 12}, kv=kv)
    patch_session(b)
    to_add, to_delete = b.reconcile_drafts()
    assert to_add == []
    assert to_delete == [12]


def test_edit_replaces_uid(patch_session):
    """编辑草稿 = Exchange 删旧 UID 加新 UID → 同时 to_add + to_delete。"""
    fake = FakeImap(7, [102], {102: ("m2", "d1-edited")})
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "102"}
    b = _backend(fake, local={101: 11}, kv=kv)
    patch_session(b)
    to_add, to_delete = b.reconcile_drafts()
    assert to_delete == [11]
    assert [i["imap_uid"] for i in to_add] == [102]


def test_uidvalidity_change_full_rebuild(patch_session):
    """UIDVALIDITY 变化 → 本地全删 + 远端全拉。"""
    fake = FakeImap(9, [201], {201: ("m9", "d9")})
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "202"}
    b = _backend(fake, local={101: 11}, kv=kv)
    patch_session(b)
    to_add, to_delete = b.reconcile_drafts()
    assert to_delete == [11]
    assert [i["imap_uid"] for i in to_add] == [201]
    assert b._kv["folder_uidvalidity:Drafts"] == "9"


# ============================================================
# watcher._reconcile_drafts — 入库 / 删除 / AppleScript noop
# ============================================================

def _watcher(tmp_path: Path):
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = SyncStore(str(tmp_path / "t.db"))
    w.email_repo = MagicMock()
    return w


def test_watcher_reconcile_adds_and_deletes(tmp_path):
    w = _watcher(tmp_path)
    to_add = [{
        "internal_id": 1_000_000_001,
        "message_id": "<m5>",
        "subject": "d5",
        "sender": "me@x.com",
        "sender_name": "Me",
        "date_received": "2026-01-01T10:00:00+00:00",
        "mailbox": "草稿箱",
        "is_read": True,
        "is_flagged": False,
        "thread_id": None,
        "backend_origin": "davmail",
        "imap_uid": 105,
        "imap_uidvalidity": 7,
    }]

    class _Backend:
        def reconcile_drafts(self):
            return to_add, [999]

    w.arm = _Backend()
    asyncio.run(w._reconcile_drafts())
    row = w.sync_store.get(1_000_000_001)
    assert row is not None
    assert row["mailbox"] == "草稿箱"
    assert row["sync_status"] == "pending"
    assert row["imap_uid"] == 105
    w.email_repo.delete_email_full.assert_called_once_with(999)


def test_watcher_reconcile_noop_without_capability(tmp_path):
    """AppleScript backend 无 reconcile_drafts → 整段 noop 不炸。"""
    w = _watcher(tmp_path)
    w.arm = object()  # 无 reconcile_drafts 属性
    asyncio.run(w._reconcile_drafts())
    w.email_repo.delete_email_full.assert_not_called()


def test_watcher_reconcile_failure_isolated(tmp_path):
    """backend 对账抛异常 → 吞掉, 不影响主循环。"""
    w = _watcher(tmp_path)

    class _Boom:
        def reconcile_drafts(self):
            raise RuntimeError("imap down")

    w.arm = _Boom()
    asyncio.run(w._reconcile_drafts())  # 不抛


# ============================================================
# watcher._sync_single_email_v3 — 草稿分支 (不进 Notion)
# ============================================================

def test_sync_single_draft_local_only(tmp_path):
    w = _watcher(tmp_path)
    w.sync_store.save_email({
        "internal_id": 1_000_000_002,
        "subject": "draft",
        "sender": "me@x.com",
        "mailbox": "草稿箱",
        "sync_status": "pending",
        "backend_origin": "davmail",
        "imap_uid": 105,
        "imap_uidvalidity": 7,
    })
    w.arm = MagicMock()
    w.arm.fetch_email_content_by_id.return_value = {
        "message_id": "<m5>",
        "thread_id": None,
        "subject": "draft",
        "sender": "me@x.com",
        "source": "raw-mime",
    }
    w.meeting_sync = MagicMock()
    w.notion_sync = MagicMock()
    w._stats = {"emails_synced": 0}
    w._maybe_dual_write_body = MagicMock()

    email_obj = SimpleNamespace(
        to="", cc="", sender_name="", is_important=False, internal_id=None
    )

    async def _build(full_email, mailbox):
        return email_obj

    w._build_email_object = _build

    asyncio.run(w._sync_single_email_v3({
        "internal_id": 1_000_000_002,
        "mailbox": "草稿箱",
        "subject": "draft",
    }))

    # 不进 Notion / 不做会议检测; dual-write 跑了; 终态 synced 且无 Notion 页
    w.notion_sync.create_email_page_v2.assert_not_called()
    w.meeting_sync.has_meeting_invite.assert_not_called()
    w._maybe_dual_write_body.assert_called_once()
    row = w.sync_store.get(1_000_000_002)
    assert row["sync_status"] == "synced"
    assert row["notion_page_id"] is None
    assert w._stats["emails_synced"] == 1

# ============================================================
# grace window — reconcile 不误删刚即时落库的草稿
# ============================================================

def test_filter_recent_rows_keeps_fresh(tmp_path):
    """创建 < grace_sec 的行不进 to_delete (davmail folder 缓存 stale 保护)。"""
    import sqlite3 as _sq
    import time as _t

    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1, "subject": "old", "sender": "a@x", "mailbox": "草稿箱",
        "sync_status": "synced", "backend_origin": "davmail", "imap_uid": 10,
    })
    store.save_email({
        "internal_id": 2, "subject": "fresh", "sender": "a@x", "mailbox": "草稿箱",
        "sync_status": "pending", "backend_origin": "davmail", "imap_uid": 11,
    })
    conn = _sq.connect(str(tmp_path / "t.db"))
    conn.execute(
        "UPDATE email_metadata SET created_at = ? WHERE internal_id = 1",
        (_t.time() - 600,),
    )
    conn.commit()
    conn.close()

    b = DavMailBackend.__new__(DavMailBackend)
    b.sync_store = store
    assert b._filter_recent_rows([1, 2], grace_sec=120) == [1]
    # 查询失败 → fail-safe 整批不删
    b2 = DavMailBackend.__new__(DavMailBackend)
    b2.sync_store = MagicMock()  # db_path 是 MagicMock → connect 炸
    assert b2._filter_recent_rows([1, 2], grace_sec=120) == []


# ============================================================
# compose_draft 即时落库 (_mirror_draft_locally)
# ============================================================

def _mirror_service(tmp_path):
    from src.services.mail_write import MailWriteService

    svc = MailWriteService.__new__(MailWriteService)
    ctx = MagicMock()
    ctx.sync_store = SyncStore(str(tmp_path / "t.db"))
    ctx.config.drafts_sync_enabled = True
    ctx.config.user_email = "me@x.com"
    svc._ctx = ctx
    return svc


def test_mirror_draft_locally_saves_row(tmp_path):
    from src.mail.backend.types import DraftAppendResult, DraftRequest

    svc = _mirror_service(tmp_path)
    draft = DraftRequest(mode="new", to=["a@x.com"], cc=["b@x.com"], subject="hi")
    result = DraftAppendResult(
        success=True, drafts_folder="Drafts", appended_uid=42,
        message_id="mid-1", appended_uidvalidity=7,
    )
    svc._mirror_draft_locally(draft, result)
    rows = svc._ctx.sync_store.get_pending_emails(limit=10)
    assert len(rows) == 1
    row = rows[0]
    assert row["mailbox"] == "草稿箱"
    assert row["imap_uid"] == 42
    assert row["message_id"] == "mid-1"
    assert row["sender"] == "me@x.com"


def test_mirror_draft_skips_without_uid(tmp_path):
    """AppleScript 路径 (无 APPENDUID) → 不落库, 交给 reconcile。"""
    from src.mail.backend.types import DraftAppendResult, DraftRequest

    svc = _mirror_service(tmp_path)
    draft = DraftRequest(mode="new", to=["a@x.com"])
    result = DraftAppendResult(success=True, drafts_folder="Drafts", appended_uid=None)
    svc._mirror_draft_locally(draft, result)
    assert svc._ctx.sync_store.get_pending_emails(limit=10) == []


# ============================================================
# delete_draft — 草稿真删除 (IMAP + 本地清理)
# ============================================================

def _delete_service(tmp_path):
    from src.services.mail_write import MailWriteService

    svc = MailWriteService.__new__(MailWriteService)
    ctx = MagicMock()
    ctx.sync_store = SyncStore(str(tmp_path / "t.db"))
    svc._ctx = ctx
    return svc


def _actor():
    from src.services.guards import Actor

    return Actor(kind="test", authenticated=True, label="t")


def test_delete_draft_happy_path(tmp_path):
    svc = _delete_service(tmp_path)
    svc._ctx.sync_store.save_email({
        "internal_id": 5, "subject": "d", "sender": "me@x", "mailbox": "草稿箱",
        "sync_status": "synced", "backend_origin": "davmail", "imap_uid": 42,
    })
    reader = MagicMock()
    reader.delete_message.return_value = True
    svc._folder_imap_reader = MagicMock(return_value=reader)

    result = svc.delete_draft(5, actor=_actor())
    reader.delete_message.assert_called_once_with("drafts", 42)
    svc._ctx.email_repo.delete_email_full.assert_called_once_with(5)
    assert result.imap_uid == 42 and result.local_deleted is True


def test_delete_draft_rejects_non_draft(tmp_path):
    from src.services.errors import ServiceInvalidArgError

    svc = _delete_service(tmp_path)
    svc._ctx.sync_store.save_email({
        "internal_id": 6, "subject": "x", "sender": "a@x", "mailbox": "收件箱",
        "sync_status": "synced", "backend_origin": "davmail", "imap_uid": 9,
    })
    with pytest.raises(ServiceInvalidArgError):
        svc.delete_draft(6, actor=_actor())


def test_delete_draft_imap_failure_keeps_local(tmp_path):
    from src.services.errors import ServiceError

    svc = _delete_service(tmp_path)
    svc._ctx.sync_store.save_email({
        "internal_id": 7, "subject": "d", "sender": "me@x", "mailbox": "草稿箱",
        "sync_status": "synced", "backend_origin": "davmail", "imap_uid": 43,
    })
    reader = MagicMock()
    reader.delete_message.return_value = False
    svc._folder_imap_reader = MagicMock(return_value=reader)
    with pytest.raises(ServiceError):
        svc.delete_draft(7, actor=_actor())
    svc._ctx.email_repo.delete_email_full.assert_not_called()
