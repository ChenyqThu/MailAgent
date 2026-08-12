"""收件箱对账兜底 C + 通知 provenance E (2026-08-11 丢邮件事故)。

对账**与漏抓成因无关**: 直接按 Message-ID 比对服务器与本地, 兜住 off-by-one /
协议失败 / UID 重编号 / 尚未发现的任何成因。本文件锚死它的几条不变量:

- flag off → 字节级 inert (零 IMAP 命令);
- 判据是 Message-ID **不是 UID** (UID 会重编号, 实测 32% 不符);
- 只补不删;
- 截断视图打断窗口 → incomplete, 不谎称"查全了";
- 空 / 重复 Message-ID 走异常通道, 不混进集合差;
- 通知门控判据 = 补抓来源 AND 超龄 (正常增量的停机积压**照发**)。
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest


from src.mail.backend.davmail_backend import DavMailBackend
from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore


# ============================================================
# backend.reconcile_inbox
# ============================================================

class _Imap:
    def __init__(self, uids, messages, *, uidvalidity=1, oldest_internaldate=None,
                 fail_select=False, fail_search=False, fail_fetch=False):
        self.uids = list(uids)
        self.messages = messages          # uid -> (msgid, subject)
        self.uidvalidity = uidvalidity
        self.oldest_internaldate = oldest_internaldate
        self.fail_select = fail_select
        self.fail_search = fail_search
        self.fail_fetch = fail_fetch
        self.untagged_responses = {}
        self.commands: list[str] = []

    def select(self, folder, readonly=False):
        self.commands.append("SELECT")
        if self.fail_select:
            return ("NO", [b"fail"])
        self.untagged_responses = {
            "UIDVALIDITY": [str(self.uidvalidity).encode()]
        }
        return ("OK", [b"1 EXISTS"])

    def fetch(self, seq, what):
        # _oldest_visible_internaldate 的单条按序号 FETCH
        self.commands.append("FETCH-SEQ")
        if self.oldest_internaldate is None:
            return ("NO", [])
        s = self.oldest_internaldate.strftime("%d-%b-%Y %H:%M:%S %z")
        return ("OK", [f'1 (INTERNALDATE "{s}")'.encode()])

    def uid(self, cmd, *args):
        if cmd == "search":
            self.commands.append("SEARCH")
            if self.fail_search:
                return ("NO", [b"fail"])
            return ("OK", [" ".join(str(u) for u in self.uids).encode()])
        if cmd == "fetch":
            self.commands.append("FETCH-UID")
            if self.fail_fetch:
                return ("NO", [b"fail"])
            out = []
            for u in [int(x) for x in args[0].split(",")]:
                msgid, subj = self.messages[u]
                meta = f"1 (UID {u} FLAGS () BODY[HEADER.FIELDS] {{50}}".encode()
                mid_line = f"Message-ID: <{msgid}>\r\n" if msgid else ""
                body = (
                    f"{mid_line}"
                    f"Subject: {subj}\r\n"
                    f"From: a@test\r\n"
                    f"Date: Tue, 11 Aug 2026 10:00:00 +0000\r\n\r\n"
                ).encode()
                out.append((meta, body))
            return ("OK", out)
        raise AssertionError(cmd)


def _backend(imap, known_msgids=frozenset(), known_uid_pairs=frozenset()):
    b = DavMailBackend.__new__(DavMailBackend)
    b.cfg = MagicMock()
    b.sync_store = MagicMock()
    counter = {"n": 1_000_000_000}

    def _alloc():
        counter["n"] += 1
        return counter["n"]

    b.sync_store.allocate_davmail_internal_id = _alloc
    b.sync_store.get_inbox_reconcile_fingerprints = MagicMock(
        return_value=(set(known_msgids), set(known_uid_pairs))
    )
    b.inbox_uidvalidity = None
    b._fake = imap
    return b


def _patch(monkeypatch, b):
    @contextmanager
    def _s(cfg, timeout=60):
        yield b._fake
    monkeypatch.setattr("src.mail.backend.davmail_backend.imap_session", _s)


def _old(days):
    return datetime.now(timezone.utc) - timedelta(days=days)


def test_no_status_precheck_every_round_really_queries(monkeypatch):
    """🔴 对账**有意不做** STATUS 快照预检 —— 每轮都真查。

    「远端没变就跳过」看着自然 (reconcile_drafts 就这么干), 但在 INBOX 上要成立必须
    维持「**任何**本地行丢失都能打破快照」这个全称命题。2026-08 这批 review 里它破了
    两次 (只绑远端 → 本地误删漏检; 补 date_received 窗口 COUNT → Date header 可伪造;
    换 UID 空间摘要 → 仍漏 imap_uid IS NULL 的 AppleScript 行、旧 UIDVALIDITY 行,
    且等和交换不变)。**兜底机制被静默禁用是最坏的失败模式**, 用它换一次低频 SEARCH
    不成比例。本测试锚死这个决定, 防有人"顺手优化"回来。
    """
    imap = _Imap([1], {1: ("a@t", "A")}, oldest_internaldate=_old(30))
    b = _backend(imap, known_msgids={"a@t"})       # 本地已齐 = 最"该跳过"的情形
    _patch(monkeypatch, b)

    assert b.reconcile_inbox(2).status == "complete"
    imap.commands.clear()
    r2 = b.reconcile_inbox(2)
    assert r2.status == "complete", "第二轮被跳过了 —— 快照预检被重新引入"
    assert "SEARCH" in imap.commands, "第二轮没有真查 —— 快照预检被重新引入"


def test_missing_detected_by_message_id(monkeypatch):
    """本地缺的按 Message-ID 找出来。"""
    imap = _Imap([1, 2, 3], {1: ("a@t", "A"), 2: ("b@t", "B"), 3: ("c@t", "C")},
                 oldest_internaldate=_old(10))
    b = _backend(imap, known_msgids={"a@t", "c@t"})
    _patch(monkeypatch, b)
    r = b.reconcile_inbox(2)
    assert r.status == "complete"
    assert [m["message_id"] for m in r.missing] == ["b@t"]


def test_uid_drift_does_not_cause_false_positive(monkeypatch):
    """🔴 UID 全部漂移但 Message-ID 都在 → 零缺失。

    判据若用 uid 就会把这 3 封全判成缺失 (实测 32% 的行 uid 与服务器现值不符)。
    """
    imap = _Imap([9001, 9002, 9003],
                 {9001: ("a@t", "A"), 9002: ("b@t", "B"), 9003: ("c@t", "C")},
                 oldest_internaldate=_old(10))
    # 本地存的 uid 完全不同 (漂移), 但 message_id 齐全
    b = _backend(imap, known_msgids={"a@t", "b@t", "c@t"},
                 known_uid_pairs={(1, 11), (1, 22), (1, 33)})
    _patch(monkeypatch, b)
    r = b.reconcile_inbox(2)
    assert r.missing == [], "按 UID 比对产生了假阳性 —— 判据必须是 Message-ID"


def test_truncated_window_is_incomplete(monkeypatch):
    """视图最老一封晚于窗口起点 → incomplete (不谎称查全)。"""
    imap = _Imap([1], {1: ("a@t", "A")}, oldest_internaldate=_old(1))
    b = _backend(imap)
    _patch(monkeypatch, b)
    r = b.reconcile_inbox(7)          # 要 7 天, 视图只到 1 天前
    assert r.status == "incomplete"


def test_full_coverage_is_complete(monkeypatch):
    imap = _Imap([1], {1: ("a@t", "A")}, oldest_internaldate=_old(30))
    b = _backend(imap)
    _patch(monkeypatch, b)
    assert b.reconcile_inbox(2).status == "complete"


def test_unknown_oldest_is_conservative(monkeypatch):
    """读不到最老可见时间 → 保守 incomplete, 不假装覆盖。"""
    imap = _Imap([1], {1: ("a@t", "A")}, oldest_internaldate=None)
    b = _backend(imap)
    _patch(monkeypatch, b)
    assert b.reconcile_inbox(2).status == "incomplete"


def test_empty_message_id_uses_uid_channel(monkeypatch):
    """无 Message-ID 的邮件走 (uv, uid) 异常通道 + 计数, 不混进集合差。"""
    imap = _Imap([1, 2], {1: ("", "no-msgid-known"), 2: ("", "no-msgid-new")},
                 oldest_internaldate=_old(10))
    b = _backend(imap, known_uid_pairs={(1, 1)})
    _patch(monkeypatch, b)
    r = b.reconcile_inbox(2)
    assert r.empty_msgid == 2
    assert [m["imap_uid"] for m in r.missing] == [2]


def test_remote_duplicate_message_id_counted_not_merged(monkeypatch):
    """远端两封共用一个 Message-ID → 计数 + 跳过, 不静默合并。"""
    imap = _Imap([1, 2], {1: ("dup@t", "first"), 2: ("dup@t", "second")},
                 oldest_internaldate=_old(10))
    b = _backend(imap)
    _patch(monkeypatch, b)
    r = b.reconcile_inbox(2)
    assert r.duplicate_msgid == 1
    assert len(r.missing) == 1


def test_select_failure_is_skipped(monkeypatch):
    b = _backend(_Imap([], {}, fail_select=True))
    _patch(monkeypatch, b)
    assert b.reconcile_inbox(2).status == "skipped"


def test_search_failure_is_skipped(monkeypatch):
    b = _backend(_Imap([1], {1: ("a@t", "A")}, fail_search=True))
    _patch(monkeypatch, b)
    assert b.reconcile_inbox(2).status == "skipped"


def test_fetch_chunk_failure_downgrades_to_incomplete(monkeypatch):
    """单批 FETCH 失败: 不整轮作废, 但本轮不能自称 complete。"""
    imap = _Imap([1], {1: ("a@t", "A")}, oldest_internaldate=_old(30),
                 fail_fetch=True)
    b = _backend(imap)
    _patch(monkeypatch, b)
    r = b.reconcile_inbox(2)
    assert r.status == "incomplete"
    assert r.missing == []


def test_partial_parse_downgrades_to_incomplete(monkeypatch):
    """🔴 chunk 解析少项 → incomplete (codex round-2 HIGH 1)。

    `_parse_batch_headers` 会静默丢弃缺 UID / MIME 解析失败的项并返回**较短**列表。
    少了这道校验, 恰好是需要补抓的那封被丢掉时, 本轮仍会自称 complete 并写
    last_complete_at —— 就是上一轮在增量路径指出的"部分结果被当成功"在对账路径的翻版。
    """
    imap = _Imap([1, 2, 3],
                 {1: ("a@t", "A"), 2: ("b@t", "B"), 3: ("c@t", "C")},
                 oldest_internaldate=_old(30))
    b = _backend(imap)
    _patch(monkeypatch, b)
    # 让解析层丢掉一项
    real = b._parse_batch_headers
    b._parse_batch_headers = lambda data, uidvalidity: real(
        data, uidvalidity=uidvalidity
    )[:-1]
    r = b.reconcile_inbox(2)
    assert r.status == "incomplete", "部分解析被当成了完整成功"


def test_missing_payload_is_tagged_for_provenance(monkeypatch):
    imap = _Imap([1], {1: ("a@t", "A")}, oldest_internaldate=_old(30))
    b = _backend(imap)
    _patch(monkeypatch, b)
    m = b.reconcile_inbox(2).missing[0]
    assert m["ingest_reason"] == "inbox_reconcile"
    assert m["backend_origin"] == "davmail"
    assert m["internal_id"] >= 1_000_000_000


@pytest.mark.parametrize("raw,expect_iso", [
    ("11-Aug-2026 18:41:17 +0000", "2026-08-11T18:41:17+00:00"),
    # 🔴 负时区偏移: 解析用 replace("-", " ", 2) 只换日期里那两个连字符,
    # 时区的第 3 个 '-' 绝不能被换掉 (换了就解析失败 → 完整性闸恒 incomplete)
    ("05-Aug-2026 16:38:06 -0700", "2026-08-05T16:38:06-07:00"),
    # IMAP 单位数日是**空格填充**不是补零
    (" 1-Aug-2026 00:00:00 +0800", "2026-08-01T00:00:00+08:00"),
    ("31-Dec-2025 23:59:59 -1200", "2025-12-31T23:59:59-12:00"),
])
def test_internaldate_parsing_edge_cases(monkeypatch, raw, expect_iso):
    """完整性闸依赖 INTERNALDATE 解析 —— 这是个脆弱的字符串 hack, 钉死边界。

    解析失败会让 oldest_visible=None → 本轮恒 incomplete → 对账永远自称"没查全",
    是静默降级而非报错, 所以必须有测试盯着。
    """
    from src.mail.backend.davmail_backend import _oldest_visible_internaldate

    class _I:
        def fetch(self, seq, what):
            return ("OK", [f'1 (INTERNALDATE "{raw}")'.encode()])

    dt = _oldest_visible_internaldate(_I())
    assert dt is not None and dt.isoformat() == expect_iso


def test_internaldate_unparseable_returns_none():
    """读不到/解析不了 → None, 调用方按 incomplete 保守处理 (不能崩)。"""
    from src.mail.backend.davmail_backend import _oldest_visible_internaldate

    class _Bad:
        def fetch(self, seq, what):
            return ("OK", [b"1 (FLAGS ())"])      # 没有 INTERNALDATE 段

    class _Fail:
        def fetch(self, seq, what):
            raise RuntimeError("boom")

    assert _oldest_visible_internaldate(_Bad()) is None
    assert _oldest_visible_internaldate(_Fail()) is None


# ============================================================
# watcher 侧: flag 门 / 只补不删 / 节拍
# ============================================================

def _watcher(tmp_path, backend=None):
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = SyncStore(str(tmp_path / "t.db"))
    w._last_inbox_reconcile_at = None
    w.backend = backend if backend is not None else MagicMock(spec=[])
    return w


def test_flag_off_is_byte_level_inert(tmp_path, monkeypatch):
    """flag off → 完全不碰 backend (零 IMAP 命令)。"""
    from src.mail import new_watcher as nw

    backend = MagicMock()
    w = _watcher(tmp_path, backend)
    monkeypatch.setattr(nw.settings, "inbox_reconcile_enabled", False, raising=False)
    asyncio.run(w._reconcile_inbox())
    backend.reconcile_inbox.assert_not_called()


def test_applescript_backend_not_activated(tmp_path, monkeypatch):
    """AppleScript fallback 无 reconcile_inbox → 整段不激活 (应急回切安全)。"""
    from src.mail import new_watcher as nw

    w = _watcher(tmp_path, MagicMock(spec=[]))     # 没有 reconcile_inbox 属性
    monkeypatch.setattr(nw.settings, "inbox_reconcile_enabled", True, raising=False)
    asyncio.run(w._reconcile_inbox())              # 不抛


def test_interval_gate_skips_second_call(tmp_path, monkeypatch):
    """独立低频节拍: interval 内第二次调用不发 IMAP (绝不挂 5s poll)。"""
    from src.mail import new_watcher as nw
    from src.mail.backend.types import InboxReconcileResult

    backend = MagicMock()
    backend.reconcile_inbox = MagicMock(
        return_value=InboxReconcileResult(status="complete")
    )
    w = _watcher(tmp_path, backend)
    monkeypatch.setattr(nw.settings, "inbox_reconcile_enabled", True, raising=False)
    monkeypatch.setattr(nw.settings, "inbox_reconcile_interval_sec", 1800,
                        raising=False)
    asyncio.run(w._reconcile_inbox())
    asyncio.run(w._reconcile_inbox())
    assert backend.reconcile_inbox.call_count == 1


def test_reconcile_never_deletes(tmp_path, monkeypatch):
    """🔴 只补不删: 本地有、远端"缺席"的行必须原样保留。"""
    from src.mail import new_watcher as nw
    from src.mail.backend.types import InboxReconcileResult

    backend = MagicMock()
    backend.reconcile_inbox = MagicMock(
        return_value=InboxReconcileResult(status="complete", remote_total=0)
    )
    w = _watcher(tmp_path, backend)
    w.sync_store.save_email({
        "internal_id": 1_000_000_777,
        "message_id": "local-only@t",
        "subject": "本地有远端看不见 (已归档/截断窗口外)",
        "date_received": "2026-08-01T00:00:00+00:00",
        "mailbox": "收件箱",
        "sync_status": "synced",
    })
    monkeypatch.setattr(nw.settings, "inbox_reconcile_enabled", True, raising=False)
    asyncio.run(w._reconcile_inbox())
    assert w.sync_store.get(1_000_000_777) is not None, (
        "对账删了本地行 —— 缺席 ≠ 判据 (issue #58 同款坑)"
    )


def test_recovered_emails_land_as_pending(tmp_path, monkeypatch):
    from src.mail import new_watcher as nw
    from src.mail.backend.types import InboxReconcileResult

    backend = MagicMock()
    backend.reconcile_inbox = MagicMock(return_value=InboxReconcileResult(
        status="complete",
        missing=[{
            "internal_id": 1_000_000_888,
            "message_id": "recovered@t",
            "subject": "补回来的",
            "date_received": "2026-08-11T18:41:17+00:00",
            "mailbox": "收件箱",
            "imap_uid": 162577,
            "imap_uidvalidity": 1,
            "ingest_reason": "inbox_reconcile",
        }],
        remote_total=1,
    ))
    w = _watcher(tmp_path, backend)
    monkeypatch.setattr(nw.settings, "inbox_reconcile_enabled", True, raising=False)
    asyncio.run(w._reconcile_inbox())
    row = w.sync_store.get(1_000_000_888)
    assert row is not None and row["sync_status"] == "pending"
    assert row["ingest_reason"] == "inbox_reconcile"
    assert row["imap_uid"] == 162577


# ============================================================
# 本地指纹查询 (codex round-2 HIGH 2)
# ============================================================

def test_uid_pairs_only_from_null_message_id_rows(tmp_path):
    """🔴 uid_pairs 必须只收 message_id IS NULL 的行。

    收全部行会让"某封有 Message-ID 的旧行"恰好占用了远端某封无 ID 邮件的 uid,
    从而把后者**误判成已存在**而永不补抓。
    """
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1_000_000_101, "message_id": "has-mid@t", "subject": "有 ID",
        "date_received": _old(1).isoformat(), "mailbox": "收件箱",
        "imap_uid": 500, "imap_uidvalidity": 1, "sync_status": "synced",
    })
    store.save_email({
        "internal_id": 1_000_000_102, "message_id": None, "subject": "无 ID",
        "date_received": _old(1).isoformat(), "mailbox": "收件箱",
        "imap_uid": 501, "imap_uidvalidity": 1, "sync_status": "synced",
    })
    msgids, uid_pairs = store.get_inbox_reconcile_fingerprints(_old(3).isoformat())
    assert "has-mid@t" in msgids
    assert (1, 501) in uid_pairs
    assert (1, 500) not in uid_pairs, (
        "有 Message-ID 的行混进了 uid_pairs —— 会遮蔽远端无 ID 的邮件"
    )


def test_null_message_id_rows_ignore_date_window(tmp_path):
    """🔴 无 Message-ID 的行不按 date 窗口过滤。

    本地 date_received 来自 **Date header** (可伪造/缺失/严重滞后), 远端按
    INTERNALDATE 筛。窗口过滤会让这类行查不到 ⇒ 每轮判缺失 ⇒ 而 NULL 不进
    merge guard ⇒ **每 30 分钟真的新增一行 + 一个 Notion 页**。
    """
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1_000_000_111, "message_id": None,
        "subject": "Date header 是 2020 年的无 ID 邮件",
        "date_received": "2020-01-01T00:00:00+00:00",     # 远在窗口之外
        "mailbox": "收件箱", "imap_uid": 777, "imap_uidvalidity": 1,
        "sync_status": "synced",
    })
    _, uid_pairs = store.get_inbox_reconcile_fingerprints(_old(2).isoformat())
    assert (1, 777) in uid_pairs, (
        "无 ID 行被 date 窗口滤掉了 —— 会导致每轮重复补抓 + 重复建行"
    )


def test_message_ids_still_windowed(tmp_path):
    """有 Message-ID 的行仍按窗口收敛 (量大, 不能全表扫)。"""
    store = SyncStore(str(tmp_path / "t.db"))
    store.save_email({
        "internal_id": 1_000_000_121, "message_id": "ancient@t", "subject": "老",
        "date_received": "2020-01-01T00:00:00+00:00", "mailbox": "收件箱",
        "sync_status": "synced",
    })
    msgids, _ = store.get_inbox_reconcile_fingerprints(_old(2).isoformat())
    assert "ancient@t" not in msgids


# ============================================================
# E — 通知 provenance 门控
# ============================================================

def _seed(w, internal_id, ingest_reason, *, age_days=1):
    """种一封邮件。年龄由 **库里的 date_received** 决定 —— 判定用的就是这一列
    (三个通知入口拿到的日期字段形态各异, 只有这列是统一归一过的)。"""
    w.sync_store.save_email({
        "internal_id": internal_id,
        "message_id": f"m{internal_id}@t",
        "subject": "s",
        "date_received": _old(age_days).isoformat(),
        "mailbox": "收件箱",
        "sync_status": "pending",
        "ingest_reason": ingest_reason,
    })


def test_old_reconcile_backfill_is_suppressed(tmp_path, monkeypatch):
    from src.mail import new_watcher as nw

    w = _watcher(tmp_path)
    _seed(w, 1, "inbox_reconcile", age_days=1)
    monkeypatch.setattr(nw.settings, "reconcile_notify_max_age_sec", 7200,
                        raising=False)
    assert w._suppress_reconcile_notify(1) is True


def test_fresh_reconcile_backfill_still_notifies(tmp_path, monkeypatch):
    """刚到的邮件即使是对账补抓的也照常通知 (只有**老**的才抑制)。"""
    from src.mail import new_watcher as nw

    w = _watcher(tmp_path)
    w.sync_store.save_email({
        "internal_id": 2,
        "message_id": "m2@t",
        "subject": "s",
        "date_received": (
            datetime.now(timezone.utc) - timedelta(minutes=5)
        ).isoformat(),
        "mailbox": "收件箱",
        "sync_status": "pending",
        "ingest_reason": "inbox_reconcile",
    })
    monkeypatch.setattr(nw.settings, "reconcile_notify_max_age_sec", 7200,
                        raising=False)
    assert w._suppress_reconcile_notify(2) is False


def test_normal_incremental_backlog_still_notifies(tmp_path, monkeypatch):
    """🔴 停机 3 小时后恢复, 正常增量补上的老邮件**必须照常通知**。

    这是 codex HIGH 3 指出的误伤: 若门控只判年龄 (改 FeishuNotifier._is_recent),
    这类邮件会被一起吞掉。判据必须带 provenance。
    """
    from src.mail import new_watcher as nw

    w = _watcher(tmp_path)
    _seed(w, 3, None, age_days=1)         # 正常增量 (provenance 为 NULL)
    monkeypatch.setattr(nw.settings, "reconcile_notify_max_age_sec", 7200,
                        raising=False)
    assert w._suppress_reconcile_notify(3) is False


def test_provenance_is_persistent_not_in_memory(tmp_path, monkeypatch):
    """provenance 落库 ⇒ 跨「进程重启」仍然有效 (新建实例读同一个库)。"""
    from src.mail import new_watcher as nw

    w = _watcher(tmp_path)
    _seed(w, 4, "inbox_reconcile", age_days=1)
    monkeypatch.setattr(nw.settings, "reconcile_notify_max_age_sec", 7200,
                        raising=False)

    w2 = NewWatcher.__new__(NewWatcher)            # 模拟重启后的新实例
    w2.sync_store = SyncStore(str(tmp_path / "t.db"))
    assert w2._suppress_reconcile_notify(4) is True


def test_missing_row_is_conservative(tmp_path):
    """读不到 provenance → 保守通知 (宁多勿漏)。"""
    w = _watcher(tmp_path)
    assert w._suppress_reconcile_notify(999999) is False


def test_all_three_notify_entrypoints_share_one_predicate():
    """🔴 三个通知入口必须共用 ingest_provenance 单源, 不许各写一份。

    service.py 按 REDIS_EVENTS_ENABLED 在 handlers 与 reverse_sync 之间切换,
    只堵一个入口 = 换个配置就漏 (codex round-2 HIGH 3)。
    """
    import inspect

    from src.events import handlers as h
    from src.mail import new_watcher as nw
    from src.mail import reverse_sync as rs

    for mod, name in ((nw, "new_watcher"), (h, "handlers"), (rs, "reverse_sync")):
        src = inspect.getsource(mod)
        assert "should_suppress_reconcile_notify" in src, (
            f"{name} 没有接入对账通知门控 —— 该入口会漏推对账补抓的老邮件"
        )
