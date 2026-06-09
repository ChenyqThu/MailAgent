"""多文件夹同步取数核心: get_new_emails 自定义文件夹循环 + check_for_changes 检测。

mock imap_session + sqlite-touching helper (marker / uidvalidity)，验证:
- 🔒 隔离不变量: SYNC_FOLDERS 空 → 只 SELECT INBOX, 零自定义文件夹激活。
- 自定义文件夹邮件带正确 mailbox / backend_origin / 该 folder 的 imap_uidvalidity。
- marker>0 → UID 增量 criteria; marker==0 → SINCE 窗口回填。
- UIDVALIDITY 变化 → 全量重拉 (SINCE)。
- max_messages 截断取最新 N。
- 单文件夹 SELECT 失败隔离, 不影响 INBOX + 其它文件夹。
- 取数后持久化该 folder 的 UIDVALIDITY。
- check_for_changes 探测自定义文件夹触发 has_new。
"""
from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock


from src.mail.backend.davmail_backend import DavMailBackend


class FakeImap:
    """记录 SELECT/SEARCH 调用 + 按 folder 返回受控响应。"""

    def __init__(self, folders: dict, fail_select: set | None = None):
        # folders: imap_name -> {"uidvalidity": int, "uids": [int], "messages": {uid: (msgid, subj)}}
        self._folders = folders
        self.fail_select = fail_select or set()
        self._selected = None
        self.untagged_responses = {}
        self.select_calls: list[str] = []
        self.select_raw_calls: list[str] = []   # quote 前的原始参数 (验证 quoting)
        self.search_criteria: dict[str, tuple] = {}   # folder -> (key, arg)
        self.fetched: dict[str, list[int]] = {}        # folder -> fetched uids

    @staticmethod
    def _unquote(name):
        """代码对 mailbox 名 quote (含空格必需); 测试按未 quote 名查 dict。"""
        if len(name) >= 2 and name[0] == '"' and name[-1] == '"':
            return name[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        return name

    def select(self, folder, readonly=False):
        self.select_raw_calls.append(folder)
        folder = self._unquote(folder)
        self.select_calls.append(folder)
        if folder in self.fail_select:
            return ("NO", [b"SELECT failed (test)"])
        if folder not in self._folders:
            return ("NO", [b"no such folder"])
        self._selected = folder
        uv = self._folders[folder]["uidvalidity"]
        self.untagged_responses = {"UIDVALIDITY": [str(uv).encode()]}
        return ("OK", [b"1 EXISTS"])

    def uid(self, cmd, *args):
        if cmd == "search":
            key, arg = args[1], args[2]
            self.search_criteria[self._selected] = (key, arg)
            uids = self._folders[self._selected]["uids"]
            return ("OK", [" ".join(str(u) for u in uids).encode()])
        if cmd == "fetch":
            seq = args[0]
            uids = [int(x) for x in seq.split(",")]
            self.fetched[self._selected] = uids
            data = []
            for u in uids:
                msgid, subj = self._folders[self._selected]["messages"][u]
                meta = f"1 (UID {u} FLAGS () BODY[HEADER.FIELDS] {{50}}".encode()
                body = (
                    f"Message-ID: <{msgid}>\r\n"
                    f"Subject: {subj}\r\n"
                    f"Date: Sat, 1 Jan 2026 10:00:00 +0000\r\n\r\n"
                ).encode()
                data.append((meta, body))
            return ("OK", data)
        raise AssertionError(f"unexpected uid cmd {cmd}")

    def status(self, folder, what):
        f = self._folders.get(self._unquote(folder), {})
        uidnext = max(f.get("uids", [0]) or [0]) + 1
        uv = f.get("uidvalidity", 1)
        return ("OK", [f"{folder} (UIDNEXT {uidnext} UIDVALIDITY {uv})".encode()])


def _backend(custom_folders, folders, fail_select=None, *, alloc_start=1_000_000_000):
    b = DavMailBackend.__new__(DavMailBackend)
    b.cfg = MagicMock()
    b.cfg.folder_sync_max_messages = 0
    b.cfg.folder_sync_past_days = 90
    b.cfg.sync_start_date = "2026-01-01"
    b.sync_store = MagicMock()
    counter = {"n": alloc_start}

    def _alloc():
        counter["n"] += 1
        return counter["n"]

    b.sync_store.allocate_davmail_internal_id = _alloc
    b.inbox_uidvalidity = None
    b.sent_folder = None
    b.drafts_folder = None
    b._sync_sent = False
    b._custom_folders = list(custom_folders)
    b.arm = b
    b.radar = b
    b._cached_marker = None
    # sqlite-touching helper 全 mock (避免连真实库)
    b._max_folder_imap_uid = MagicMock(return_value=0)
    b._get_folder_uidvalidity = MagicMock(return_value=None)
    b._set_folder_uidvalidity = MagicMock()
    b._fake = FakeImap(folders, fail_select)
    return b


@contextmanager
def _fake_session(backend):
    yield backend._fake


def _patch_session(monkeypatch, backend):
    monkeypatch.setattr(
        "src.mail.backend.davmail_backend.imap_session",
        lambda cfg, timeout=60: _fake_session(backend),
    )


# ============================================================
# 🔒 隔离不变量
# ============================================================

def test_empty_sync_folders_only_selects_inbox(monkeypatch):
    """SYNC_FOLDERS 空 → 只 SELECT INBOX, 零自定义文件夹激活。"""
    folders = {"INBOX": {"uidvalidity": 1, "uids": [], "messages": {}}}
    b = _backend([], folders)
    _patch_session(monkeypatch, b)
    out = b.get_new_emails(0)
    assert b._fake.select_calls == ["INBOX"]
    assert out == []


def test_empty_custom_folders_check_for_changes_no_probe(monkeypatch):
    """空白名单时 check_for_changes 不探测任何自定义文件夹 (零 STATUS)。"""
    b = _backend([], {"INBOX": {"uidvalidity": 1, "uids": [], "messages": {}}})
    b.get_current_max_row_id = MagicMock(return_value=100)
    b._folder_status = MagicMock()
    has_new, cur, est = b.check_for_changes(100)
    b._folder_status.assert_not_called()
    assert cur == 100


# ============================================================
# 自定义文件夹取数
# ============================================================

def test_custom_folder_emails_tagged(monkeypatch):
    """自定义文件夹邮件: mailbox=label, backend_origin=davmail, imap_uidvalidity=该folder的uv。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Notion": {"uidvalidity": 7, "uids": [101, 102],
                   "messages": {101: ("a@x", "A"), 102: ("b@x", "B")}},
    }
    b = _backend(["Notion"], folders)
    _patch_session(monkeypatch, b)
    out = b.get_new_emails(0)
    notion = [e for e in out if e["mailbox"] == "Notion"]
    assert len(notion) == 2
    assert all(e["backend_origin"] == "davmail" for e in notion)
    assert all(e["imap_uidvalidity"] == 7 for e in notion)   # 该 folder 的 uv, 不是 inbox 的
    assert {e["message_id"] for e in notion} == {"a@x", "b@x"}
    # INBOX 仍最先 SELECT (主路径不被打断)
    assert b._fake.select_calls[0] == "INBOX"
    assert "Notion" in b._fake.select_calls


def test_chinese_folder_label_decoded(monkeypatch):
    """imap_name modified-UTF7 → mailbox label 解码成中文。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "DMS&VvpO9lPRXgM-": {"uidvalidity": 3, "uids": [5],
                             "messages": {5: ("c@x", "C")}},
    }
    b = _backend(["DMS&VvpO9lPRXgM-"], folders)
    _patch_session(monkeypatch, b)
    out = b.get_new_emails(0)
    assert any(e["mailbox"] == "DMS固件发布" for e in out)


def test_marker_zero_uses_since_backfill(monkeypatch):
    """首次 (marker=0) → SINCE 窗口回填 criteria。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Jira": {"uidvalidity": 1, "uids": [9], "messages": {9: ("d@x", "D")}},
    }
    b = _backend(["Jira"], folders)
    b._max_folder_imap_uid = MagicMock(return_value=0)
    _patch_session(monkeypatch, b)
    b.get_new_emails(0)
    assert b._fake.search_criteria["Jira"][0] == "SINCE"


def test_marker_positive_uses_uid_increment(monkeypatch):
    """marker>0 + uidvalidity 不变 → UID>marker 增量 criteria。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Jira": {"uidvalidity": 1, "uids": [], "messages": {}},
    }
    b = _backend(["Jira"], folders)
    b._max_folder_imap_uid = MagicMock(return_value=500)
    b._get_folder_uidvalidity = MagicMock(return_value=1)   # 与 SELECT 的 uv 一致
    _patch_session(monkeypatch, b)
    b.get_new_emails(0)
    assert b._fake.search_criteria["Jira"] == ("UID", "501:*")


def test_uidvalidity_change_triggers_full_repull(monkeypatch):
    """stored uidvalidity != 当前 → 全量重拉 (SINCE), 忽略 marker。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Jira": {"uidvalidity": 99, "uids": [], "messages": {}},
    }
    b = _backend(["Jira"], folders)
    b._max_folder_imap_uid = MagicMock(return_value=500)    # 有 marker
    b._get_folder_uidvalidity = MagicMock(return_value=1)   # 但 stored uv=1 ≠ 当前 99
    _patch_session(monkeypatch, b)
    b.get_new_emails(0)
    assert b._fake.search_criteria["Jira"][0] == "SINCE"     # 重拉, 不走 UID 增量


def test_max_messages_truncation_keeps_newest(monkeypatch):
    """search 命中超 max_messages → 只取最新 N (UID 升序末尾 N)。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Jira": {"uidvalidity": 1, "uids": [1, 2, 3, 4, 5],
                 "messages": {u: (f"m{u}@x", f"S{u}") for u in range(1, 6)}},
    }
    b = _backend(["Jira"], folders)
    b.cfg.folder_sync_max_messages = 2
    _patch_session(monkeypatch, b)
    out = b.get_new_emails(0)
    jira = [e for e in out if e["mailbox"] == "Jira"]
    assert len(jira) == 2
    assert b._fake.fetched["Jira"] == [4, 5]   # 最新 2 封


def test_single_folder_failure_isolated(monkeypatch):
    """一个文件夹 SELECT 失败 → 不影响 INBOX + 其它自定义文件夹。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Good": {"uidvalidity": 1, "uids": [11], "messages": {11: ("g@x", "G")}},
    }
    b = _backend(["Bad", "Good"], folders, fail_select={"Bad"})
    _patch_session(monkeypatch, b)
    out = b.get_new_emails(0)   # 不抛
    assert any(e["mailbox"] == "Good" for e in out)
    assert "Bad" in b._fake.select_calls and "Good" in b._fake.select_calls


def test_space_folder_name_is_quoted_in_select(monkeypatch):
    """含空格的文件夹名 (Unsent Messages) SELECT 时必须 quote (否则真实 IMAP folder not found)。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Unsent Messages": {"uidvalidity": 1, "uids": [7],
                            "messages": {7: ("u@x", "U")}},
    }
    b = _backend(["Unsent Messages"], folders)
    _patch_session(monkeypatch, b)
    out = b.get_new_emails(0)
    # 原始 select 调用参数应是 quoted
    assert '"Unsent Messages"' in b._fake.select_raw_calls
    assert any(e["mailbox"] == "Unsent Messages" for e in out)


def test_sent_folder_excluded_from_custom(monkeypatch):
    """手改 SYNC_FOLDERS 塞进 Sent → _effective_custom_folders 过滤掉, 不双拉。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Sent": {"uidvalidity": 1, "uids": [9], "messages": {9: ("s@x", "S")}},
        "Notion": {"uidvalidity": 1, "uids": [3], "messages": {3: ("n@x", "N")}},
    }
    b = _backend(["Sent", "Notion"], folders)
    b.sent_folder = "Sent"          # 探测到的发件箱名
    _patch_session(monkeypatch, b)
    out = b.get_new_emails(0)
    # Sent 被排除, 不应被 SELECT (除非作为主路径 Sent — 但本测试 _sync_sent=False)
    assert "Sent" not in b._fake.select_calls
    assert any(e["mailbox"] == "Notion" for e in out)
    assert not any(e["mailbox"] == "Sent" for e in out)


def test_uidvalidity_persisted_after_fetch(monkeypatch):
    """取数后持久化该 folder 的 UIDVALIDITY (即使无新邮件也落基线)。"""
    folders = {
        "INBOX": {"uidvalidity": 1, "uids": [], "messages": {}},
        "Notion": {"uidvalidity": 42, "uids": [], "messages": {}},
    }
    b = _backend(["Notion"], folders)
    _patch_session(monkeypatch, b)
    b.get_new_emails(0)
    b._set_folder_uidvalidity.assert_called_with("Notion", 42)


# ============================================================
# check_for_changes 自定义文件夹检测
# ============================================================

def test_check_for_changes_custom_folder_triggers_has_new(monkeypatch):
    """自定义文件夹有新 (uidnext > marker+1) → has_new=True (即便 INBOX 无变化)。"""
    b = _backend(["Notion"], {})
    b.get_current_max_row_id = MagicMock(return_value=100)   # INBOX 无新 (== last)
    b._folder_status = MagicMock(return_value=(50, 7))        # uidnext=50
    b._max_folder_imap_uid = MagicMock(return_value=10)       # marker=10 → 50>11 有新
    b._get_folder_uidvalidity = MagicMock(return_value=7)
    has_new, cur, est = b.check_for_changes(100)
    assert has_new is True
    assert est > 0


def test_check_for_changes_custom_uidvalidity_change_triggers(monkeypatch):
    """自定义文件夹 UIDVALIDITY 变化 → has_new=True (需重拉)。"""
    b = _backend(["Notion"], {})
    b.get_current_max_row_id = MagicMock(return_value=100)
    b._folder_status = MagicMock(return_value=(11, 99))       # 当前 uv=99
    b._max_folder_imap_uid = MagicMock(return_value=10)       # uidnext=11 == marker+1 → 无增量
    b._get_folder_uidvalidity = MagicMock(return_value=1)     # stored uv=1 ≠ 99
    has_new, cur, est = b.check_for_changes(100)
    assert has_new is True


def test_check_for_changes_custom_probe_failure_isolated(monkeypatch):
    """自定义文件夹 STATUS 失败 → 不抛, 不影响判定。"""
    b = _backend(["Notion"], {})
    b.get_current_max_row_id = MagicMock(return_value=100)
    b._folder_status = MagicMock(side_effect=RuntimeError("boom"))
    has_new, cur, est = b.check_for_changes(50)   # INBOX 100>50 → 本就 has_new
    assert has_new is True   # 不因 custom probe 异常崩
