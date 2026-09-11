"""``scan_history_window`` — 同步历史邮件的窗口扫描 (task 09-11), davmail + outlook_com。

钉死的不变量:

- 窗口是**半开区间** ``[since, until)``: 起点那封在内, 终点那封在外;
- 服务端只做粗筛 (IMAP 日期粒度 / DASL 分钟粒度), **精确边界在本地判** —— 粗筛放宽
  带进来的窗口外邮件必须被剔掉, 否则"范围外的不入库"就是假的;
- 返回的行**不带 internal_id** (分配与否由调用方按 Message-ID 比对后决定);
- 无 Message-ID / 重复 Message-ID 走异常通道: 计数留痕, 不混进结果;
- davmail 截断视图打断窗口 → ``complete=False`` + ``covered_from``, 绝不谎称完整;
- 收件箱失败整轮失败 (可见); 已发送失败只降级 ``complete``, 不牵连收件箱。
"""
from __future__ import annotations

import os

os.environ.setdefault("USER_EMAIL", "ci@example.test")

import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from src.mail.backend.base import FolderFetchError
from src.mail.backend.davmail_backend import DavMailBackend

from tests.mail.backend.com_fakes import FakeItem, make_backend

#: 固定 epoch 基准。🔴 有意**不是**整分钟 (BASE % 60 == 20): DASL 字面量只到分钟,
#: 下界向下取整 / 上界向上取整都会把窗口撑大, 本地精确过滤必须把多出来的切回去 ——
#: 用整分钟的基准会让这条判据平凡成立, 测不出东西。
BASE = 1_760_000_000
WINDOW = 3600


def _utc(epoch: int) -> datetime:
    return datetime.fromtimestamp(epoch, timezone.utc)


# ===========================================================================
# outlook_com
# ===========================================================================


@pytest.fixture()
def env():
    ctx = make_backend()
    yield ctx
    ctx.backend.shutdown()


def _add(folder, *, epoch: int, mid: str, subject: str = "s") -> FakeItem:
    return folder.add_item(
        FakeItem(
            received_epoch=epoch,
            message_id=mid,
            subject=subject,
            sender_email="alice@example.test",
            sender_name="Alice",
        )
    )


def _scan_com(env):
    return env.backend.scan_history_window(_utc(BASE), _utc(BASE + WINDOW))


def test_com_window_is_half_open_and_covers_both_folders(env):
    """起点那封在内、终点那封在外; 收件箱 + 已发送都扫。"""
    _add(env.store.inbox, epoch=BASE - 10, mid="<before@t>")      # 粗筛会带进来
    _add(env.store.inbox, epoch=BASE, mid="<start@t>")            # 边界: 含
    _add(env.store.sent, epoch=BASE + 1800, mid="<mid-sent@t>")
    # 🔴 落在窗口最后那不足一分钟里 (上界 BASE+3600 向下取整是 BASE+3580)。上界若跟着
    # **向下**取整, 这封在服务端就被筛掉了, 本地再怎么过滤也补不回来 —— 少了这一封,
    # ceil 与 floor 的行为完全一样, 上界取整方向就成了没人验证的装饰。
    _add(env.store.inbox, epoch=BASE + WINDOW - 10, mid="<tail@t>")
    _add(env.store.inbox, epoch=BASE + WINDOW, mid="<end@t>")     # 边界: 不含
    _add(env.store.inbox, epoch=BASE + WINDOW + 30, mid="<after@t>")

    result = _scan_com(env)

    assert sorted(r["message_id"] for r in result.items) == [
        "mid-sent@t", "start@t", "tail@t",
    ]
    assert result.complete is True


def test_com_rows_have_no_internal_id_but_keep_entry_id(env):
    """行不带 internal_id (调用方比对后才分配); entry_id 必须透传 —— 少了它历史邮件
    取正文只能靠 message_id 反查, 反查落空就永远取不到。"""
    item = _add(env.store.inbox, epoch=BASE + 60, mid="<x@t>")

    row = _scan_com(env).items[0]

    assert "internal_id" not in row
    assert row["entry_id"] == item.EntryID
    assert row["mailbox"] == "收件箱"
    assert row["backend_origin"] == "outlook_com"


def test_com_empty_message_id_counted_not_returned(env):
    _add(env.store.inbox, epoch=BASE + 60, mid="")
    _add(env.store.inbox, epoch=BASE + 61, mid="<real@t>")

    result = _scan_com(env)

    assert result.empty_msgid == 1
    assert [r["message_id"] for r in result.items] == ["real@t"]


def test_com_same_message_in_two_folders_returned_once(env):
    """自己发给自己 / 抄送自己时同一封同时在收件箱与已发送 —— 只返回一次。"""
    _add(env.store.inbox, epoch=BASE + 60, mid="<dup@t>")
    _add(env.store.sent, epoch=BASE + 60, mid="<dup@t>")

    assert len(_scan_com(env).items) == 1


def test_com_inbox_failure_raises_folder_fetch_error(env):
    """收件箱枚举失败 = 整轮失败可见, 绝不当成"这段时间没有邮件"。"""
    env.store.inbox.broken_items = RuntimeError("COM enumeration failed")

    with pytest.raises(FolderFetchError):
        _scan_com(env)


def test_com_sent_failure_keeps_inbox_but_marks_incomplete(env):
    _add(env.store.inbox, epoch=BASE + 60, mid="<inbox@t>")
    env.store.sent.broken_items = RuntimeError("boom")

    result = _scan_com(env)

    assert [r["message_id"] for r in result.items] == ["inbox@t"]
    assert result.complete is False


@pytest.fixture(params=["Asia/Shanghai", "America/Los_Angeles"])
def east_west_tz(request, monkeypatch):
    """窗口是绝对时刻, 与本机时区无关。字面量若按本地时间写, 东八区会整体偏 8 小时。"""
    monkeypatch.setenv("TZ", request.param)
    time.tzset()
    yield request.param
    monkeypatch.undo()
    time.tzset()


def test_com_window_is_utc_in_east_and_west_zones(env, east_west_tz):
    _add(env.store.inbox, epoch=BASE - 10, mid="<before@t>")
    _add(env.store.inbox, epoch=BASE + 60, mid="<in@t>")
    _add(env.store.inbox, epoch=BASE + WINDOW + 30, mid="<after@t>")

    assert [r["message_id"] for r in _scan_com(env).items] == ["in@t"]


# ===========================================================================
# davmail
# ===========================================================================


class _Imap:
    """最小 IMAP 替身: SELECT / 按序号 FETCH(INTERNALDATE) / UID SEARCH / UID FETCH。"""

    def __init__(self, folders, *, oldest=None, fail_select=(), fail_search=()):
        self.folders = folders          # name -> [(uid, msgid, date_header)]
        self.oldest = oldest or {}      # name -> datetime
        self.fail_select = set(fail_select)
        self.fail_search = set(fail_search)
        self.current = None
        self.untagged_responses = {}
        self.search_args: list[tuple] = []

    def select(self, folder, readonly=False):
        name = folder.strip('"')
        self.current = name
        if name in self.fail_select:
            return ("NO", [b"fail"])
        self.untagged_responses = {"UIDVALIDITY": [b"7"]}
        return ("OK", [b"1 EXISTS"])

    def fetch(self, seq, what):
        dt = self.oldest.get(self.current)
        if dt is None:
            return ("NO", [])
        stamp = dt.strftime("%d-%b-%Y %H:%M:%S %z")
        return ("OK", [f'1 (INTERNALDATE "{stamp}")'.encode()])

    def uid(self, cmd, *args):
        rows = self.folders.get(self.current, [])
        if cmd == "search":
            self.search_args.append(tuple(a for a in args if a is not None))
            if self.current in self.fail_search:
                return ("NO", [b"fail"])
            return ("OK", [" ".join(str(r[0]) for r in rows).encode()])
        if cmd == "fetch":
            wanted = {int(x) for x in args[0].split(",")}
            out = []
            for uid, msgid, date_header in rows:
                if uid not in wanted:
                    continue
                meta = f"1 (UID {uid} FLAGS () BODY[HEADER.FIELDS] {{50}}".encode()
                mid_line = f"Message-ID: <{msgid}>\r\n" if msgid else ""
                body = (
                    f"{mid_line}"
                    f"Subject: s\r\n"
                    f"From: alice@example.test\r\n"
                    f"Date: {date_header}\r\n\r\n"
                ).encode()
                out.append((meta, body))
            return ("OK", out)
        raise AssertionError(cmd)


def _dav_backend(imap, monkeypatch, *, sync_sent=True):
    b = DavMailBackend.__new__(DavMailBackend)
    b.cfg = MagicMock()
    b.sync_store = MagicMock()
    b.inbox_uidvalidity = None
    b._sync_sent = sync_sent
    b.sent_folder = "Sent Items"

    @contextmanager
    def _session(cfg, timeout=60):
        yield imap

    monkeypatch.setattr("src.mail.backend.davmail_backend.imap_session", _session)
    return b


#: 窗口 = 2026-08-11 全天 (UTC)。
DAV_SINCE = datetime(2026, 8, 11, tzinfo=timezone.utc)
DAV_UNTIL = datetime(2026, 8, 12, tzinfo=timezone.utc)


def _hdr(day: int, hour: int = 10) -> str:
    return f"{day:02d} Aug 2026 {hour:02d}:00:00 +0000"


def test_dav_precise_edge_is_the_displayed_date(monkeypatch):
    """服务端按日期粗筛会把前后一天带进来, 精确边界按列表里显示的日期 (Date 头) 判。"""
    imap = _Imap(
        {
            "INBOX": [
                (1, "before@t", _hdr(10)),        # 前一天: 粗筛带进来, 必须剔掉
                (2, "in@t", _hdr(11)),
                (3, "after@t", _hdr(12)),         # 后一天: 同上
            ],
            "Sent Items": [(4, "sent@t", _hdr(11, 23))],
        },
        oldest={"INBOX": DAV_SINCE - timedelta(days=30),
                "Sent Items": DAV_SINCE - timedelta(days=30)},
    )
    b = _dav_backend(imap, monkeypatch)

    result = b.scan_history_window(DAV_SINCE, DAV_UNTIL)

    assert sorted(r["message_id"] for r in result.items) == ["in@t", "sent@t"]
    assert result.complete is True


def test_dav_search_window_is_widened_by_one_day(monkeypatch):
    """粗筛必须两头各放宽一天 —— 不放宽的话, 边界那天的邮件会被日期粒度截掉,
    本地再怎么精确过滤也补不回来。"""
    imap = _Imap({"INBOX": [], "Sent Items": []},
                 oldest={"INBOX": DAV_SINCE - timedelta(days=30)})
    b = _dav_backend(imap, monkeypatch)

    b.scan_history_window(DAV_SINCE, DAV_UNTIL)

    assert imap.search_args[0] == ("SINCE", "10-Aug-2026", "BEFORE", "13-Aug-2026")


def test_dav_truncated_view_is_incomplete_with_covered_from(monkeypatch):
    """folderSizeLimit 截断视图打断窗口 → 明说只覆盖到哪天, 不谎称完整成功。"""
    oldest = datetime(2026, 8, 11, 18, 0, tzinfo=timezone.utc)
    imap = _Imap({"INBOX": [(1, "a@t", _hdr(11, 20))], "Sent Items": []},
                 oldest={"INBOX": oldest, "Sent Items": oldest})
    b = _dav_backend(imap, monkeypatch)

    result = b.scan_history_window(DAV_SINCE, DAV_UNTIL)

    assert result.complete is False
    assert result.covered_from == oldest


def test_dav_unknown_oldest_with_results_is_incomplete(monkeypatch):
    """读不到视图最老时间 → 保守按不完整 (宁可报不确定, 不谎称查全)。"""
    imap = _Imap({"INBOX": [(1, "a@t", _hdr(11))], "Sent Items": []}, oldest={})
    b = _dav_backend(imap, monkeypatch)

    assert b.scan_history_window(DAV_SINCE, DAV_UNTIL).complete is False


def test_dav_partial_parse_downgrades_to_incomplete(monkeypatch):
    """解析少项 = 恰好要补的那封可能被丢了 —— 本轮不能自称完整。"""
    imap = _Imap({"INBOX": [(1, "a@t", _hdr(11)), (2, "b@t", _hdr(11))],
                  "Sent Items": []},
                 oldest={"INBOX": DAV_SINCE - timedelta(days=30),
                         "Sent Items": DAV_SINCE - timedelta(days=30)})
    b = _dav_backend(imap, monkeypatch)
    real = b._parse_batch_headers
    b._parse_batch_headers = lambda data, uidvalidity=None: real(
        data, uidvalidity=uidvalidity
    )[:-1]

    assert b.scan_history_window(DAV_SINCE, DAV_UNTIL).complete is False


def test_dav_empty_message_id_counted_not_returned(monkeypatch):
    imap = _Imap({"INBOX": [(1, "", _hdr(11)), (2, "real@t", _hdr(11))],
                  "Sent Items": []},
                 oldest={"INBOX": DAV_SINCE - timedelta(days=30),
                         "Sent Items": DAV_SINCE - timedelta(days=30)})
    b = _dav_backend(imap, monkeypatch)

    result = b.scan_history_window(DAV_SINCE, DAV_UNTIL)

    assert result.empty_msgid == 1
    assert [r["message_id"] for r in result.items] == ["real@t"]


def test_dav_rows_carry_origin_and_mailbox_without_internal_id(monkeypatch):
    imap = _Imap({"INBOX": [(1, "a@t", _hdr(11))], "Sent Items": []},
                 oldest={"INBOX": DAV_SINCE - timedelta(days=30),
                         "Sent Items": DAV_SINCE - timedelta(days=30)})
    b = _dav_backend(imap, monkeypatch)

    row = b.scan_history_window(DAV_SINCE, DAV_UNTIL).items[0]

    assert "internal_id" not in row
    assert (row["backend_origin"], row["mailbox"]) == ("davmail", "收件箱")
    assert row["imap_uid"] == 1


def test_dav_unparseable_date_is_kept(monkeypatch):
    """读不出日期的邮件保留 —— 只补不删的语义下宁可多带一封 (Message-ID 会去重),
    不可因为日期读不出来就判它在范围外。"""
    imap = _Imap({"INBOX": [(1, "weird@t", "not-a-date")], "Sent Items": []},
                 oldest={"INBOX": DAV_SINCE - timedelta(days=30),
                         "Sent Items": DAV_SINCE - timedelta(days=30)})
    b = _dav_backend(imap, monkeypatch)

    assert [r["message_id"] for r in b.scan_history_window(DAV_SINCE, DAV_UNTIL).items] == [
        "weird@t"
    ]


def test_dav_sent_failure_keeps_inbox_but_marks_incomplete(monkeypatch):
    imap = _Imap({"INBOX": [(1, "a@t", _hdr(11))], "Sent Items": []},
                 oldest={"INBOX": DAV_SINCE - timedelta(days=30)},
                 fail_select=("Sent Items",))
    b = _dav_backend(imap, monkeypatch)

    result = b.scan_history_window(DAV_SINCE, DAV_UNTIL)

    assert [r["message_id"] for r in result.items] == ["a@t"]
    assert result.complete is False


def test_dav_inbox_select_failure_raises(monkeypatch):
    imap = _Imap({"INBOX": []}, fail_select=("INBOX",))
    b = _dav_backend(imap, monkeypatch)

    with pytest.raises(FolderFetchError):
        b.scan_history_window(DAV_SINCE, DAV_UNTIL)


def test_dav_inbox_search_failure_raises(monkeypatch):
    imap = _Imap({"INBOX": [(1, "a@t", _hdr(11))]},
                 oldest={"INBOX": DAV_SINCE - timedelta(days=30)},
                 fail_search=("INBOX",))
    b = _dav_backend(imap, monkeypatch)

    with pytest.raises(FolderFetchError):
        b.scan_history_window(DAV_SINCE, DAV_UNTIL)
