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
        # uid -> 额外 raw 头行 (如 In-Reply-To/References, 已含 \r\n 结尾), 可选
        self.extra_headers: dict[int, str] = {}
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
                    f"Date: Sat, 1 Jan 2026 10:00:00 +0000\r\n"
                    f"{self.extra_headers.get(u, '')}\r\n"
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
    # 同 Message-ID 编辑检测默认无命中 (真方法连库会在 cwd 留 MagicMock 垃圾文件)。
    # in-place update 行为有独立用例。
    b._draft_message_id_map = MagicMock(return_value={})
    b._update_draft_row_uid = MagicMock()
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


def test_edit_same_message_id_updates_in_place(patch_session):
    """OWA/Outlook 编辑草稿 (新 UID 同 Message-ID) → in-place update, 不 add 不 delete。

    若走 to_add+to_delete: save_email merge guard 合并进旧行后 to_delete 再删它
    → 草稿闪没 + internal_id 漂移; 旧行在 grace 内则正文永久陈旧 (codex HIGH)。
    """
    fake = FakeImap(7, [102], {102: ("m1", "d1-edited")})
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "102"}
    b = _backend(fake, local={101: 11}, kv=kv)
    b._draft_message_id_map = MagicMock(return_value={"m1": 11})
    patch_session(b)
    to_add, to_delete = b.reconcile_drafts()
    assert to_add == []
    assert to_delete == []
    b._update_draft_row_uid.assert_called_once()
    old_iid, item = b._update_draft_row_uid.call_args[0]
    assert old_iid == 11
    assert item["imap_uid"] == 102


def test_reconcile_persists_draft_linkage(patch_session):
    """D1 Bug A: to_add 带 draft_in_reply_to/draft_references (解析自 raw 头) +
    据 in_reply_to 反查原行回填 draft_source_internal_id。"""
    fake = FakeImap(7, [105], {105: ("m5", "d5")})
    fake.extra_headers[105] = (
        "In-Reply-To: <orig@x>\r\n"
        "References: <head@x> <orig@x>\r\n"
    )
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "105"}
    b = _backend(fake, local={}, kv=kv)
    b.sync_store.get_by_message_id = MagicMock(
        return_value={"internal_id": 42, "message_id": "orig@x"}
    )
    patch_session(b)
    to_add, _ = b.reconcile_drafts()
    assert len(to_add) == 1
    item = to_add[0]
    assert item["draft_in_reply_to"] == "orig@x"
    assert item["draft_references"] == "<head@x> <orig@x>"
    assert item["draft_source_internal_id"] == 42
    b.sync_store.get_by_message_id.assert_called_once_with("orig@x")


def test_reconcile_linkage_lookup_miss_leaves_source_none(patch_session):
    """反查不到原行 (已删/外部线程) → draft_source_internal_id 留空, 其余照写。
    默认 MagicMock sync_store 返回非 dict → helper 类型校验兜底 None。"""
    fake = FakeImap(7, [106], {106: ("m6", "d6")})
    fake.extra_headers[106] = "In-Reply-To: <gone@x>\r\n"
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "106"}
    b = _backend(fake, local={}, kv=kv)
    patch_session(b)
    to_add, _ = b.reconcile_drafts()
    item = to_add[0]
    assert item["draft_in_reply_to"] == "gone@x"
    assert item["draft_references"] is None  # 无 References 头
    assert item["draft_source_internal_id"] is None


def test_reconcile_no_threading_headers_no_linkage(patch_session):
    """非回复草稿 (无 In-Reply-To) → 不加 draft_* 键 (行为同修复前)。"""
    fake = FakeImap(7, [107], {107: ("m7", "d7")})
    kv = {"folder_uidvalidity:Drafts": "7", "drafts_uidnext": "107"}
    b = _backend(fake, local={}, kv=kv)
    patch_session(b)
    to_add, _ = b.reconcile_drafts()
    assert "draft_in_reply_to" not in to_add[0]
    assert "draft_source_internal_id" not in to_add[0]


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
# sync_store._save_email_v3 — Draft→Sent 合并提升 (数据丢失修复)
# ============================================================

def test_draft_sent_merge_promotes_mailbox(tmp_path):
    """Draft→Sent: OWA/Outlook 从草稿发送 → Sent 副本经 msgid 合并进原草稿行时,
    提升 mailbox='发件箱' + 置 sync_status='pending'。

    回归护栏: 修复前 merge 只更 imap_uid、保留 mailbox='草稿箱' → 同 poll cycle 的
    reconcile_drafts 把它当"消失草稿"删除 (已发邮件本地记录被销毁)。修复后提升为
    发件箱 → 不再进草稿对账的 to_delete, 且像其它发件箱邮件一样重取正文 + 进 Notion。
    """
    store = SyncStore(str(tmp_path / "t.db"))
    # 1) OWA 存草稿 → 本地草稿行 (local-only, 无 Notion 页)
    store.save_email({
        "internal_id": 1_000_007_607, "message_id": "PH8@namprd05",
        "subject": "答复: FW", "sender": "me@x.com", "mailbox": "草稿箱",
        "sync_status": "synced", "backend_origin": "davmail",
        "imap_uid": 38428, "imap_uidvalidity": 7,
    })
    # 2) OWA 发送 → Draft 跨文件夹移到 Sent, Sent 副本 (新 internal_id, 同 msgid)
    ok = store.save_email({
        "internal_id": 1_000_007_618, "message_id": "PH8@namprd05",
        "subject": "答复: FW", "sender": "me@x.com", "mailbox": "发件箱",
        "sync_status": "pending", "backend_origin": "davmail",
        "imap_uid": 19473, "imap_uidvalidity": 9,
    })
    assert ok
    promoted = store.get(1_000_007_607)          # 原草稿行被提升, 不建新行
    assert promoted is not None
    assert promoted["mailbox"] == "发件箱"        # 提升 → reconcile 不再当草稿删
    assert promoted["sync_status"] == "pending"   # 置 pending → 重取正文 + 进 Notion
    assert promoted["imap_uid"] == 19473          # 指向 Sent UID
    assert store.get(1_000_007_618) is None       # merge 折叠, 未建新行


def test_draft_merge_same_folder_no_promotion(tmp_path):
    """既有草稿 + 同 msgid 草稿副本 (同文件夹, 非发送) → mailbox 保持草稿箱、
    sync_status 不被误置 pending。防止提升逻辑过度触发。"""
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1_000_000_001, "message_id": "draft-mid", "subject": "d",
        "sender": "me@x.com", "mailbox": "草稿箱", "sync_status": "synced",
        "backend_origin": "davmail", "imap_uid": 10,
    })
    store.save_email({
        "internal_id": 1_000_000_002, "message_id": "draft-mid", "subject": "d",
        "sender": "me@x.com", "mailbox": "草稿箱", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 11,
    })
    row = store.get(1_000_000_001)
    assert row["mailbox"] == "草稿箱"             # 未提升
    assert row["sync_status"] == "synced"         # 原状态保留 (未误置 pending)
    assert store.get(1_000_000_002) is None


def test_crossbackend_merge_nondraft_preserves_state(tmp_path):
    """原 cross-backend merge (非草稿) 契约不回退: 保留 mailbox/sync_status/
    notion_page_id, 仅更新 davmail 字段。提升逻辑不得波及此路径。"""
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 42, "message_id": "inbox-mid", "subject": "hi",
        "sender": "a@x.com", "mailbox": "收件箱", "sync_status": "synced",
        "notion_page_id": "notion-pg-1", "backend_origin": "applescript",
    })
    store.save_email({
        "internal_id": 1_000_000_050, "message_id": "inbox-mid", "subject": "hi",
        "sender": "a@x.com", "mailbox": "收件箱", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 555, "imap_uidvalidity": 3,
    })
    row = store.get(42)
    assert row["mailbox"] == "收件箱"
    assert row["sync_status"] == "synced"          # 原状态保留
    assert row["notion_page_id"] == "notion-pg-1"  # Notion 页保留 (原 merge 契约)
    assert row["imap_uid"] == 555                  # davmail 字段照常更新
    assert store.get(1_000_000_050) is None


def test_draft_merge_incoming_non_sent_no_promotion(tmp_path):
    """codex MEDIUM: 提升须 gate 在 Sent label（非"任意非草稿"）。既有草稿 + 同 msgid
    副本来自非 Sent 文件夹（收件箱/自定义）→ 不提升（保持草稿箱、走原 merge），避免误升
    到错误 mailbox 且后续真 Sent 副本无法再提升。"""
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1_000_000_010, "message_id": "draft-x", "subject": "d",
        "sender": "me@x.com", "mailbox": "草稿箱", "sync_status": "synced",
        "backend_origin": "davmail", "imap_uid": 20,
    })
    store.save_email({
        "internal_id": 1_000_000_011, "message_id": "draft-x", "subject": "d",
        "sender": "me@x.com", "mailbox": "收件箱", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 21, "imap_uidvalidity": 5,
    })
    row = store.get(1_000_000_010)
    assert row["mailbox"] == "草稿箱"          # 未误升到收件箱
    assert row["sync_status"] == "synced"      # 未误置 pending
    assert store.get(1_000_000_011) is None


def test_draft_sent_promotion_resets_retry_state(tmp_path):
    """codex LOW: 提升当作全新一次同步 → 清 sync_error/retry_count/next_retry_at,
    避免曾 fetch 失败的草稿提升后继承旧 retry 计数、过早进 skipped/dead_letter。"""
    import sqlite3 as _sq

    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1_000_007_607, "message_id": "PH8@y", "subject": "答复",
        "sender": "me@x.com", "mailbox": "草稿箱", "sync_status": "fetch_failed",
        "backend_origin": "davmail", "imap_uid": 38428,
    })
    conn = _sq.connect(str(tmp_path / "t.db"))
    conn.execute(
        "UPDATE email_metadata SET sync_error='old boom', retry_count=3, "
        "next_retry_at=9999999999 WHERE internal_id=1000007607"
    )
    conn.commit()
    conn.close()
    store.save_email({
        "internal_id": 1_000_007_618, "message_id": "PH8@y", "subject": "答复",
        "sender": "me@x.com", "mailbox": "发件箱", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 19473,
    })
    row = store.get(1_000_007_607)
    assert row["mailbox"] == "发件箱"
    assert row["sync_status"] == "pending"
    assert row["sync_error"] is None          # 旧错误清掉
    assert row["retry_count"] == 0            # 重试计数归零
    assert row["next_retry_at"] is None       # 重试时间清掉


def test_draft_sent_variant_label_promotes(tmp_path):
    """SENT label 变体（'已发送'）也触发提升并归一到发件箱（防漏 Sent 副本）。"""
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1_000_000_020, "message_id": "var-mid", "subject": "答复",
        "sender": "me@x.com", "mailbox": "草稿箱", "sync_status": "synced",
        "backend_origin": "davmail", "imap_uid": 30,
    })
    store.save_email({
        "internal_id": 1_000_000_021, "message_id": "var-mid", "subject": "答复",
        "sender": "me@x.com", "mailbox": "已发送", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 31,
    })
    row = store.get(1_000_000_020)
    assert row["mailbox"] == "发件箱"          # 变体也提升, 且归一到规范发件箱
    assert row["sync_status"] == "pending"


def test_draft_non_sent_then_sent_still_promotes(tmp_path):
    """codex 原始担忧的正解: 非 Sent 同 msgid 副本先到 → 不误升(保持草稿箱); 之后
    真 Sent 副本再到 → 仍能正确提升到发件箱(不会因先前误升到错误 mailbox 而卡住)。"""
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1_000_000_030, "message_id": "seq-mid", "subject": "答复",
        "sender": "me@x.com", "mailbox": "草稿箱", "sync_status": "synced",
        "backend_origin": "davmail", "imap_uid": 40,
    })
    # 先来一个非 Sent 副本 → 不提升, 仍是草稿箱
    store.save_email({
        "internal_id": 1_000_000_031, "message_id": "seq-mid", "subject": "答复",
        "sender": "me@x.com", "mailbox": "收件箱", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 41,
    })
    assert store.get(1_000_000_030)["mailbox"] == "草稿箱"   # 未误升
    # 再来真 Sent 副本 → 现在正确提升
    store.save_email({
        "internal_id": 1_000_000_032, "message_id": "seq-mid", "subject": "答复",
        "sender": "me@x.com", "mailbox": "发件箱", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 42,
    })
    assert store.get(1_000_000_030)["mailbox"] == "发件箱"   # 真 Sent 到达后正确提升


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

    w.backend = _Backend()
    asyncio.run(w._reconcile_drafts())
    row = w.sync_store.get(1_000_000_001)
    assert row is not None
    assert row["mailbox"] == "草稿箱"
    assert row["sync_status"] == "pending"
    assert row["imap_uid"] == 105
    w.email_repo.delete_email_full.assert_called_once_with(999)


def test_watcher_passes_draft_linkage_through(tmp_path):
    """D1: reconcile to_add 的 draft_* 键经 watcher payload 透传落库。"""
    w = _watcher(tmp_path)
    # 原邮件行 (被回复的那封)
    w.sync_store.save_email({
        "internal_id": 42, "message_id": "orig@x", "subject": "orig",
        "sender": "a@x", "mailbox": "收件箱", "sync_status": "synced",
    })
    to_add = [{
        "internal_id": 1_000_000_002,
        "message_id": "<m6>",
        "subject": "re: orig",
        "sender": "me@x.com",
        "date_received": "2026-01-01T10:00:00+00:00",
        "mailbox": "草稿箱",
        "is_read": True,
        "thread_id": "head@x",
        "backend_origin": "davmail",
        "imap_uid": 106,
        "draft_in_reply_to": "orig@x",
        "draft_references": "<head@x> <orig@x>",
        "draft_source_internal_id": 42,
    }]

    class _Backend:
        def reconcile_drafts(self):
            return to_add, []

    w.backend = _Backend()
    asyncio.run(w._reconcile_drafts())
    row = w.sync_store.get(1_000_000_002)
    assert row["draft_in_reply_to"] == "orig@x"
    assert row["draft_references"] == "<head@x> <orig@x>"
    assert row["draft_source_internal_id"] == 42
    assert row["thread_id"] == "head@x"


def test_watcher_skips_delete_of_promoted_row(tmp_path):
    """Fix B 纵深防御: to_delete 里的行若已被 Draft→Sent 提升为发件箱 → 不删。

    兜底"merge 提升 mailbox" 与 "reconcile 计算 to_delete" 的顺序竞态: 即便某行
    进了 to_delete, 删前复核发现它已不是草稿 (mailbox='发件箱') → 跳过, 保住已发邮件。
    """
    w = _watcher(tmp_path)
    w.sync_store.save_email({
        "internal_id": 1_000_007_607, "message_id": "PH8@x", "subject": "答复",
        "sender": "me@x.com", "mailbox": "发件箱", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 19473,
    })

    class _Backend:
        def reconcile_drafts(self):
            return [], [1_000_007_607]

    w.backend = _Backend()
    asyncio.run(w._reconcile_drafts())
    w.email_repo.delete_email_full.assert_not_called()      # 提升行不删
    assert w.sync_store.get(1_000_007_607) is not None       # 仍在库


def test_watcher_still_deletes_real_vanished_draft(tmp_path):
    """Fix B 不误伤真删除: 仍标草稿箱的行照常删 (真·丢弃/发送后未提升的草稿)。"""
    w = _watcher(tmp_path)
    w.sync_store.save_email({
        "internal_id": 1_000_000_009, "message_id": "d-mid", "subject": "d",
        "sender": "me@x.com", "mailbox": "草稿箱", "sync_status": "synced",
        "backend_origin": "davmail", "imap_uid": 12,
    })

    class _Backend:
        def reconcile_drafts(self):
            return [], [1_000_000_009]

    w.backend = _Backend()
    asyncio.run(w._reconcile_drafts())
    w.email_repo.delete_email_full.assert_called_once_with(1_000_000_009)


def test_integration_draft_sent_then_reconcile_no_delete(tmp_path):
    """codex/opus LOW 集成: save 草稿 → save Sent 副本(Fix A 提升) → 一个把该 iid
    列进 to_delete 的 reconcile(模拟 stale local 快照) → Fix B 复核跳过, 已发邮件不丢。
    从"已提升"状态验证 Fix A+B 协同(真实 SyncStore, 非 mock 提升)。"""
    w = _watcher(tmp_path)
    w.sync_store.save_email({
        "internal_id": 1_000_007_607, "message_id": "PH8@z", "subject": "答复",
        "sender": "me@x.com", "mailbox": "草稿箱", "sync_status": "synced",
        "backend_origin": "davmail", "imap_uid": 38428,
    })
    # Sent 副本进来 → Fix A 把原草稿行提升为发件箱
    w.sync_store.save_email({
        "internal_id": 1_000_007_618, "message_id": "PH8@z", "subject": "答复",
        "sender": "me@x.com", "mailbox": "发件箱", "sync_status": "pending",
        "backend_origin": "davmail", "imap_uid": 19473,
    })
    assert w.sync_store.get(1_000_007_607)["mailbox"] == "发件箱"  # Fix A 生效

    class _Backend:
        def reconcile_drafts(self):
            return [], [1_000_007_607]  # stale 快照误把已提升行列进 to_delete

    w.backend = _Backend()
    asyncio.run(w._reconcile_drafts())
    w.email_repo.delete_email_full.assert_not_called()      # Fix B 复核跳过
    assert w.sync_store.get(1_000_007_607) is not None       # 已发邮件仍在库


def test_watcher_reconcile_noop_without_capability(tmp_path):
    """AppleScript backend 无 reconcile_drafts → 整段 noop 不炸。"""
    w = _watcher(tmp_path)
    w.backend = object()  # 无 reconcile_drafts 属性
    asyncio.run(w._reconcile_drafts())
    w.email_repo.delete_email_full.assert_not_called()


def test_watcher_reconcile_failure_isolated(tmp_path):
    """backend 对账抛异常 → 吞掉, 不影响主循环。"""
    w = _watcher(tmp_path)

    class _Boom:
        def reconcile_drafts(self):
            raise RuntimeError("imap down")

    w.backend = _Boom()
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
    w.backend = MagicMock()
    w.backend.fetch_email_content_by_id.return_value = {
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
    # 查询失败 → fail-safe 整批不删。db_path 用不存在父目录的路径触发
    # OperationalError (⚠️ 不能用 MagicMock: sqlite3.connect(str(mock)) 会在
    # cwd 创建名为 mock repr 的零字节垃圾文件 — codex review NIT)。
    b2 = DavMailBackend.__new__(DavMailBackend)
    b2.sync_store = MagicMock()
    b2.sync_store.db_path = str(tmp_path / "nonexistent-dir" / "x.db")
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


def test_mirror_draft_locally_writes_linkage_and_thread_id(tmp_path):
    """D1 Bug A: reply 草稿即时落库带 draft_* linkage; thread_id 从 References 首
    元素派生 (= 原邮件 thread_id) 不再硬编码 None。"""
    from src.mail.backend.types import DraftAppendResult, DraftRequest

    svc = _mirror_service(tmp_path)
    draft = DraftRequest(
        mode="reply-all", internal_id_for_threading=42,
        to=["a@x.com"], subject="Re: hi",
        in_reply_to="<orig@x>", references="<head@x> <orig@x>",
    )
    result = DraftAppendResult(
        success=True, drafts_folder="Drafts", appended_uid=43,
        message_id="draft-mid", appended_uidvalidity=7,
    )
    svc._mirror_draft_locally(draft, result)
    rows = svc._ctx.sync_store.get_pending_emails(limit=10)
    row = svc._ctx.sync_store.get(rows[0]["internal_id"])
    assert row["draft_in_reply_to"] == "orig@x"
    assert row["draft_references"] == "<head@x> <orig@x>"
    assert row["draft_source_internal_id"] == 42
    assert row["thread_id"] == "head@x"


def test_mirror_draft_locally_thread_root_reply(tmp_path):
    """回复线程根 (References 只有原邮件自己) → thread_id = 原邮件 message_id。"""
    from src.mail.backend.types import DraftAppendResult, DraftRequest

    svc = _mirror_service(tmp_path)
    draft = DraftRequest(
        mode="reply", internal_id_for_threading=7,
        to=["a@x.com"], subject="Re: root",
        in_reply_to="<root@x>", references="<root@x>",
    )
    result = DraftAppendResult(
        success=True, drafts_folder="Drafts", appended_uid=44,
        message_id="draft-mid-2", appended_uidvalidity=7,
    )
    svc._mirror_draft_locally(draft, result)
    rows = svc._ctx.sync_store.get_pending_emails(limit=10)
    row = svc._ctx.sync_store.get(rows[0]["internal_id"])
    assert row["thread_id"] == "root@x"
    assert row["draft_in_reply_to"] == "root@x"


def test_mirror_draft_locally_new_mode_no_linkage(tmp_path):
    """mode='new' 无 threading 头 → linkage 列 NULL + thread_id 维持 None (现状)。"""
    from src.mail.backend.types import DraftAppendResult, DraftRequest

    svc = _mirror_service(tmp_path)
    draft = DraftRequest(mode="new", to=["a@x.com"], subject="hi")
    result = DraftAppendResult(
        success=True, drafts_folder="Drafts", appended_uid=45,
        message_id="draft-mid-3", appended_uidvalidity=7,
    )
    svc._mirror_draft_locally(draft, result)
    rows = svc._ctx.sync_store.get_pending_emails(limit=10)
    row = svc._ctx.sync_store.get(rows[0]["internal_id"])
    assert row["thread_id"] is None
    assert row["draft_in_reply_to"] is None
    assert row["draft_references"] is None
    assert row["draft_source_internal_id"] is None


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


def test_delete_draft_happy_path_local_first(tmp_path):
    """dogfood round 3: 本地删 + SSE 必须先于 IMAP 慢链 (UI 即时移除行)。"""
    svc = _delete_service(tmp_path)
    svc._ctx.sync_store.save_email({
        "internal_id": 5, "subject": "d", "sender": "me@x", "mailbox": "草稿箱",
        "sync_status": "synced", "backend_origin": "davmail", "imap_uid": 42,
    })
    order = []
    svc._ctx.email_repo.delete_email_full.side_effect = lambda i: order.append("local")
    reader = MagicMock()
    reader.delete_message.side_effect = lambda f, u: (order.append("imap"), True)[1]
    svc._folder_imap_reader = MagicMock(return_value=reader)

    result = svc.delete_draft(5, actor=_actor())
    reader.delete_message.assert_called_once_with("drafts", 42)
    svc._ctx.email_repo.delete_email_full.assert_called_once_with(5)
    assert order == ["local", "imap"]
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


def test_delete_draft_imap_failure_no_raise(tmp_path):
    """IMAP 失败不抛 (本地已删, 抛错 = 前端报失败但行已消失的语义混乱);
    Exchange 残留由 reconcile 拉回行自愈。"""
    svc = _delete_service(tmp_path)
    svc._ctx.sync_store.save_email({
        "internal_id": 7, "subject": "d", "sender": "me@x", "mailbox": "草稿箱",
        "sync_status": "synced", "backend_origin": "davmail", "imap_uid": 43,
    })
    reader = MagicMock()
    reader.delete_message.return_value = False
    svc._folder_imap_reader = MagicMock(return_value=reader)

    result = svc.delete_draft(7, actor=_actor())
    svc._ctx.email_repo.delete_email_full.assert_called_once_with(7)
    assert result.local_deleted is True and result.imap_uid == 43


def test_delete_draft_idempotent_missing_row(tmp_path):
    """行不存在 (连点第二次 / 已删) → 幂等成功, 不发起 IMAP 慢链。"""
    svc = _delete_service(tmp_path)
    svc._folder_imap_reader = MagicMock()

    result = svc.delete_draft(99999, actor=_actor())
    svc._folder_imap_reader.assert_not_called()
    svc._ctx.email_repo.delete_email_full.assert_not_called()
    assert result.imap_uid == 0 and result.local_deleted is False
