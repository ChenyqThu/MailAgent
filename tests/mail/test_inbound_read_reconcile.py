"""issue #58 入向「未读→已读」单向回收 (davmail-only, 默认关)。

四层覆盖:
- ``DavMailBackend.search_inbox_unseen``: (uidvalidity, UNSEEN 集, 视图下界 uid);
  SELECT/SEARCH 失败、空邮箱 (读不到下界) → None (调用方跳过, 不误判)。**只出候选**。
- ``DavMailBackend.fetch_inbox_seen_flags``: 定向 (UID FLAGS) 复核 = 真判据;
  未返回的 uid (已归档/删除/UID 空洞) 与仍无 \\Seen 的 uid 都不许收敛。
- ``OutboxRepository.has_pending``: 未终态 (pending/processing/failed) 才算在途,
  done / dead_letter 不阻断收敛。
- ``NewWatcher._reconcile_inbound_read``: 主路径 (收敛 + 恒走 outbox→notion) +
  安全闸 (定向复核 / pending intent / uidvalidity / 截断窗口下界) + 原子性 (CAS +
  同事务入队, 故障回滚) + 单向性 + flag inert + 独立低频节拍自限流 +
  Sprint15 死循环窗口回归 + 复核/收敛按 chunk 紧邻 + 写锁竞争不阻塞事件循环。
"""
from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

from src.mail import new_watcher as nw_mod
from src.mail.backend.davmail_backend import DavMailBackend
from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore
from src.sync.outbox import OutboxRepository


# ============================================================
# backend.search_inbox_unseen / fetch_inbox_seen_flags — FakeImap
# ============================================================

class FakeImap:
    """SELECT(readonly) → FETCH 1 (UID) → UID SEARCH UNSEEN / UID FETCH (UID FLAGS)。

    🔴 INBOX 真值是 ``{uid: flags}``, UNSEEN 集与 FETCH 响应都从这一份状态派生 ——
    这样才能表达「uid 在窗口内、但已不属于 INBOX」(归档/删除/空洞): 它既不在 uids
    里、也不会被 FETCH 返回, 而在 SEARCH 结果里与"被标已读"长得一模一样。
    """

    def __init__(self, *, uidvalidity=7, mails=None, uids=(), unseen=(),
                 select_ok=True, search_ok=True, fetch_flags_ok=True,
                 uidvalidity_visible=True):
        # mails: {uid: flags 字符串}; 便捷参数 uids/unseen 会翻译成它
        if mails is None:
            mails = {
                u: ("\\Seen" if u not in set(unseen) else "") for u in uids
            }
        self.uidvalidity = uidvalidity
        self.mails = dict(mails)
        self.select_ok = select_ok
        self.search_ok = search_ok
        self.fetch_flags_ok = fetch_flags_ok
        self.uidvalidity_visible = uidvalidity_visible
        self.untagged_responses = {}
        self.search_args: list[tuple] = []
        self.uid_fetch_args: list[tuple] = []

    @property
    def uids(self):
        return sorted(self.mails)

    def select(self, folder, readonly=False):
        if not self.select_ok:
            return ("NO", [b"nope"])
        if self.uidvalidity_visible:
            self.untagged_responses = {"UIDVALIDITY": [str(self.uidvalidity).encode()]}
        return ("OK", [str(len(self.mails)).encode()])

    def fetch(self, seq, parts):
        # 序号 1 = 视图内最老一封 (folderSizeLimit 截断后的窗口下界)
        if not self.mails:
            return ("OK", [None])           # 空 mailbox: imaplib 真实返回形状
        return ("OK", [f"1 (UID {self.uids[0]})".encode()])

    def uid(self, cmd, *args):
        if cmd == "search":
            self.search_args.append(args)
            if not self.search_ok:
                return ("NO", [b"search failed"])
            unseen = [u for u, f in sorted(self.mails.items()) if "\\Seen" not in f]
            return ("OK", [" ".join(str(u) for u in unseen).encode()])
        assert cmd == "fetch"
        self.uid_fetch_args.append(args)
        if not self.fetch_flags_ok:
            return ("NO", [b"fetch failed"])
        wanted = [int(x) for x in str(args[0]).split(",") if x]
        data = [
            f"{i + 1} (UID {u} FLAGS ({self.mails[u]}))".encode()
            for i, u in enumerate(wanted) if u in self.mails      # 缺席 = 已不在 INBOX
        ]
        return ("OK", data or [None])


@pytest.fixture
def backend_with(monkeypatch):
    def _make(fake: FakeImap) -> DavMailBackend:
        b = DavMailBackend.__new__(DavMailBackend)
        b.cfg = MagicMock()
        b.cfg.davmail_status_timeout_sec = 30

        @contextmanager
        def _sess(cfg, timeout=60):
            yield fake

        monkeypatch.setattr(
            "src.mail.backend.davmail_backend.imap_session", _sess
        )
        return b

    return _make


def test_search_returns_uv_unseen_and_window_floor(backend_with):
    """主路径: 返回 (uidvalidity, UNSEEN 集, 视图最老 uid)，且只发一次 SEARCH UNSEEN。"""
    fake = FakeImap(uidvalidity=7, uids=[101, 102, 103], unseen=[103])
    result = backend_with(fake).search_inbox_unseen()
    assert result == (7, {103}, 101)
    assert fake.search_args == [(None, "UNSEEN")]


def test_search_empty_unseen_is_valid_result(backend_with):
    """UNSEEN 为空 (全部已读) 是合法结果, **不能**当 SEARCH 失败跳过 ——
    否则「全部已读」这个最该收敛的场景永远不收敛。"""
    fake = FakeImap(uidvalidity=7, uids=[101, 102], unseen=[])
    assert backend_with(fake).search_inbox_unseen() == (7, set(), 101)


def test_search_select_failure_returns_none(backend_with):
    fake = FakeImap(uids=[101], select_ok=False)
    assert backend_with(fake).search_inbox_unseen() is None


def test_search_missing_uidvalidity_returns_none(backend_with):
    fake = FakeImap(uids=[101], uidvalidity_visible=False)
    assert backend_with(fake).search_inbox_unseen() is None


def test_search_failure_returns_none(backend_with):
    fake = FakeImap(uids=[101], search_ok=False)
    assert backend_with(fake).search_inbox_unseen() is None


def test_search_empty_mailbox_returns_none(backend_with):
    """空 INBOX → 读不到窗口下界 → None。无下界就无法区分「已读」和「在截断窗口外」。"""
    fake = FakeImap(uids=[], unseen=[])
    assert backend_with(fake).search_inbox_unseen() is None


# ============================================================
# backend.fetch_inbox_seen_flags — 定向复核 (真判据)
# ============================================================

def test_verify_reports_seen_and_unseen(backend_with):
    """返回 {uid: 是否带 \\Seen}, 只发 FETCH 不发 SEARCH。"""
    fake = FakeImap(mails={101: "\\Seen", 102: "", 103: "\\Seen \\Answered"})
    assert backend_with(fake).fetch_inbox_seen_flags([101, 102, 103]) == (
        7, {101: True, 102: False, 103: True}
    )
    assert fake.search_args == []
    assert fake.uid_fetch_args == [("101,102,103", "(UID FLAGS)")]


def test_verify_omits_uid_no_longer_in_inbox(backend_with):
    """🔴 归档/删除/UID 空洞: uid 不在 INBOX → **不出现在返回 map 里**。
    调用方据此跳过 —— 这正是「不在 UNSEEN 集」与「已读」的区分点。"""
    fake = FakeImap(mails={101: "\\Seen"})
    uv, seen = backend_with(fake).fetch_inbox_seen_flags([101, 777])
    assert uv == 7
    assert seen == {101: True}
    assert 777 not in seen


def test_verify_flags_group_not_substring(backend_with):
    """\\Seen 判定取 FLAGS(...) 整段成员, 不做整行子串匹配 ——
    自定义 keyword 里出现同名子串不许误判成已读 (误判方向不可逆)。"""
    fake = FakeImap(mails={101: "$NotSeenYet \\Answered"})
    assert backend_with(fake).fetch_inbox_seen_flags([101]) == (7, {101: False})


def test_verify_empty_uids_returns_empty_map(backend_with):
    """空候选集: 返回 (uv, {}) 且一条 FETCH 都不发 (调用方本就不会这么调, 兜底不崩)。"""
    fake = FakeImap(mails={101: "\\Seen"})
    assert backend_with(fake).fetch_inbox_seen_flags([]) == (7, {})
    assert fake.uid_fetch_args == []


def test_verify_dedups_and_sorts_uids(backend_with):
    fake = FakeImap(mails={101: "", 102: "\\Seen"})
    backend_with(fake).fetch_inbox_seen_flags([102, 101, 102])
    assert fake.uid_fetch_args == [("101,102", "(UID FLAGS)")]


def test_verify_chunks_large_uid_sets(backend_with):
    """超过 _FLAGS_FETCH_CHUNK 的候选集分批发 (IMAP 命令行长度有实现上限)。"""
    mails = {u: "\\Seen" for u in range(1000, 1000 + 1200)}
    fake = FakeImap(mails=mails)
    uv, seen = backend_with(fake).fetch_inbox_seen_flags(list(mails))
    assert uv == 7 and len(seen) == 1200
    assert len(fake.uid_fetch_args) == 3          # 500 + 500 + 200


def test_verify_select_failure_returns_none(backend_with):
    fake = FakeImap(mails={101: "\\Seen"}, select_ok=False)
    assert backend_with(fake).fetch_inbox_seen_flags([101]) is None


def test_verify_missing_uidvalidity_returns_none(backend_with):
    fake = FakeImap(mails={101: "\\Seen"}, uidvalidity_visible=False)
    assert backend_with(fake).fetch_inbox_seen_flags([101]) is None


def test_verify_fetch_failure_returns_none(backend_with):
    """FETCH 失败 → None (整轮跳过)。绝不能退化成"没复核到就当已读"。"""
    fake = FakeImap(mails={101: "\\Seen"}, fetch_flags_ok=False)
    assert backend_with(fake).fetch_inbox_seen_flags([101]) is None


# ============================================================
# outbox.has_pending — 在途 intent 判定
# ============================================================

@pytest.fixture
def outbox_db(tmp_path):
    store = SyncStore(str(tmp_path / "outbox.db"))
    for iid in (2001, 2002, 2003, 2004):
        store.save_email({
            "internal_id": iid, "message_id": f"<m{iid}@x>", "subject": "s",
            "sender": "a@x.com", "mailbox": "收件箱", "sync_status": "synced",
        })
    return OutboxRepository(str(store.db_path))


def test_has_pending_true_for_pending(outbox_db):
    outbox_db.enqueue(internal_id=2001, op_type="flag_sync", target="mailapp",
                      payload={"is_read": False}, source="frontend")
    assert outbox_db.has_pending(2001, "flag_sync") is True


def test_has_pending_false_without_row(outbox_db):
    assert outbox_db.has_pending(2002, "flag_sync") is False


def test_has_pending_false_after_done(outbox_db):
    """派发完成 (done) 是终态 → 不再阻断收敛。"""
    oid = outbox_db.enqueue(internal_id=2003, op_type="flag_sync", target="notion",
                            payload={"is_read": True}, source="frontend")
    outbox_db.mark_processing(oid)
    outbox_db.mark_done(oid)
    assert outbox_db.has_pending(2003, "flag_sync") is False


def test_has_pending_true_while_processing(outbox_db):
    """processing = fanout 正在写 —— 这正是 Sprint15 误判窗口本身, 必须算在途。"""
    oid = outbox_db.enqueue(internal_id=2004, op_type="flag_sync", target="mailapp",
                            payload={"is_read": False}, source="frontend")
    outbox_db.mark_processing(oid)
    assert outbox_db.has_pending(2004, "flag_sync") is True


def test_has_pending_true_while_failed_retrying(outbox_db):
    """failed = 还在退避重试队列里, 随时会再写一次 → 仍算在途。"""
    oid = outbox_db.enqueue(internal_id=2001, op_type="flag_sync", target="mailapp",
                            payload={"is_read": False}, source="frontend")
    outbox_db.mark_processing(oid)
    outbox_db.mark_failed(oid, "boom", max_attempts=5)
    assert outbox_db.has_pending(2001, "flag_sync") is True


def test_has_pending_false_after_dead_letter(outbox_db):
    """dead_letter 是终态 (已放弃派发) → 不该永久阻断收敛。"""
    oid = outbox_db.enqueue(internal_id=2002, op_type="flag_sync", target="mailapp",
                            payload={"is_read": False}, source="frontend")
    for _ in range(2):
        outbox_db.mark_processing(oid)
        outbox_db.mark_failed(oid, "boom", max_attempts=1)
    assert outbox_db.get(oid).status == "dead_letter"
    assert outbox_db.has_pending(2002, "flag_sync") is False


def test_has_pending_scoped_by_op_type(outbox_db):
    """别的 op_type 的在途 intent 不串味。"""
    outbox_db.enqueue(internal_id=2003, op_type="archive", target="mailapp",
                      payload={}, source="frontend")
    assert outbox_db.has_pending(2003, "flag_sync") is False
    assert outbox_db.has_pending(2003, "archive") is True


# ============================================================
# watcher._reconcile_inbound_read
# ============================================================

_DERIVE = object()


class _Backend:
    """davmail backend 替身 —— INBOX 真值一份 ``{uid: 是否已读}``, SEARCH 与
    定向 FETCH 都从它派生。

    🔴 关键能力 (上一版 fake 表达不了、导致归档误判不可测): uid **不在** ``inbox``
    dict 里 = 「窗口内可见范围, 但已不属于 INBOX」(归档/删除/被规则搬走/UID 空洞)。
    它跟"被标已读"一样都不出现在 UNSEEN 集里, 但定向 FETCH 不会返回它。

    ``after_search`` 在 SEARCH 快照取完之后回调, 用来模拟"SEARCH 耗时数分钟, 期间
    服务器状态又变了"; ``after_verify`` 在定向复核之后回调, 用来在"判定完成 → 提交"
    之间插入并发写 (intent 竞态 / 本地被改)。
    """

    def __init__(self, inbox=None, *, uidvalidity=7, min_visible_uid=100,
                 search_result=_DERIVE, verify_result=_DERIVE,
                 verify_uidvalidity=None, after_search=None, after_verify=None):
        self.inbox = dict(inbox or {})
        self.uidvalidity = uidvalidity
        self.min_visible_uid = min_visible_uid
        self.search_result = search_result      # None / Exception / 显式三元组
        self.verify_result = verify_result
        self.verify_uidvalidity = verify_uidvalidity
        self.after_search = after_search
        self.after_verify = after_verify
        self.calls = 0
        self.verify_calls: list[list[int]] = []

    def search_inbox_unseen(self):
        self.calls += 1
        if isinstance(self.search_result, Exception):
            raise self.search_result
        if self.search_result is not _DERIVE:
            return self.search_result
        unseen = {uid for uid, seen in self.inbox.items() if not seen}
        snapshot = (self.uidvalidity, unseen, self.min_visible_uid)
        if self.after_search:
            self.after_search(self)             # 快照已取, 之后的变化快照看不到
        return snapshot

    def fetch_inbox_seen_flags(self, uids):
        self.verify_calls.append(sorted(uids))
        if isinstance(self.verify_result, Exception):
            raise self.verify_result
        if self.verify_result is not _DERIVE:
            return self.verify_result
        uv = self.verify_uidvalidity if self.verify_uidvalidity else self.uidvalidity
        out = (uv, {u: self.inbox[u] for u in uids if u in self.inbox})
        if self.after_verify:
            self.after_verify(self)             # 判定完成 → 提交之间的并发窗口
        return out


class _SearchOnlyBackend:
    """只有 SEARCH、没有定向复核的 backend (老 backend / 半升级态)。"""

    def __init__(self, result):
        self.result = result
        self.calls = 0

    def search_inbox_unseen(self):
        self.calls += 1
        return self.result


@pytest.fixture
def enabled(monkeypatch):
    """打开 flag (默认 false) + 用默认 300s 节拍。"""
    monkeypatch.setattr(nw_mod.settings, "inbound_read_reconcile_enabled", True,
                        raising=False)
    monkeypatch.setattr(nw_mod.settings, "inbound_read_reconcile_interval_sec", 300,
                        raising=False)


def _watcher(tmp_path, backend):
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = SyncStore(str(tmp_path / "t.db"))
    w.backend = backend
    w._last_inbound_read_reconcile_at = None
    # 「绝不直调 Notion」的结构性断言面: 任何直调都会落到这个 mock 的 method_calls
    w.notion_sync = MagicMock()
    return w


def _save(store, internal_id, *, is_read=False, is_flagged=False, imap_uid=101,
          uidvalidity=7, mailbox="收件箱", page_id="pg-1"):
    store.save_email({
        "internal_id": internal_id,
        "message_id": f"<m{internal_id}@x>",
        "subject": "s",
        "sender": "a@x.com",
        "mailbox": mailbox,
        "sync_status": "synced",
        "notion_page_id": page_id,
        "backend_origin": "davmail",
        "is_read": is_read,
        "is_flagged": is_flagged,
        "imap_uid": imap_uid,
        "imap_uidvalidity": uidvalidity,
    })


def _outbox(w) -> OutboxRepository:
    return OutboxRepository(str(w.sync_store.db_path))


async def test_converges_server_read_via_outbox_notion(tmp_path, enabled):
    """主路径: 本地未读 ∧ 服务器 FLAGS 确证已读 → is_read 翻 True +
    outbox(target='notion', payload={'is_read': True}); 不入 mailapp 队、不直调 Notion。"""
    backend = _Backend({101: True, 102: False})   # 101 已读、102 仍未读
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5001, imap_uid=101, is_flagged=True)

    await w._reconcile_inbound_read()

    row = w.sync_store.get(5001)
    assert row["is_read"] == 1
    assert row["is_flagged"] == 1                 # 旗标不碰 (只动 is_read)
    assert backend.verify_calls == [[101]]        # 只对候选定向复核, 不是全量
    entries = _outbox(w).list_by_internal_id(5001)
    assert len(entries) == 1
    entry = entries[0]
    assert entry.target == "notion"               # (b) 恒走 outbox→notion
    assert entry.op_type == "flag_sync"
    assert entry.payload == {"is_read": True}
    assert entry.source == "read_reconcile"
    assert [e for e in entries if e.target == "mailapp"] == []   # 不回写 Mail.app
    assert w.notion_sync.method_calls == []       # 绝不直调 Notion


async def test_server_unread_left_alone(tmp_path, enabled):
    """服务器仍未读 (uid 在 UNSEEN 集) → 连候选都不是, 不发定向复核。"""
    backend = _Backend({101: False})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5002, imap_uid=101)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5002)["is_read"] == 0
    assert backend.verify_calls == []
    assert _outbox(w).list_by_internal_id(5002) == []


async def test_all_read_empty_unseen_still_converges(tmp_path, enabled):
    """服务器 UNSEEN 空集 (全部已读) 是合法结果 → 照常收敛, 不当成 SEARCH 失败。"""
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5003, imap_uid=101)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5003)["is_read"] == 1


async def test_uid_missing_from_inbox_is_not_read(tmp_path, enabled):
    """🔴 codex BLOCK 1: 窗口内但已不属于 INBOX 的 uid (在 Outlook 被**归档/移走但
    保持未读**, 或被删除, 或 UID 空洞) —— 它同样不在 UNSEEN 集里, 只凭 SEARCH 会被
    确定性地误标已读并写进 Notion, 且本功能单向、永不自愈。定向复核不返回该 uid
    → 必须跳过。"""
    backend = _Backend({102: True})               # 101 已不在 INBOX; 102 是真已读
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5021, imap_uid=101)       # 被归档的未读邮件
    _save(w.sync_store, 5022, imap_uid=102)       # 同轮真已读的邮件

    await w._reconcile_inbound_read()

    assert backend.verify_calls == [[101, 102]]   # 两封都进了候选
    assert w.sync_store.get(5021)["is_read"] == 0           # 归档未读: 零触碰
    assert _outbox(w).list_by_internal_id(5021) == []
    assert w.sync_store.get(5022)["is_read"] == 1           # 真已读照常收敛


async def test_marked_unread_after_search_snapshot(tmp_path, enabled):
    """🔴 codex BLOCK 2A: SEARCH 快照可能耗时数分钟, 期间用户在 Outlook 又把这封标
    回未读 —— 陈旧快照说"已读", 定向复核说"仍未读" → 以复核为准, 跳过。"""
    def _mark_unread_on_server(be):
        be.inbox[101] = False                     # SEARCH 之后服务器状态变了

    backend = _Backend({101: True}, after_search=_mark_unread_on_server)
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5023, imap_uid=101)

    await w._reconcile_inbound_read()

    assert backend.verify_calls == [[101]]        # 快照把它当候选了
    assert w.sync_store.get(5023)["is_read"] == 0  # 但复核救回来了
    assert _outbox(w).list_by_internal_id(5023) == []


async def test_uidvalidity_change_between_sessions_skips_cycle(tmp_path, enabled):
    """两次 IMAP 会话之间 UIDVALIDITY 变了 → 候选集的 uid 全部失效, 整轮作废。"""
    backend = _Backend({101: True}, verify_uidvalidity=9)
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5024, imap_uid=101)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5024)["is_read"] == 0
    assert _outbox(w).list_by_internal_id(5024) == []


async def test_verify_failure_skips_cycle(tmp_path, enabled):
    """定向复核不可用 (FETCH 失败 → None) → 整轮跳过。绝不退化成"没复核就当已读"。"""
    backend = _Backend({101: True}, verify_result=None)
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5025, imap_uid=101)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5025)["is_read"] == 0
    assert _outbox(w).list_by_internal_id(5025) == []


async def test_verify_exception_skips_cycle(tmp_path, enabled):
    backend = _Backend({101: True}, verify_result=RuntimeError("imap down"))
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5026, imap_uid=101)

    await w._reconcile_inbound_read()          # 不抛

    assert w.sync_store.get(5026)["is_read"] == 0


async def test_backend_without_verify_is_inert(tmp_path, enabled):
    """backend 只有 SEARCH、没有定向复核 → 整段不激活 (没判据就不许猜)。"""
    backend = _SearchOnlyBackend((7, set(), 100))
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5027, imap_uid=101)

    await w._reconcile_inbound_read()

    assert backend.calls == 0
    assert w.sync_store.get(5027)["is_read"] == 0


async def test_pending_intent_skips_email(tmp_path, enabled):
    """(a) 该邮件有在途 flag_sync intent → 本轮跳过 (不改行、不重复入队)。"""
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5004, imap_uid=101)
    outbox = _outbox(w)
    outbox.enqueue(internal_id=5004, op_type="flag_sync", target="mailapp",
                   payload={"is_read": False}, source="frontend")

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5004)["is_read"] == 0            # 未被收敛
    entries = outbox.list_by_internal_id(5004)
    assert len(entries) == 1 and entries[0].target == "mailapp"   # 无新 notion intent


async def test_inflight_outbound_intent_no_deadloop(tmp_path, enabled):
    """Sprint15 死循环窗口回归: 用户刚标「未读」、fanout 正在派发 (processing) ——
    此刻服务器还是已读态, 若不跳过就会把用户的未读操作立刻收敛回已读 (并写 Notion),
    正是当年 flag/unflag 死循环的根因场景。"""
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5005, imap_uid=101)
    outbox = _outbox(w)
    oid = outbox.enqueue(internal_id=5005, op_type="flag_sync", target="mailapp",
                         payload={"is_read": False}, source="frontend")
    outbox.mark_processing(oid)                              # fanout 正在写

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5005)["is_read"] == 0
    assert len(outbox.list_by_internal_id(5005)) == 1
    assert w.notion_sync.method_calls == []


async def test_uidvalidity_mismatch_skips(tmp_path, enabled):
    """(c) 本地 imap_uidvalidity ≠ 服务器 UIDVALIDITY → 该行 imap_uid 已全失效, 跳过。"""
    backend = _Backend({101: True}, uidvalidity=9)           # 服务器 uv 已变 7→9
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5006, imap_uid=101, uidvalidity=7)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5006)["is_read"] == 0
    assert _outbox(w).list_by_internal_id(5006) == []


async def test_uid_below_window_floor_skips(tmp_path, enabled):
    """(c2) davmail.folderSizeLimit 截断窗口下界闸: 窗口外的老邮件在 UNSEEN 里必然
    缺席, 缺席 ≠ 已读 —— 没这道闸会把真未读的老邮件批量误标已读。"""
    # 视图只剩 uid >= 800; 850 已读、900 仍未读
    backend = _Backend({850: True, 900: False}, min_visible_uid=800)
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5007, imap_uid=101)                  # 窗口外老邮件
    _save(w.sync_store, 5008, imap_uid=850)                  # 窗口内、服务器已读

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5007)["is_read"] == 0            # 老邮件不判
    assert backend.verify_calls == [[850]]                   # 窗口外的连复核都不发
    assert _outbox(w).list_by_internal_id(5007) == []
    assert w.sync_store.get(5008)["is_read"] == 1            # 窗口内照常收敛


async def test_applescript_row_without_imap_uid_skipped(tmp_path, enabled):
    """AppleScript 路径行 (imap_uid / uidvalidity 为 NULL) → 跳过, 不拿空 uid 匹配。"""
    backend = _Backend({}, min_visible_uid=1)
    w = _watcher(tmp_path, backend)
    w.sync_store.save_email({
        "internal_id": 5009, "message_id": "<as@x>", "subject": "s",
        "sender": "a@x.com", "mailbox": "收件箱", "sync_status": "synced",
        "is_read": False,
    })

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5009)["is_read"] == 0


async def test_read_rows_and_other_mailboxes_untouched(tmp_path, enabled):
    """单向性: 已读行不会被翻回未读; 收件箱之外的邮箱不参与本轮 (只收件箱)。"""
    backend = _Backend({201: False, 301: False})    # 两封在服务器 UNSEEN 里
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5010, imap_uid=201, is_read=True)              # 本地已读
    _save(w.sync_store, 5011, imap_uid=301, is_read=False, mailbox="发件箱")

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5010)["is_read"] == 1      # 已读→未读 不做
    assert w.sync_store.get(5011)["is_read"] == 0      # 发件箱未读行不动
    assert _outbox(w).list_by_internal_id(5010) == []
    assert _outbox(w).list_by_internal_id(5011) == []


async def test_flag_off_is_inert(tmp_path, monkeypatch):
    """flag=false (默认) → 不发 SEARCH、不查库、不改行、不入队。"""
    monkeypatch.setattr(nw_mod.settings, "inbound_read_reconcile_enabled", False,
                        raising=False)
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5012, imap_uid=101)
    queried = []
    monkeypatch.setattr(
        w.sync_store, "get_inbox_unread_for_read_reconcile",
        lambda *a, **k: queried.append(1) or [],
    )

    await w._reconcile_inbound_read()

    assert backend.calls == 0            # 零 IMAP 开销
    assert queried == []                 # 零 SQLite 查询
    assert w.sync_store.get(5012)["is_read"] == 0
    assert _outbox(w).list_by_internal_id(5012) == []


async def test_interval_self_throttles(tmp_path, enabled):
    """独立低频节拍: 同一 interval 内连调两次, 第二次不再发 SEARCH
    (绝不能随 5s radar poll 每轮打 EWS —— issue #46 限流雷区)。"""
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5013, imap_uid=101)

    await w._reconcile_inbound_read()
    await w._reconcile_inbound_read()

    assert backend.calls == 1


async def test_runs_again_after_interval_elapsed(tmp_path, enabled):
    """节拍到点 (interval 已过) → 下一轮 poll 照常收敛。"""
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5014, imap_uid=101)

    await w._reconcile_inbound_read()
    w._last_inbound_read_reconcile_at = time.monotonic() - 301   # 模拟 300s 已过
    await w._reconcile_inbound_read()

    assert backend.calls == 2


async def test_applescript_backend_noop(tmp_path, enabled):
    """AppleScript backend 无 search_inbox_unseen / fetch_inbox_seen_flags →
    整段 noop (应急回切安全)。"""
    w = _watcher(tmp_path, object())
    _save(w.sync_store, 5015, imap_uid=101)

    await w._reconcile_inbound_read()      # 不抛

    assert w.sync_store.get(5015)["is_read"] == 0


async def test_backend_exception_swallowed(tmp_path, enabled):
    """backend 抛异常 → 仅 warning, 不阻塞主循环、不改行。"""
    backend = _Backend(search_result=RuntimeError("imap down"))
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5016, imap_uid=101)

    await w._reconcile_inbound_read()      # 不抛

    assert w.sync_store.get(5016)["is_read"] == 0


async def test_snapshot_none_skips_cycle(tmp_path, enabled):
    """backend 返回 None (SELECT/SEARCH 失败或读不到下界) → 整轮跳过, 零收敛。"""
    backend = _Backend(search_result=None)
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5017, imap_uid=101)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5017)["is_read"] == 0
    assert _outbox(w).list_by_internal_id(5017) == []


async def test_publishes_single_refresh_event_with_ids(tmp_path, enabled, monkeypatch):
    """收敛后整轮只发一条 email.flag_changed (不按封刷屏), 但**携带 internal_ids** ——
    少了 id 前端只失效 main-list + 徽标, 已打开的详情 toolbar 仍显示未读
    (codex BLOCK 4)。"""
    import src.events.publisher as pub_mod

    events: list[tuple] = []
    monkeypatch.setattr(
        pub_mod, "safe_publish",
        lambda event_type, **kw: events.append((event_type, kw)),
    )
    backend = _Backend({101: True, 102: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5018, imap_uid=101)
    _save(w.sync_store, 5019, imap_uid=102)

    await w._reconcile_inbound_read()

    flag_events = [e for e in events if e[0] == "email.flag_changed"]
    assert len(flag_events) == 1
    data = flag_events[0][1]["data"]
    assert flag_events[0][1]["internal_id"] is None      # 聚合事件仍不按封发
    assert data["converged"] == 2
    assert sorted(data["internal_ids"]) == [5018, 5019]
    assert data["ids_truncated"] is False


async def test_refresh_event_ids_bounded(tmp_path, enabled, monkeypatch):
    """id 列表有界: 超过上限只带前 N 个 + ids_truncated=True (前端据此失效所有活跃
    detail), 不把上千 id 塞进一条 SSE。"""
    import src.events.publisher as pub_mod

    events: list[tuple] = []
    monkeypatch.setattr(
        pub_mod, "safe_publish",
        lambda event_type, **kw: events.append((event_type, kw)),
    )
    monkeypatch.setattr(nw_mod, "READ_RECONCILE_EVENT_ID_CAP", 2)
    backend = _Backend({101: True, 102: True, 103: True})
    w = _watcher(tmp_path, backend)
    for iid, uid in ((5031, 101), (5032, 102), (5033, 103)):
        _save(w.sync_store, iid, imap_uid=uid)

    await w._reconcile_inbound_read()

    data = [e for e in events if e[0] == "email.flag_changed"][0][1]["data"]
    assert data["converged"] == 3
    assert len(data["internal_ids"]) == 2
    assert data["ids_truncated"] is True


async def test_no_convergence_no_event(tmp_path, enabled, monkeypatch):
    """零收敛 → 不发刷新事件 (不制造无谓的前端 invalidate)。"""
    import src.events.publisher as pub_mod

    events: list[tuple] = []
    monkeypatch.setattr(
        pub_mod, "safe_publish",
        lambda event_type, **kw: events.append((event_type, kw)),
    )
    backend = _Backend({101: False})             # 服务器仍未读
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5020, imap_uid=101)

    await w._reconcile_inbound_read()

    assert [e for e in events if e[0] == "email.flag_changed"] == []


# ============================================================
# 提交阶段的原子性与竞态 (codex BLOCK 2B / 3)
# ============================================================

def _raw_write(db_path: str, sql: str, params=()):
    """跳过所有仓内 API 的裸写 —— 模拟"另一个进程/线程"在竞态窗口里动了库。"""
    conn = sqlite3.connect(str(db_path), timeout=30.0)
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


async def test_intent_inserted_after_verify_is_respected(tmp_path, enabled):
    """🔴 codex BLOCK 2B: 服务器复核完成之后、本地提交之前, 用户在前端把这封标"未读"
    并入队 —— 老实现的 has_pending 查在另一条连接、且早于写, 这个窗口里插进来的
    intent 看不见, 于是本地被写回已读、notion 队的 json_patch 还会把用户 intent 里的
    is_read=false 合并覆盖成 true (用户显式操作被吞)。现在闸与写同事务 → 必须放弃。"""
    holder = {}

    def _user_marks_unread(_be):
        # 时序由 fake 的 after_verify 钩子锁定: 恰好在"判定完成 → 开事务"之间
        holder["outbox"].enqueue(
            internal_id=5034, op_type="flag_sync", target="notion",
            payload={"is_read": False}, source="frontend",
        )

    backend = _Backend({101: True}, after_verify=_user_marks_unread)
    w = _watcher(tmp_path, backend)
    holder["outbox"] = _outbox(w)
    _save(w.sync_store, 5034, imap_uid=101)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5034)["is_read"] == 0        # 没被写回已读
    entries = holder["outbox"].list_by_internal_id(5034)
    assert len(entries) == 1
    assert entries[0].payload == {"is_read": False}      # 用户 intent 逐字未被合并覆盖
    assert entries[0].source == "frontend"


async def test_row_flipped_read_after_verify_cas_skips(tmp_path, enabled):
    """CAS: 复核之后、提交之前该行已被别处置已读 (另一条收敛/用户点了已读) →
    受影响行数为 0 → 放弃该封, 不重复入 notion 队。"""
    holder = {}

    def _someone_else_marks_read(_be):
        _raw_write(holder["db"],
                   "UPDATE email_metadata SET is_read = 1 WHERE internal_id = 5035")

    backend = _Backend({101: True}, after_verify=_someone_else_marks_read)
    w = _watcher(tmp_path, backend)
    holder["db"] = str(w.sync_store.db_path)
    _save(w.sync_store, 5035, imap_uid=101)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5035)["is_read"] == 1        # 别处已置已读
    assert _outbox(w).list_by_internal_id(5035) == []    # 但我们没重复入队


async def test_row_rewritten_after_verify_cas_skips(tmp_path, enabled):
    """🔴 CAS 只比 is_read 不够: 用户标"未读"会把本地写回 is_read=0 —— 值与快照相同,
    只比 is_read 看不出中间发生过写。若那次 intent 恰好已派发完 (has_pending 归 false),
    这封就会被静默改回已读。updated_at 是那次写留下的唯一痕迹 → 一并比。"""
    holder = {}

    def _user_marks_unread_and_intent_settles(_be):
        # 模拟"用户标未读 + 该 intent 已 done"后的库态: is_read 仍 0, 但 updated_at 变了
        _raw_write(holder["db"],
                   "UPDATE email_metadata SET updated_at = updated_at + 1 "
                   "WHERE internal_id = 5039")

    backend = _Backend({101: True}, after_verify=_user_marks_unread_and_intent_settles)
    w = _watcher(tmp_path, backend)
    holder["db"] = str(w.sync_store.db_path)
    _save(w.sync_store, 5039, imap_uid=101)

    await w._reconcile_inbound_read()

    assert w.sync_store.get(5039)["is_read"] == 0        # 用户的未读没被吞掉
    assert _outbox(w).list_by_internal_id(5039) == []


async def test_enqueue_failure_rolls_back_local_mirror(tmp_path, enabled, monkeypatch):
    """🔴 codex BLOCK 3: 入队失败必须连本地镜像一起回滚。若本地先独立 commit 成已读、
    入队再失败, 下轮只查未读行 → 这封**永远**不再进候选 → Notion intent 永久缺失。
    同轮其它邮件不受牵连。"""
    backend = _Backend({101: True, 102: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5036, imap_uid=101)
    _save(w.sync_store, 5037, imap_uid=102)

    real_upsert = OutboxRepository.upsert_on_conn

    def _boom(self, conn, **kw):
        if kw.get("internal_id") == 5036:
            # 非锁类失败 (锁竞争另有 ConvergeLockBusy 让路语义, 见下面的锁竞争小节)
            raise sqlite3.OperationalError("disk I/O error")
        return real_upsert(self, conn, **kw)

    monkeypatch.setattr(OutboxRepository, "upsert_on_conn", _boom)

    await w._reconcile_inbound_read()          # 不抛 (仅 warning)

    assert w.sync_store.get(5036)["is_read"] == 0        # 整事务回滚 → 仍未读
    assert _outbox(w).list_by_internal_id(5036) == []    # 下轮还能重来
    assert w.sync_store.get(5037)["is_read"] == 1        # 同轮其它邮件照常收敛


async def test_converge_is_idempotent_across_cycles(tmp_path, enabled):
    """收敛过的行下轮不再是未读 → 不重复入队 (队里恒一条 pending)。"""
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5038, imap_uid=101)

    await w._reconcile_inbound_read()
    w._last_inbound_read_reconcile_at = time.monotonic() - 301
    await w._reconcile_inbound_read()

    assert len(_outbox(w).list_by_internal_id(5038)) == 1


def test_atomic_converge_serializes_competing_writer(tmp_path, monkeypatch):
    """事务边界的**直接**证据: 从「在途 intent 复核」到「outbox 入队」全程持写锁 ——
    竞争写者在这中间根本插不进来 (拿不到锁), 而不是"插进来了但我们运气好没读到"。
    钩子挂在 CAS 那一步 (闸已过、队未入), 正是老实现里两次独立 commit 的裂缝位置。"""
    from src.sync import outbox_intents

    store = SyncStore(str(tmp_path / "lock.db"))
    _save(store, 6201, imap_uid=31)
    repo = OutboxRepository(str(store.db_path))
    attempts: list[str] = []
    real_cas = SyncStore.mark_read_if_unread_on_conn

    def _probe_lock_mid_transaction(self, conn, internal_id, expected_updated_at):
        # timeout=0: 拿不到写锁立刻报错, 不在测试里干等 30s busy_timeout
        rival = sqlite3.connect(str(store.db_path), timeout=0)
        try:
            rival.execute(
                "UPDATE email_metadata SET is_read = 0 WHERE internal_id = ?",
                (internal_id,),
            )
            rival.commit()
            attempts.append("committed")
        except sqlite3.OperationalError as e:
            attempts.append(f"blocked: {e}")
        finally:
            rival.close()
        return real_cas(self, conn, internal_id, expected_updated_at)

    monkeypatch.setattr(SyncStore, "mark_read_if_unread_on_conn",
                        _probe_lock_mid_transaction)
    snapshot = store.get_inbox_unread_for_read_reconcile()[0]["updated_at"]

    assert outbox_intents.converge_local_read_atomic(
        store, repo, 6201, expected_updated_at=snapshot,
        notion_payload={"is_read": True}, source="read_reconcile",
    ) is True
    assert attempts and attempts[0].startswith("blocked")
    assert store.get(6201)["is_read"] == 1
    assert len(repo.list_by_internal_id(6201)) == 1


def test_atomic_converge_rejects_cross_database(tmp_path):
    """两表不同库 → 一个事务盖不住 → 显式拒绝, 不静默退化成两阶段提交。"""
    from src.sync import outbox_intents

    store = SyncStore(str(tmp_path / "a.db"))
    _save(store, 6202, imap_uid=32)
    with pytest.raises(ValueError, match="同库"):
        outbox_intents.converge_local_read_atomic(
            store, OutboxRepository(str(tmp_path / "b.db")), 6202,
            expected_updated_at=None,
            notion_payload={"is_read": True}, source="read_reconcile",
        )


# ============================================================
# 复核 → 收敛 按 chunk 紧邻 (codex 复审 BLOCK 1: 收窄外部竞态窗口)
# ============================================================


async def test_verify_and_converge_interleave_per_chunk(tmp_path, enabled, monkeypatch):
    """🔴 codex 复审 BLOCK 1: 「一次性复核全部候选 → 再逐封收敛」会把
    「FETCH 说已读」到「本地提交」的窗口拉成整批处理时长 (候选多时可达数秒), 期间用户
    在 Outlook 标回未读没有任何本地痕迹可拦。改成按 chunk「复核 → 立即收敛 → 下一
    chunk」后, 窗口只剩单 chunk 的本地事务时长。

    直接证据: 第 2 个 chunk 的复核发生时, 第 1 个 chunk 的行**已经**落库成已读 ——
    说明收敛没有被推迟到全部复核之后。"""
    monkeypatch.setattr(nw_mod, "READ_RECONCILE_CONVERGE_CHUNK", 2)
    seen_at_verify: list[list[int]] = []

    def _snapshot_db(_be):
        seen_at_verify.append(
            sorted(
                iid for iid in (5061, 5062, 5063, 5064)
                if w.sync_store.get(iid)["is_read"] == 1
            )
        )

    backend = _Backend({101: True, 102: True, 103: True, 104: True},
                       after_verify=_snapshot_db)
    w = _watcher(tmp_path, backend)
    for iid, uid in ((5061, 101), (5062, 102), (5063, 103), (5064, 104)):
        _save(w.sync_store, iid, imap_uid=uid)

    await w._reconcile_inbound_read()

    assert backend.verify_calls == [[101, 102], [103, 104]]   # 分块复核
    assert seen_at_verify[0] == []                            # 第 1 次复核时一封没收敛
    assert seen_at_verify[1] == [5061, 5062]                  # 第 2 次复核前 chunk1 已落库
    assert all(w.sync_store.get(i)["is_read"] == 1 for i in (5061, 5062, 5063, 5064))


async def test_chunk_verify_failure_keeps_earlier_chunks(tmp_path, enabled, monkeypatch):
    """后续 chunk 的复核失败 → 停止本轮, 但**已收敛的前面 chunk 不回滚**
    (它们各自的事务已提交, 且判据成立)。"""
    monkeypatch.setattr(nw_mod, "READ_RECONCILE_CONVERGE_CHUNK", 1)
    calls = {"n": 0}

    def _die_on_second(_be):
        calls["n"] += 1
        if calls["n"] >= 2:
            raise RuntimeError("imap dropped")

    backend = _Backend({101: True, 102: True}, after_verify=_die_on_second)
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5065, imap_uid=101)
    _save(w.sync_store, 5066, imap_uid=102)

    await w._reconcile_inbound_read()          # 不抛

    assert w.sync_store.get(5065)["is_read"] == 1        # 第 1 个 chunk 已收敛
    assert w.sync_store.get(5066)["is_read"] == 0        # 第 2 个 chunk 整块跳过
    assert len(_outbox(w).list_by_internal_id(5065)) == 1


async def test_marked_unread_between_verify_and_commit_is_converged(tmp_path, enabled):
    """⚠️ **已知残留竞态的行为固化 —— 这不是期望行为, 是把边界钉死。**

    场景 (codex 复审 BLOCK 1 描述): 定向 FETCH 返回 \\Seen=True 之后、本轮事务提交之前,
    用户在 Outlook 把这封标回未读。此刻**尚未**产生任何本地 SQLite 写或 outbox intent
    → CAS (updated_at 没变) 与在途 intent 闸 (队里没有) 都拦不住 → 这封仍被收敛成已读;
    下轮它已不在本地未读集, 而本功能单向 (不做已读→未读) → 不自愈。

    钩子只改 backend INBOX 的 FLAGS, **完全不碰 SQLite / outbox** —— 正是"外部改动
    没有本地痕迹"这个前提。窗口已由分块收窄到单 chunk 的本地事务时长 (毫秒级); 彻底
    消除需 CONDSTORE/MODSEQ 或提交后补偿事务, 对默认关的便利功能不成比例
    (见 _reconcile_inbound_read docstring)。用户侧兜底: 再标一次未读。"""
    def _user_marks_unread_on_server_only(be):
        be.inbox[101] = False          # 只有服务器侧变了, 本地零痕迹

    backend = _Backend({101: True}, after_verify=_user_marks_unread_on_server_only)
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5067, imap_uid=101)

    await w._reconcile_inbound_read()

    # 固化当前行为: 收敛发生。若哪天引入 MODSEQ/补偿事务, 这条断言会红 —— 那时改它。
    assert w.sync_store.get(5067)["is_read"] == 1
    assert len(_outbox(w).list_by_internal_id(5067)) == 1


# ============================================================
# SQLite 写锁竞争 (codex 复审 BLOCK 2: 不许在 event loop 上等锁)
# ============================================================


class _FakeMonotonic:
    """替身 ``time`` 模块: 只把 ``monotonic()`` 换成手动推进的假时钟, 其余属性
    (sleep / time / ...) 原样代理真 time —— 让"每封收敛耗时多少"可精确断言, 不必
    靠真 sleep 掐点 (真 sleep + sqlite fsync 抖动会让断言随机翻车)。"""

    def __init__(self):
        self._t = 0.0

    def advance(self, seconds: float):
        self._t += seconds

    def monotonic(self):
        return self._t

    def __getattr__(self, name):
        return getattr(time, name)


@contextmanager
def _hold_write_lock(db_path):
    """另一个"进程"持有 SQLite 写锁 —— 收敛事务的 BEGIN IMMEDIATE 会在此期间拿不到锁。"""
    conn = sqlite3.connect(str(db_path), timeout=5.0)
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()


async def test_converge_runs_off_the_event_loop_thread(tmp_path, enabled, monkeypatch):
    """🔴 codex 复审 BLOCK 2: 收敛事务必须跑在工作线程 —— 同步等 SQLite 写锁若发生在
    event loop 线程上, 别的进程持锁时每封候选都能把整个 watcher (fanout / reverse /
    island 全部 worker 的 tick) 冻住。"""
    from src.sync import outbox_intents

    seen_threads: list[threading.Thread] = []
    real = outbox_intents.converge_local_read_atomic

    def _record_thread(*a, **kw):
        seen_threads.append(threading.current_thread())
        return real(*a, **kw)

    monkeypatch.setattr(outbox_intents, "converge_local_read_atomic", _record_thread)
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5071, imap_uid=101)

    await w._reconcile_inbound_read()

    assert seen_threads, "收敛没被调用, 断言无意义"
    assert all(t is not threading.main_thread() for t in seen_threads)
    assert w.sync_store.get(5071)["is_read"] == 1


async def test_lock_contention_skips_email_without_blocking_loop(
    tmp_path, enabled, monkeypatch
):
    """写锁被别处长期持有 → 短 busy timeout 内拿不到 → 跳过该封 (下轮重判), 且**事件
    循环在等待期间照常跑** (并发 ticker 仍在推进)。"""
    monkeypatch.setattr(nw_mod, "READ_RECONCILE_LOCK_TIMEOUT_SEC", 0.3)
    backend = _Backend({101: True})
    w = _watcher(tmp_path, backend)
    _save(w.sync_store, 5072, imap_uid=101)

    ticks = 0

    async def _ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    with _hold_write_lock(w.sync_store.db_path):
        task = asyncio.create_task(_ticker())
        await w._reconcile_inbound_read()          # 不抛
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert ticks >= 3                              # 0.3s 锁等待期间 loop 没被冻住
    assert w.sync_store.get(5072)["is_read"] == 0  # 保守让路, 不半提交
    assert _outbox(w).list_by_internal_id(5072) == []


async def test_lock_contention_aborts_cycle_on_first_timeout(
    tmp_path, enabled, monkeypatch
):
    """锁竞争: **第一封**超时即终止本轮, 不继续消费已经变旧的 FETCH 快照。

    (语义反转记录: 早先是"连续 3 封超时才收尾"。锁超时与成功交替出现时"连续"计数
    永远清零, chunk 里靠后的封可能在前面 ~50 × 2s 的锁等待之后才提交 —— FETCH↔提交
    的残留竞态窗口被撑到近百秒。改成任何锁竞争即停: 更保守, 被跳过的封下个 interval
    重新 FETCH 取新鲜真值重判。)"""
    from src.sync import outbox_intents

    monkeypatch.setattr(nw_mod, "READ_RECONCILE_LOCK_TIMEOUT_SEC", 0.02)
    attempts: list[int] = []
    real = outbox_intents.converge_local_read_atomic

    def _count(store, repo, internal_id, **kw):
        attempts.append(internal_id)
        return real(store, repo, internal_id, **kw)

    monkeypatch.setattr(outbox_intents, "converge_local_read_atomic", _count)
    uids = [101, 102, 103, 104, 105]
    backend = _Backend({u: True for u in uids})
    w = _watcher(tmp_path, backend)
    for i, uid in enumerate(uids):
        _save(w.sync_store, 5080 + i, imap_uid=uid)

    with _hold_write_lock(w.sync_store.db_path):
        await w._reconcile_inbound_read()

    assert len(attempts) == 1                      # 第 1 封超时即终止, 不试完 5 封
    assert all(w.sync_store.get(5080 + i)["is_read"] == 0 for i in range(5))


async def test_scattered_lock_contention_also_aborts_cycle(
    tmp_path, enabled, monkeypatch
):
    """散发 (非连续) 的锁竞争同样终止本轮。

    (语义反转记录: 早先是"散发竞争不让后续陪葬"——收敛成功就把 streak 清零、继续跑完
    整个 chunk。取舍改为"任何锁竞争即停": 交替形态恰恰是把窗口撑到最大的那种, 而让路
    的代价只是这些封延到下个 interval 重判 —— 后者更保守。)"""
    from src.sync import outbox_intents

    real = outbox_intents.converge_local_read_atomic
    calls = {"n": 0}

    def _fail_every_other(store, repo, internal_id, **kw):
        calls["n"] += 1
        if calls["n"] % 2 == 1:
            raise outbox_intents.ConvergeLockBusy("database is locked")
        return real(store, repo, internal_id, **kw)

    monkeypatch.setattr(outbox_intents, "converge_local_read_atomic", _fail_every_other)
    uids = [101, 102, 103, 104, 105, 106]
    backend = _Backend({u: True for u in uids})
    w = _watcher(tmp_path, backend)
    for i, uid in enumerate(uids):
        _save(w.sync_store, 5090 + i, imap_uid=uid)

    await w._reconcile_inbound_read()

    assert calls["n"] == 1                          # 第一封就锁竞争 → 立即终止
    assert [w.sync_store.get(5090 + i)["is_read"] for i in range(6)] == [0] * 6


async def test_lock_abort_keeps_earlier_commits_and_defers_the_rest(
    tmp_path, enabled, monkeypatch
):
    """锁竞争终止本轮时: 已提交的前序封保持已提交 (不回滚, 与 chunk 失败 break 同语义),
    被跳过的封仍是本地未读 → 下轮仍是候选, 可重判。"""
    from src.sync import outbox_intents

    real = outbox_intents.converge_local_read_atomic
    calls = {"n": 0}

    def _lock_on_third(store, repo, internal_id, **kw):
        calls["n"] += 1
        if calls["n"] == 3:
            raise outbox_intents.ConvergeLockBusy("database is locked")
        return real(store, repo, internal_id, **kw)

    monkeypatch.setattr(outbox_intents, "converge_local_read_atomic", _lock_on_third)
    uids = [101, 102, 103, 104, 105]
    backend = _Backend({u: True for u in uids})
    w = _watcher(tmp_path, backend)
    for i, uid in enumerate(uids):
        _save(w.sync_store, 5100 + i, imap_uid=uid)

    await w._reconcile_inbound_read()

    assert calls["n"] == 3                                          # 第 3 封锁 → 停
    # 前两封已提交 (本地已读 + notion intent), 不因终止而回滚
    assert [w.sync_store.get(5100 + i)["is_read"] for i in range(5)] == [1, 1, 0, 0, 0]
    assert len(_outbox(w).list_by_internal_id(5101)) == 1
    # 未处理的仍是本地未读 → 下轮重新进候选 (重跑无竞争时收敛掉)
    assert _outbox(w).list_by_internal_id(5102) == []
    assert w.sync_store.get_inbox_unread_for_read_reconcile() != []

    monkeypatch.setattr(outbox_intents, "converge_local_read_atomic", real)
    w._last_inbound_read_reconcile_at = None
    await w._reconcile_inbound_read()
    assert [w.sync_store.get(5100 + i)["is_read"] for i in range(5)] == [1, 1, 1, 1, 1]


async def test_slow_but_successful_converges_hit_the_time_budget(
    tmp_path, enabled, monkeypatch
):
    """🔴 codex 第四轮 MEDIUM: 别的 writer 在每封之间反复抢放锁时, 每封都能在 busy
    timeout **之前**拿到锁 → 每封都成功、ConvergeLockBusy 一次都不抛, 但一个 100 封的
    chunk 能累计到分钟级, seen_map 照样在变旧 (FETCH↔提交窗口按 chunk 长度膨胀)。
    累计耗时预算兜住这一形态: 超预算即终止, 不再消费剩余 seen_map。"""
    from src.sync import outbox_intents

    # 注入假时钟而不是真 sleep: 真 sleep + sqlite fsync 抖动会让"第几封越预算"变随机
    # (实测同一组参数时而 1 封时而 2 封)。假时钟让"每封耗 0.6s、预算 1.0s"精确可断言。
    monkeypatch.setattr(nw_mod, "READ_RECONCILE_CHUNK_BUDGET_SEC", 1.0)
    monkeypatch.setattr(nw_mod, "time", _FakeMonotonic())
    real = outbox_intents.converge_local_read_atomic
    attempts: list[int] = []

    def _slow_but_ok(store, repo, internal_id, **kw):
        attempts.append(internal_id)
        nw_mod.time.advance(0.6)              # 等到了锁, 只是等得久 —— 不抛 LockBusy
        return real(store, repo, internal_id, **kw)

    monkeypatch.setattr(outbox_intents, "converge_local_read_atomic", _slow_but_ok)
    uids = [101, 102, 103, 104, 105]
    backend = _Backend({u: True for u in uids})
    w = _watcher(tmp_path, backend)
    for i, uid in enumerate(uids):
        _save(w.sync_store, 5110 + i, imap_uid=uid)

    await w._reconcile_inbound_read()

    # 2 × 0.6s 越过 1.0s 预算 → 第 3 封起不再消费 (全程没有一次 ConvergeLockBusy)
    assert attempts == [5110, 5111]
    # 前序已提交的不回滚 (本地已读 + notion intent 都在)
    assert [w.sync_store.get(5110 + i)["is_read"] for i in range(5)] == [1, 1, 0, 0, 0]
    assert len(_outbox(w).list_by_internal_id(5111)) == 1
    # 剩余留给下轮: 仍是本地未读候选, 无竞争重跑即收敛
    assert _outbox(w).list_by_internal_id(5112) == []
    monkeypatch.setattr(outbox_intents, "converge_local_read_atomic", real)
    w._last_inbound_read_reconcile_at = None
    await w._reconcile_inbound_read()
    assert [w.sync_store.get(5110 + i)["is_read"] for i in range(5)] == [1] * 5


async def test_time_budget_does_not_fire_on_the_normal_path(tmp_path, enabled):
    """预算不许误伤正常路径: 无竞争时整个 chunk 全是本地语句 (毫秒级), 一封都不该被
    预算截掉 —— 用生产默认值 (不 monkeypatch) 跑满 chunk。"""
    uids = list(range(201, 221))
    backend = _Backend({u: True for u in uids})
    w = _watcher(tmp_path, backend)
    for i, uid in enumerate(uids):
        _save(w.sync_store, 5130 + i, imap_uid=uid)

    started = time.monotonic()
    await w._reconcile_inbound_read()

    assert time.monotonic() - started < nw_mod.READ_RECONCILE_CHUNK_BUDGET_SEC
    assert all(w.sync_store.get(5130 + i)["is_read"] == 1 for i in range(len(uids)))


def test_converge_raises_lock_busy_on_short_timeout(tmp_path):
    """求值单元: busy_timeout_sec 到点仍拿不到写锁 → ConvergeLockBusy (与真失败分型),
    且不留半提交。"""
    from src.sync import outbox_intents

    store = SyncStore(str(tmp_path / "busy.db"))
    _save(store, 6301, imap_uid=41)
    repo = OutboxRepository(str(store.db_path))
    snapshot = store.get_inbox_unread_for_read_reconcile()[0]["updated_at"]

    with _hold_write_lock(store.db_path):
        started = time.monotonic()
        with pytest.raises(outbox_intents.ConvergeLockBusy):
            outbox_intents.converge_local_read_atomic(
                store, repo, 6301, expected_updated_at=snapshot,
                notion_payload={"is_read": True}, source="read_reconcile",
                busy_timeout_sec=0.05,
            )
        assert time.monotonic() - started < 5.0     # 短 timeout 生效, 不是默认 30s

    assert store.get(6301)["is_read"] == 0
    assert repo.list_by_internal_id(6301) == []


def test_converge_non_lock_failure_still_raises(tmp_path, monkeypatch):
    """非锁类失败不许被 ConvergeLockBusy 吞掉 (调用方要 warning 出来, 不是静默让路)。"""
    from src.sync import outbox_intents

    store = SyncStore(str(tmp_path / "err.db"))
    _save(store, 6302, imap_uid=42)
    repo = OutboxRepository(str(store.db_path))
    snapshot = store.get_inbox_unread_for_read_reconcile()[0]["updated_at"]
    monkeypatch.setattr(
        OutboxRepository, "upsert_on_conn",
        lambda *a, **kw: (_ for _ in ()).throw(sqlite3.OperationalError("disk I/O error")),
    )

    with pytest.raises(sqlite3.OperationalError, match="disk I/O"):
        outbox_intents.converge_local_read_atomic(
            store, repo, 6302, expected_updated_at=snapshot,
            notion_payload={"is_read": True}, source="read_reconcile",
        )
    assert store.get(6302)["is_read"] == 0            # 事务整体回滚


# ============================================================
# sync_store.get_inbox_unread_for_read_reconcile — 本地未读集
# ============================================================

def test_local_unread_query_shape_and_variants(tmp_path):
    """只返未读行, 带 imap_uid/uidvalidity; 内建收件箱按变体集 IN 查
    (canonical 'INBOX' 变体行也在内, 见 mailbox 语义单源纪律)。"""
    store = SyncStore(str(tmp_path / "q.db"))
    _save(store, 6001, is_read=False, imap_uid=11, is_flagged=True)
    _save(store, 6002, is_read=True, imap_uid=12)
    _save(store, 6003, is_read=False, imap_uid=13, mailbox="INBOX")
    _save(store, 6004, is_read=False, imap_uid=14, mailbox="发件箱")

    rows = store.get_inbox_unread_for_read_reconcile()
    by_id = {r["internal_id"]: r for r in rows}

    assert set(by_id) == {6001, 6003}
    assert by_id[6001]["imap_uid"] == 11
    assert by_id[6001]["imap_uidvalidity"] == 7
    assert by_id[6001]["updated_at"] is not None      # 提交时 CAS 要拿它比对


def test_mark_read_if_unread_cas(tmp_path):
    """CAS 语义: 未读 + updated_at 与快照一致才改得动; 已读 / updated_at 变过 /
    行不存在 → False (调用方放弃)。旗标不碰。"""
    store = SyncStore(str(tmp_path / "cas.db"))
    _save(store, 6101, is_read=False, is_flagged=True, imap_uid=21)
    _save(store, 6102, is_read=True, imap_uid=22)
    _save(store, 6103, is_read=False, imap_uid=23)
    snap = {r["internal_id"]: r["updated_at"]
            for r in store.get_inbox_unread_for_read_reconcile()}

    conn = sqlite3.connect(str(store.db_path), timeout=30.0)
    try:
        assert store.mark_read_if_unread_on_conn(conn, 6102, None) is False
        assert store.mark_read_if_unread_on_conn(conn, 999999, None) is False
        # updated_at 与快照不符 → 期间被别处写过 → 放弃
        assert store.mark_read_if_unread_on_conn(conn, 6103, snap[6103] + 1) is False
        assert store.mark_read_if_unread_on_conn(conn, 6101, snap[6101]) is True
        conn.commit()
    finally:
        conn.close()

    assert store.get(6101)["is_read"] == 1
    assert store.get(6101)["is_flagged"] == 1     # 只动 is_read
    assert store.get(6103)["is_read"] == 0
