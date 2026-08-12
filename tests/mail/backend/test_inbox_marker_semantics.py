"""INBOX 增量 marker 语义 + 取数三态 (2026-08-11 丢邮件事故回归网)。

## 钉死的两条 marker 语义 —— 相反的下界规则, 混用就丢信

=============== ============================== ==================
folder          marker 是什么                   SEARCH 下界
=============== ============================== ==================
INBOX           ``STATUS(UIDNEXT)``             ``UID {m}:*``  inclusive
                = 下一个将分配的 UID
Sent / custom   ``MAX(imap_uid)`` (SQLite)      ``UID {m+1}:*`` exclusive
                = 已导入的最大 UID
=============== ============================== ==================

RFC 3501: UIDNEXT 是"此后到达邮件 UID 的下界" ⇒ 新邮件 ``UID >= UIDNEXT``。
事故根因就是两者共用了同一个 ``+1`` 公式, 于是每当新邮件恰好拿到
``UID == 上轮 UIDNEXT`` 就被永久跳过 (生产 351 封漏 3 封)。生产 DavMail
实测**不做 RFC 3501 范围反转** (``UID <越界>:*`` 直接返空而非退化成返回最大那封),
所以没有任何兜底掩盖它。

## 取数三态 (B1′)

- ``OK`` + 空 → ``[]``, 合法空成功, 上层照常推进游标;
- 协议/解析/分配失败 → ``FolderFetchError``, 上层不推进;
- 有结果 → list。
"""
from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

from src.mail.backend.base import FolderFetchError
from src.mail.backend.davmail_backend import DavMailBackend


class _Imap:
    """可控 IMAP: 记录 SEARCH criteria, 可注入各阶段失败。"""

    def __init__(self, folders, *, fail_select=(), fail_search=(),
                 fail_fetch=(), drop_fetch_items=0):
        self._folders = folders
        self.fail_select = set(fail_select)
        self.fail_search = set(fail_search)
        self.fail_fetch = set(fail_fetch)
        self.drop_fetch_items = drop_fetch_items
        self._selected = None
        self.untagged_responses = {}
        self.search_criteria: dict[str, tuple] = {}

    @staticmethod
    def _unquote(name):
        if len(name) >= 2 and name[0] == '"' and name[-1] == '"':
            return name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        return name

    def select(self, folder, readonly=False):
        folder = self._unquote(folder)
        if folder in self.fail_select:
            return ("NO", [b"SELECT failed (test)"])
        if folder not in self._folders:
            return ("NO", [b"no such folder"])
        self._selected = folder
        self.untagged_responses = {
            "UIDVALIDITY": [str(self._folders[folder]["uidvalidity"]).encode()]
        }
        return ("OK", [b"1 EXISTS"])

    def uid(self, cmd, *args):
        if cmd == "search":
            key, arg = args[1], args[2]
            self.search_criteria[self._selected] = (key, arg)
            if self._selected in self.fail_search:
                return ("NO", [b"SEARCH failed (test)"])
            # 真实实现 `UID lo:*` 的语义 = UID >= lo (实测 DavMail 不做范围反转)
            uids = self._folders[self._selected]["uids"]
            if key == "UID":
                lo = int(str(arg).split(":")[0])
                uids = [u for u in uids if u >= lo]
            return ("OK", [" ".join(str(u) for u in uids).encode()])
        if cmd == "fetch":
            if self._selected in self.fail_fetch:
                return ("NO", [b"FETCH failed (test)"])
            uids = [int(x) for x in args[0].split(",")]
            if self.drop_fetch_items:
                uids = uids[: -self.drop_fetch_items] or []
            data = []
            for u in uids:
                msgid, subj = self._folders[self._selected]["messages"][u]
                meta = f"1 (UID {u} FLAGS () BODY[HEADER.FIELDS] {{50}}".encode()
                body = (
                    f"Message-ID: <{msgid}>\r\n"
                    f"Subject: {subj}\r\n"
                    f"Date: Tue, 11 Aug 2026 10:00:00 +0000\r\n\r\n"
                ).encode()
                data.append((meta, body))
            return ("OK", data)
        raise AssertionError(f"unexpected uid cmd {cmd}")

    def status(self, folder, what):
        f = self._folders.get(self._unquote(folder), {})
        uidnext = max(f.get("uids", [0]) or [0]) + 1
        return ("OK", [
            f"{folder} (UIDNEXT {uidnext} UIDVALIDITY "
            f"{f.get('uidvalidity', 1)})".encode()
        ])


def _backend(folders, *, sent_folder=None, sent_marker=0, custom=(), **imap_kw):
    b = DavMailBackend.__new__(DavMailBackend)
    b.cfg = MagicMock()
    b.cfg.folder_sync_max_messages = 0
    b.cfg.folder_sync_past_days = 90
    b.cfg.sync_start_date = "2026-01-01"
    b.sync_store = MagicMock()
    counter = {"n": 1_000_000_000}

    def _alloc():
        counter["n"] += 1
        return counter["n"]

    b.sync_store.allocate_davmail_internal_id = _alloc
    b.inbox_uidvalidity = None
    b.sent_folder = sent_folder
    b.drafts_folder = None
    b._sync_sent = sent_folder is not None
    b._custom_folders = list(custom)
    b._cached_marker = None
    b._max_folder_imap_uid = MagicMock(return_value=0)
    b._max_sent_imap_uid = MagicMock(return_value=sent_marker)
    b._get_folder_uidvalidity = MagicMock(return_value=None)
    b._set_folder_uidvalidity = MagicMock()
    b._fake = _Imap(folders, **imap_kw)
    return b


@contextmanager
def _sess(b):
    yield b._fake


def _patch(monkeypatch, b):
    monkeypatch.setattr(
        "src.mail.backend.davmail_backend.imap_session",
        lambda cfg, timeout=60: _sess(b),
    )


def _inbox(uids, uidvalidity=1):
    return {
        "INBOX": {
            "uidvalidity": uidvalidity,
            "uids": list(uids),
            "messages": {u: (f"msg-{u}@test", f"subject {u}") for u in uids},
        }
    }


# ============================================================
# A — INBOX 下界必须 inclusive
# ============================================================

def test_inbox_lower_bound_is_inclusive(monkeypatch):
    """marker=UIDNEXT ⇒ 下界必须是 marker 本身, 不是 marker+1。"""
    b = _backend(_inbox([]))
    _patch(monkeypatch, b)
    b.get_new_emails(162577)
    assert b._fake.search_criteria["INBOX"] == ("UID", "162577:*"), (
        "INBOX 下界用了 marker+1 —— 会恒定跳过 UID == marker 的那一封"
    )


def test_email_with_uid_equal_to_marker_is_fetched(monkeypatch):
    """🔴 事故复现: UID 恰好等于上轮 UIDNEXT 的邮件必须被抓到 (改动前必红)。

    生产实例: marker=162577, Penry 那封的 UID 正好是 162577 →
    旧代码搜 `UID 162578:*` → 落空 → 游标推进 → 永久丢失。
    """
    b = _backend(_inbox([162577]))
    _patch(monkeypatch, b)
    out = b.get_new_emails(162577)
    assert [e["imap_uid"] for e in out] == [162577], (
        "UID == marker 的邮件没被抓到 —— 这正是 2026-08-11 丢的那三封的形态"
    )


def test_marker_zero_does_not_emit_uid_zero(monkeypatch):
    """首次同步 marker=0: UID 从 1 起, `UID 0:*` 非法, 必须钳到 1。"""
    b = _backend(_inbox([]))
    _patch(monkeypatch, b)
    b.get_new_emails(0)
    assert b._fake.search_criteria["INBOX"] == ("UID", "1:*")


def test_inclusive_boundary_refetches_only_one_extra(monkeypatch):
    """inclusive 的代价是每轮最多重抓边界那一封 —— 由 message_id merge 去重。"""
    b = _backend(_inbox([100, 101, 102]))
    _patch(monkeypatch, b)
    out = b.get_new_emails(100)
    assert [e["imap_uid"] for e in out] == [100, 101, 102]


# ============================================================
# A — Sent / custom 的下界必须保持 exclusive (相反语义, 不许被"一起改")
# ============================================================

def test_sent_lower_bound_stays_exclusive(monkeypatch):
    """Sent 的 marker 是"已导入最大 UID" ⇒ +1 才对, 不能跟着 INBOX 改。"""
    folders = _inbox([])
    folders["Sent"] = {"uidvalidity": 1, "uids": [], "messages": {}}
    b = _backend(folders, sent_folder="Sent", sent_marker=500)
    _patch(monkeypatch, b)
    b.get_new_emails(100)
    assert b._fake.search_criteria["Sent"] == ("UID", "501:*"), (
        "Sent 下界被误改成 inclusive —— 会每轮重抓已导入的最后一封发件"
    )


def test_custom_folder_lower_bound_stays_exclusive(monkeypatch):
    """自定义文件夹同 Sent: marker = 已导入最大 UID ⇒ exclusive。"""
    folders = _inbox([])
    folders["Team"] = {"uidvalidity": 1, "uids": [], "messages": {}}
    b = _backend(folders, custom=["Team"])
    b._max_folder_imap_uid = MagicMock(return_value=77)
    _patch(monkeypatch, b)
    b.get_new_emails(100)
    assert b._fake.search_criteria["Team"] == ("UID", "78:*")


# ============================================================
# B1′ — 取数三态
# ============================================================

def test_ok_empty_is_legal_empty_not_error(monkeypatch):
    """OK + 空结果 = 合法空成功, 必须返 [] 而不是 raise (否则游标卡死)。"""
    b = _backend(_inbox([]))
    _patch(monkeypatch, b)
    assert b.get_new_emails(100) == []


def test_inbox_select_failure_raises(monkeypatch):
    b = _backend(_inbox([100]), fail_select={"INBOX"})
    _patch(monkeypatch, b)
    with pytest.raises(FolderFetchError, match="SELECT"):
        b.get_new_emails(50)


def test_inbox_search_failure_raises(monkeypatch):
    b = _backend(_inbox([100]), fail_search={"INBOX"})
    _patch(monkeypatch, b)
    with pytest.raises(FolderFetchError, match="SEARCH"):
        b.get_new_emails(50)


def test_inbox_fetch_failure_raises(monkeypatch):
    b = _backend(_inbox([100]), fail_fetch={"INBOX"})
    _patch(monkeypatch, b)
    with pytest.raises(FolderFetchError, match="FETCH"):
        b.get_new_emails(50)


def test_partial_parse_raises(monkeypatch):
    """SEARCH 说 3 封、只解析出 2 封 → 整批失败, 不能让差额那封随游标出窗。"""
    b = _backend(_inbox([100, 101, 102]), drop_fetch_items=1)
    _patch(monkeypatch, b)
    with pytest.raises(FolderFetchError, match="parsed"):
        b.get_new_emails(100)


def test_internal_id_allocation_failure_raises(monkeypatch):
    b = _backend(_inbox([100]))
    b.sync_store.allocate_davmail_internal_id = MagicMock(
        side_effect=RuntimeError("db locked")
    )
    _patch(monkeypatch, b)
    with pytest.raises(FolderFetchError, match="allocate"):
        b.get_new_emails(100)


# ============================================================
# B1′ — 隔离: Sent/custom 失败不得阻断 INBOX 主路径
# ============================================================

def test_sent_failure_does_not_break_inbox(monkeypatch):
    """Sent SELECT 失败只 log, INBOX 结果照常返回 (隔离语义不回归)。"""
    folders = _inbox([100])
    folders["Sent"] = {"uidvalidity": 1, "uids": [], "messages": {}}
    b = _backend(folders, sent_folder="Sent", fail_select={"Sent"})
    _patch(monkeypatch, b)
    out = b.get_new_emails(100)
    assert [e["imap_uid"] for e in out] == [100]


def test_custom_folder_failure_does_not_break_inbox(monkeypatch):
    folders = _inbox([100])
    folders["Team"] = {"uidvalidity": 1, "uids": [], "messages": {}}
    b = _backend(folders, custom=["Team"], fail_search={"Team"})
    _patch(monkeypatch, b)
    out = b.get_new_emails(100)
    assert [e["imap_uid"] for e in out] == [100]
