"""OutlookComBackend 单测 (task 08-12 BE1+BE2+BE3) — 全 fake COM, macOS 可跑.

覆盖面:

- import 冒烟 (🔴 平台纪律: 所有新模块 mac 上零 pywin32 可 import)
- probe / is_available
- marker 三态契约 (MarkerUnavailableError, 绝不回 0 —— task 07-14 L3)
- get_new_emails 三态契约 (FolderFetchError vs 空 []; Sent 失败不牵连 INBOX ——
  2026-08-11 丢邮件事故纪律; MailAgentWin return [] 反模式的修复断言)
- fetch ×3 (entry_id 快路径 / message_id 反查自愈回写 / update_uid=False)
- 写面 (mark_read / set_flag ×2 + append_draft + send_email)
- fail-soft: #58 入向已读回收 / 收件箱对账 / 草稿同步的 hasattr 门 (BE3)
- com_client 基建 (HRESULT 分类 / 忙态退避 / 死对象 reconnect / call_with_timeout /
  STA 线程固定 / DASL 日期字面量)
- conversation_index 纯算法
"""
import os

os.environ.setdefault("USER_EMAIL", "ci@example.test")

import sys
import threading
import time
from datetime import datetime
from types import SimpleNamespace

import pytest

from src.mail.backend.base import (
    FolderFetchError,
    IMailBackend,
    MarkerUnavailableError,
)
from src.mail.backend.types import DraftRequest

from tests.mail.backend.com_fakes import (
    FakeCfg,
    FakeItem,
    FakeOutlookStore,
    FakeSyncStore,
    make_backend,
)

BASE = 1_760_000_000  # 固定 epoch 基准 (确定性; 远早于 time.time() 无所谓)


@pytest.fixture()
def env():
    ctx = make_backend()
    yield ctx
    ctx.backend.shutdown()


def _inbox_item(store: FakeOutlookStore, *, epoch: int, mid: str = "", **kw) -> FakeItem:
    item = FakeItem(
        received_epoch=epoch,
        message_id=mid or f"<m-{epoch}@example.test>",
        subject=kw.pop("subject", f"mail@{epoch}"),
        sender_email=kw.pop("sender_email", "alice@example.test"),
        sender_name=kw.pop("sender_name", "Alice"),
        **kw,
    )
    return store.inbox.add_item(item)


# ---------------------------------------------------------------------------
# import 冒烟 (硬约束: mac 上零 pywin32 可 import)
# ---------------------------------------------------------------------------


def test_all_new_modules_importable_without_pywin32():
    import src.mail.backend.com_client  # noqa: F401
    import src.mail.backend.com_folder_reader  # noqa: F401
    import src.mail.backend.conversation_index  # noqa: F401
    import src.mail.backend.outlook_com_backend  # noqa: F401
    import src.mail.backend.outlook_mime  # noqa: F401

    # 平台纪律: import 本身绝不触发 pywin32 (本机 macOS 根本没有)
    assert "win32com" not in sys.modules
    assert "pythoncom" not in sys.modules


# ---------------------------------------------------------------------------
# probe / is_available
# ---------------------------------------------------------------------------


def test_probe_readiness_success_records_folder_names(env):
    ok, detail = env.backend.probe_readiness()
    assert ok is True
    assert "classic Outlook" in detail
    # 协议外属性 (mail_write getattr 消费, 镜像 davmail probe 语义)
    assert env.backend.sent_folder == "Sent Items"
    assert env.backend.drafts_folder == "Drafts"


def test_probe_readiness_failure_mentions_classic_outlook():
    from src.mail.backend.outlook_com_backend import OutlookComBackend

    def boom(prog_id):
        raise RuntimeError("Dispatch failed: no COM server")

    backend = OutlookComBackend(
        FakeCfg(), sync_store=FakeSyncStore(), dispatch_factory=boom,
    )
    try:
        ok, detail = backend.probe_readiness()
        assert ok is False
        assert "classic Outlook" in detail
        assert "Programmatic Access" in detail
    finally:
        backend.shutdown()


def test_is_available_true_and_false(env):
    assert env.backend.is_available() is True
    # 会话断掉: 重连 Dispatch 也失败 → False (不抛)
    env.backend._session._app = None
    env.backend._session._ns = None
    env.backend._session._dispatch_factory = lambda p: (_ for _ in ()).throw(
        RuntimeError("outlook gone")
    )
    assert env.backend.is_available() is False


# ---------------------------------------------------------------------------
# marker (ReceivedTime 水位) — 三态契约
# ---------------------------------------------------------------------------


def test_marker_is_newest_inbox_received_time(env):
    _inbox_item(env.store, epoch=BASE + 10)
    _inbox_item(env.store, epoch=BASE + 99)
    _inbox_item(env.store, epoch=BASE + 50)
    assert env.backend.get_current_max_row_id() == BASE + 99


def test_marker_empty_inbox_returns_now_not_zero(env):
    # 🔴 空收件箱是合法状态 → 返回当前时间 (恒正), 绝不 0 (0 会被持久化成 baseline)
    marker = env.backend.get_current_max_row_id()
    assert abs(marker - int(time.time())) < 10
    assert marker > 0


def test_marker_failure_raises_marker_unavailable_never_zero(env):
    env.store.inbox.broken_items = RuntimeError("MAPI store offline")
    with pytest.raises(MarkerUnavailableError):
        env.backend.get_current_max_row_id()


def test_marker_unreadable_received_time_raises(env):
    item = _inbox_item(env.store, epoch=BASE + 10)
    item.ReceivedTime = object()  # timestamp() 不存在 → _to_epoch None
    with pytest.raises(MarkerUnavailableError):
        env.backend.get_current_max_row_id()


def test_marker_memory_cache_roundtrip(env):
    assert env.backend.get_last_max_row_id() == 0
    env.backend.set_last_max_row_id(BASE + 7)
    assert env.backend.get_last_max_row_id() == BASE + 7
    env.backend.set_last_max_row_id(0)
    assert env.backend.get_last_max_row_id() == 0


# ---------------------------------------------------------------------------
# check_for_changes
# ---------------------------------------------------------------------------


def test_check_for_changes_no_baseline_reports_no_new(env):
    _inbox_item(env.store, epoch=BASE + 10)
    has_new, current, est = env.backend.check_for_changes(0)
    assert has_new is False
    assert current == BASE + 10
    assert est == 0


def test_check_for_changes_counts_since_watermark(env):
    _inbox_item(env.store, epoch=BASE + 10)
    _inbox_item(env.store, epoch=BASE + 20)
    _inbox_item(env.store, epoch=BASE + 30)
    has_new, current, est = env.backend.check_for_changes(BASE + 15)
    assert has_new is True
    assert current == BASE + 30
    # >= 语义 (同秒多封不丢): BASE+20 / BASE+30 两封在窗口内
    assert est == 2


def test_check_for_changes_failure_raises_marker_unavailable(env):
    env.store.inbox.broken_items = RuntimeError("store gone")
    with pytest.raises(MarkerUnavailableError):
        env.backend.check_for_changes(BASE)


# ---------------------------------------------------------------------------
# get_new_emails — 三态契约 (2026-08-11 丢邮件事故纪律)
# ---------------------------------------------------------------------------


def test_get_new_emails_without_watermark_returns_empty(env):
    _inbox_item(env.store, epoch=BASE + 10)
    assert env.backend.get_new_emails(0) == []


def test_get_new_emails_row_shape_and_internal_id_allocation(env):
    headers = (
        "Received: from relay.example.test\r\n"
        "References: <root@example.test> <mid@example.test>\r\n"
        "In-Reply-To: <mid@example.test>\r\n"
    )
    _inbox_item(
        env.store, epoch=BASE + 10, mid="<new-1@example.test>",
        subject="你好 Outlook", transport_headers=headers, unread=True,
    )
    env.store.sent.add_item(
        FakeItem(
            received_epoch=BASE + 20,
            message_id="<sent-1@example.test>",
            subject="sent copy",
            sender_email="ci@example.test",
        )
    )
    rows = env.backend.get_new_emails(BASE)
    assert len(rows) == 2
    inbox_row = next(r for r in rows if r["mailbox"] == "收件箱")
    sent_row = next(r for r in rows if r["mailbox"] == "发件箱")

    assert inbox_row["message_id"] == "new-1@example.test"  # 归一化去尖括号
    assert inbox_row["backend_origin"] == "outlook_com"
    assert inbox_row["subject"] == "你好 Outlook"
    assert inbox_row["sender"] == "alice@example.test"
    assert inbox_row["is_read"] is False
    assert inbox_row["entry_id"]  # v53 快路径缓存
    assert inbox_row["thread_id"] == "root@example.test"  # References 首个
    assert inbox_row["in_reply_to_raw"] == "mid@example.test"
    assert inbox_row["date_received"]

    # internal_id: allocate_davmail_internal_id 同一序列, >= 10^9 且逐封递增
    ids = sorted(r["internal_id"] for r in rows)
    assert ids[0] >= 1_000_000_000
    assert ids[1] == ids[0] + 1
    assert sent_row["internal_id"] in ids


def test_get_new_emails_skips_non_mail_items(env):
    _inbox_item(env.store, epoch=BASE + 10)
    env.store.inbox.add_item(
        FakeItem(received_epoch=BASE + 20, item_class=26, subject="meeting response")
    )
    rows = env.backend.get_new_emails(BASE)
    assert len(rows) == 1
    assert rows[0]["subject"] == f"mail@{BASE + 10}"


def test_get_new_emails_inbox_failure_raises_folder_fetch_error(env):
    # 🔴 绝不 return [] 吞错 — 吞错 = 游标推进 = 窗口内邮件永久静默丢失
    env.store.inbox.broken_items = RuntimeError("enumeration blew up")
    with pytest.raises(FolderFetchError):
        env.backend.get_new_emails(BASE)


def test_get_new_emails_sent_failure_does_not_break_inbox(env):
    _inbox_item(env.store, epoch=BASE + 10)
    env.store.sent.broken_items = RuntimeError("sent folder offline")
    rows = env.backend.get_new_emails(BASE)  # 不抛
    assert len(rows) == 1
    assert rows[0]["mailbox"] == "收件箱"


def test_get_new_emails_allocate_failure_raises_folder_fetch_error(env):
    _inbox_item(env.store, epoch=BASE + 10)
    env.sync_store.alloc_fail = True
    with pytest.raises(FolderFetchError, match="allocate_davmail_internal_id"):
        env.backend.get_new_emails(BASE)


def test_get_new_emails_max_batch_caps_oldest_first(env):
    # ascending 扫描: 截断留最新的下轮 (marker 只推进到已抓最后一封, 不跳过)
    _inbox_item(env.store, epoch=BASE + 10, subject="older")
    _inbox_item(env.store, epoch=BASE + 20, subject="newer")
    env.backend.MAX_BATCH = 1
    rows = env.backend.get_new_emails(BASE)
    assert len(rows) == 1
    assert rows[0]["subject"] == "older"


# ---------------------------------------------------------------------------
# fetch ×3 — entry_id 快路径 + message_id 反查自愈
# ---------------------------------------------------------------------------


def _record_heals(backend):
    calls = []
    backend._update_entry_id = lambda iid, eid: calls.append((iid, eid))
    return calls


def test_fetch_content_by_id_entry_id_fast_path(env):
    item = _inbox_item(
        env.store, epoch=BASE + 10, mid="<f1@example.test>",
        subject="fetch me", html_body="<html><body>Hello 正文</body></html>",
        text_body="Hello 正文",
    )
    row = env.sync_store.add_row(
        1_000_000_001, message_id="f1@example.test", entry_id=item.EntryID,
    )
    heals = _record_heals(env.backend)
    result = env.backend.fetch_email_content_by_id(row["internal_id"])
    assert result is not None
    assert result["message_id"] == "f1@example.test"
    assert result["subject"] == "fetch me"
    assert "Hello 正文" in result["content"]
    assert "Message-ID" in result["source"]  # 重组 MIME 已就位
    assert heals == []  # 快路径命中不回写


def test_fetch_content_by_id_message_id_heal_writes_back(env):
    item = _inbox_item(env.store, epoch=BASE + 10, mid="<f2@example.test>")
    row = env.sync_store.add_row(
        1_000_000_002, message_id="f2@example.test", entry_id="STALE-ENTRY-ID",
    )
    heals = _record_heals(env.backend)
    result = env.backend.fetch_email_content_by_id(row["internal_id"])
    assert result is not None
    assert heals == [(1_000_000_002, item.EntryID)]  # 反查命中 → entry_id 自愈回写


def test_fetch_content_by_id_update_uid_false_skips_heal(env):
    _inbox_item(env.store, epoch=BASE + 10, mid="<f3@example.test>")
    row = env.sync_store.add_row(1_000_000_003, message_id="f3@example.test")
    heals = _record_heals(env.backend)
    result = env.backend.fetch_email_content_by_id(row["internal_id"], update_uid=False)
    assert result is not None
    assert heals == []


def test_fetch_content_by_id_unknown_record_returns_none(env):
    assert env.backend.fetch_email_content_by_id(999_999) is None


def test_fetch_content_by_id_item_gone_returns_none(env):
    row = env.sync_store.add_row(
        1_000_000_004, message_id="ghost@example.test", entry_id="GONE",
    )
    assert env.backend.fetch_email_content_by_id(row["internal_id"]) is None


def test_fetch_by_message_id_found_and_missing(env):
    _inbox_item(env.store, epoch=BASE + 10, mid="<byid@example.test>")
    env.sync_store.add_row(1_000_000_005, message_id="byid@example.test")
    result = env.backend.fetch_email_by_message_id("byid@example.test")
    assert result is not None
    assert result["message_id"] == "byid@example.test"
    assert env.backend.fetch_email_by_message_id("nope@example.test") is None
    assert env.backend.fetch_email_by_message_id("") is None


def test_fetch_emails_by_position_latest_first(env):
    for offset in (10, 30, 20):
        _inbox_item(env.store, epoch=BASE + offset, mid=f"<pos-{offset}@example.test>")
    rows = env.backend.fetch_emails_by_position(2)
    assert [r["message_id"] for r in rows] == [
        "pos-30@example.test", "pos-20@example.test",
    ]
    assert all("subject" in r and "id" in r for r in rows)


# ---------------------------------------------------------------------------
# 写面: mark_read / set_flag
# ---------------------------------------------------------------------------


def test_mark_as_read_by_id_sets_unread_and_saves(env):
    item = _inbox_item(env.store, epoch=BASE + 10, mid="<r1@example.test>", unread=True)
    row = env.sync_store.add_row(
        1_000_000_010, message_id="r1@example.test", entry_id=item.EntryID,
    )
    assert env.backend.mark_as_read_by_id(row["internal_id"], read=True) is True
    assert item.UnRead is False
    assert item.saved == 1
    # 反向 (标未读) — MailAgentWin 原码只有单向, 这里补齐的协议语义
    assert env.backend.mark_as_read_by_id(row["internal_id"], read=False) is True
    assert item.UnRead is True


def test_mark_as_read_by_id_unknown_record_false(env):
    assert env.backend.mark_as_read_by_id(42) is False


def test_mark_as_read_by_id_heals_entry_id_on_msgid_fallback(env):
    item = _inbox_item(env.store, epoch=BASE + 10, mid="<r2@example.test>", unread=True)
    row = env.sync_store.add_row(
        1_000_000_011, message_id="r2@example.test", entry_id="STALE",
    )
    heals = _record_heals(env.backend)
    assert env.backend.mark_as_read_by_id(row["internal_id"]) is True
    assert heals == [(1_000_000_011, item.EntryID)]


def test_set_flag_by_id_marks_and_clears_task(env):
    item = _inbox_item(env.store, epoch=BASE + 10, mid="<fl@example.test>")
    row = env.sync_store.add_row(
        1_000_000_012, message_id="fl@example.test", entry_id=item.EntryID,
    )
    assert env.backend.set_flag_by_id(row["internal_id"], True) is True
    assert item.mark_as_task_calls  # MarkAsTask(OL_MARK_NO_DATE)
    assert item.saved == 1
    assert env.backend.set_flag_by_id(row["internal_id"], False) is True
    assert item.clear_task_calls == 1


def test_set_flag_falls_back_to_flag_status_when_no_mark_as_task(env):
    class LegacyItem(FakeItem):
        def MarkAsTask(self, interval):  # 老对象模型: 方法不存在/抛错
            raise AttributeError("MarkAsTask not supported")

    item = LegacyItem(received_epoch=BASE + 10, message_id="<legacy@example.test>")
    env.store.inbox.add_item(item)
    row = env.sync_store.add_row(
        1_000_000_013, message_id="legacy@example.test", entry_id=item.EntryID,
    )
    assert env.backend.set_flag_by_id(row["internal_id"], True) is True
    assert item.FlagStatus == 2  # olFlagMarked 兜底


def test_mark_read_and_set_flag_by_message_id_fallback_paths(env):
    item = _inbox_item(env.store, epoch=BASE + 10, mid="<mid-fb@example.test>", unread=True)
    assert env.backend.mark_as_read("mid-fb@example.test") is True
    assert item.UnRead is False
    assert env.backend.set_flag("mid-fb@example.test", True) is True
    assert item.FlagStatus == 2
    assert env.backend.mark_as_read("missing@example.test") is False
    assert env.backend.set_flag("missing@example.test", True) is False
    assert env.backend.mark_as_read("") is False


# ---------------------------------------------------------------------------
# 写面: append_draft / send_email
# ---------------------------------------------------------------------------


def test_append_draft_new_mode(env):
    draft = DraftRequest(
        mode="new",
        to=["bob@example.test", "carol@example.test"],
        cc=["dave@example.test"],
        subject="新建草稿",
        reply_html="<html><body>draft body</body></html>",
        importance="high",
        attachments=[("附件.txt", b"attachment-bytes", "text/plain")],
    )
    result = env.backend.append_draft(draft)
    assert result.success is True
    assert result.method == "outlook_com"
    assert result.appended_uid is None  # IMAP 概念, COM 恒 None
    assert result.message_id and result.message_id.startswith("draft-")
    assert getattr(result, "entry_id", None)  # 动态属性带回 (compose_draft 消费)

    item = env.app.created_items[-1]
    assert item.To == "bob@example.test; carol@example.test"
    assert item.CC == "dave@example.test"
    assert item.Subject == "新建草稿"
    assert item.Importance == 2  # high
    assert item.saved == 1
    assert len(item.Attachments.added_paths) == 1
    # 附件临时文件 Save 后已清理
    assert not os.path.exists(item.Attachments.added_paths[0])


def test_append_draft_reply_mode_derives_from_original(env):
    orig = _inbox_item(
        env.store, epoch=BASE + 10, mid="<orig@example.test>",
        subject="original", sender_email="alice@example.test",
    )
    row = env.sync_store.add_row(
        1_000_000_020, message_id="orig@example.test", entry_id=orig.EntryID,
    )
    created: list[FakeItem] = []
    orig_reply = orig.Reply

    def tracking_reply():
        item = orig_reply()
        created.append(item)
        return item

    orig.Reply = tracking_reply
    draft = DraftRequest(
        mode="reply",
        internal_id_for_threading=row["internal_id"],
        reply_html="<p>my answer</p>",
        reply_text="my answer",
    )
    result = env.backend.append_draft(draft)
    assert result.success is True
    assert len(created) == 1  # Reply() 派生 (线程头由 Outlook 接对)
    reply_item = created[0]
    assert reply_item.saved == 1
    assert reply_item.Subject == "RE: original"
    # 用户正文 prepend 在 Outlook 自动引用块之前
    assert reply_item.HTMLBody.startswith("<p>my answer</p>")
    assert "quoted: original" in reply_item.HTMLBody
    assert getattr(result, "entry_id", None) == reply_item.EntryID


def test_append_draft_reply_requires_threading_id(env):
    result = env.backend.append_draft(DraftRequest(mode="reply", reply_text="x"))
    assert result.success is False
    assert "internal_id_for_threading" in (result.error or "")


def test_append_draft_reply_unknown_record_fails(env):
    result = env.backend.append_draft(
        DraftRequest(mode="reply", internal_id_for_threading=777, reply_text="x")
    )
    assert result.success is False
    assert "不在 sync_store" in (result.error or "")


def test_append_draft_save_timeout_returns_failure(env):
    class SlowSaveApp:
        def __init__(self, inner):
            self._inner = inner

        def GetNamespace(self, name):
            return self._inner.GetNamespace(name)

        def CreateItem(self, kind):
            item = self._inner.CreateItem(kind)

            def slow_save():
                time.sleep(1.0)

            item.Save = slow_save
            return item

    env.backend._session._dispatch_factory = lambda p: SlowSaveApp(env.app)
    env.backend._session._app = None
    env.backend._session._ns = None
    env.backend._publish_timeout = 0.05
    result = env.backend.append_draft(DraftRequest(mode="new", to=["x@example.test"]))
    assert result.success is False
    assert "超时或失败" in (result.error or "")


def test_send_email_success_and_failure(env):
    draft = DraftRequest(mode="new", to=["bob@example.test"], subject="发送", reply_text="hi")
    result = env.backend.send_email(draft)
    assert result.success is True
    assert result.method == "outlook_com"
    assert env.app.created_items[-1].sent == 1

    class FailSendApp:
        def __init__(self, inner):
            self._inner = inner

        def GetNamespace(self, name):
            return self._inner.GetNamespace(name)

        def CreateItem(self, kind):
            item = self._inner.CreateItem(kind)

            def bad_send():
                raise RuntimeError("send blew up")

            item.Send = bad_send
            return item

    env.backend._session._dispatch_factory = lambda p: FailSendApp(env.app)
    env.backend._session._app = None
    env.backend._session._ns = None
    result2 = env.backend.send_email(draft)
    assert result2.success is False
    assert result2.error


def test_send_email_reply_uses_original_item(env):
    orig = _inbox_item(env.store, epoch=BASE + 10, mid="<sr@example.test>")
    row = env.sync_store.add_row(
        1_000_000_021, message_id="sr@example.test", entry_id=orig.EntryID,
    )
    replies_sent: list[FakeItem] = []
    orig_reply = orig.Reply

    def tracking_reply():
        item = orig_reply()
        replies_sent.append(item)
        return item

    orig.Reply = tracking_reply
    result = env.backend.send_email(
        DraftRequest(
            mode="reply", internal_id_for_threading=row["internal_id"],
            reply_text="回复正文",
        )
    )
    assert result.success is True
    assert len(replies_sent) == 1
    assert replies_sent[0].sent == 1
    assert replies_sent[0].Body.startswith("回复正文")


# ---------------------------------------------------------------------------
# BE3: fail-soft 白名单 (hasattr 门自动不激活) + 协议姿态
# ---------------------------------------------------------------------------


def test_fail_soft_optional_capabilities_absent(env):
    """🔴 v2 白名单: 不实现即 new_watcher hasattr 门自动不激活对应功能.

    - search_inbox_unseen / fetch_inbox_seen_flags → #58 入向已读回收不激活
      (CLAUDE.md: 缺 fetch_inbox_seen_flags 即整段不激活 — 没判据就不许猜)
    - reconcile_inbox → 收件箱对账兜底不激活
    - reconcile_drafts → DRAFTS_SYNC watcher 分支不激活 (new_watcher hasattr 守卫)
    """
    for name in (
        "search_inbox_unseen",
        "fetch_inbox_seen_flags",
        "reconcile_inbox",
        "reconcile_drafts",
    ):
        assert not hasattr(env.backend, name), (
            f"{name} 出现在 OutlookComBackend 上 — 会打穿 new_watcher 的 "
            "hasattr fail-soft 门 (v1 有意不实现, 见类 docstring)"
        )


def test_protocol_posture_and_capability_markers(env):
    # reconcile_drafts 有意缺席 → runtime_checkable isinstance 为 False (documented)
    assert not isinstance(env.backend, IMailBackend)
    assert env.backend.backend_origin == "outlook_com"
    # mail_write 能力判定闸消费 (isinstance(DavMailBackend) 之外的第二分支)
    assert env.backend.supports_folder_ops is True
    # 协议方法面 (17 - reconcile_drafts) 全部在场
    for name in (
        "probe_readiness", "is_available", "get_current_max_row_id",
        "check_for_changes", "get_new_emails", "set_last_max_row_id",
        "get_last_max_row_id", "fetch_email_content_by_id",
        "fetch_email_by_message_id", "fetch_emails_by_position",
        "mark_as_read_by_id", "set_flag_by_id", "mark_as_read", "set_flag",
        "append_draft", "send_email",
    ):
        assert callable(getattr(env.backend, name)), name


# ---------------------------------------------------------------------------
# com_client 基建
# ---------------------------------------------------------------------------


class _ComError(Exception):
    def __init__(self, hresult):
        super().__init__(f"com error {hresult}")
        self.hresult = hresult


def test_extract_hresult_variants():
    from src.mail.backend.com_client import extract_hresult

    assert extract_hresult(_ComError(-2147418111)) == -2147418111
    e = Exception(-2147023170, "RPC_S_CALL_FAILED")
    assert extract_hresult(e) == -2147023170
    assert extract_hresult(RuntimeError("plain")) is None


def test_session_busy_retry_then_success():
    from src.mail.backend.com_client import OutlookSession

    session = OutlookSession(lambda p: object())
    attempts = {"n": 0}

    def flaky(s):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise _ComError(-2147418111)  # RPC_E_CALL_REJECTED (busy)
        return "ok"

    assert session.call(flaky, base_delay=0.01) == "ok"
    assert attempts["n"] == 3


def test_session_dead_object_triggers_reconnect():
    from src.mail.backend.com_client import OutlookSession

    dispatches = {"n": 0}

    class App:
        def GetNamespace(self, name):
            return object()

    def factory(prog_id):
        dispatches["n"] += 1
        return App()

    session = OutlookSession(factory)
    _ = session.namespace  # 首连
    assert dispatches["n"] == 1
    state = {"first": True}

    def dies_once(s):
        if state["first"]:
            state["first"] = False
            raise _ComError(-2147417848)  # RPC_E_DISCONNECTED
        return "recovered"

    assert session.call(dies_once, base_delay=0.01) == "recovered"
    assert dispatches["n"] == 2  # reconnect 重建了 Application


def test_session_non_busy_error_raises_immediately():
    from src.mail.backend.com_client import OutlookSession

    session = OutlookSession(lambda p: object())
    attempts = {"n": 0}

    def hard_fail(s):
        attempts["n"] += 1
        raise ValueError("logic bug")

    with pytest.raises(ValueError):
        session.call(hard_fail, base_delay=0.01)
    assert attempts["n"] == 1  # 非白名单错误不烧重试预算


def test_call_with_timeout_success_failure_timeout():
    from src.mail.backend.com_client import call_with_timeout

    class Item:
        def __init__(self):
            self.done = 0

    item = Item()
    assert call_with_timeout(item, lambda t: setattr(t, "done", 1), timeout_sec=1.0)
    assert item.done == 1

    def boom(t):
        raise RuntimeError("failed inside worker")

    assert call_with_timeout(item, boom, timeout_sec=1.0) is False

    t0 = time.time()
    assert call_with_timeout(item, lambda t: time.sleep(1.5), timeout_sec=0.05) is False
    assert time.time() - t0 < 1.0  # 放弃等待, 不陪跑到底


def test_sta_executor_pins_single_thread_and_reentrant():
    from src.mail.backend.com_client import StaComExecutor

    sta = StaComExecutor()
    try:
        ids = {sta.run(threading.get_ident) for _ in range(5)}
        assert len(ids) == 1  # 所有调用固定同一 STA 线程
        assert ids.pop() != threading.get_ident()

        # 工作线程内互调不自死锁 (run 检测当前线程直接执行)
        def nested():
            return sta.run(lambda: "inner")

        assert sta.run(nested) == "inner"
    finally:
        sta.shutdown()


def test_epoch_to_dasl_local_roundtrip():
    from src.mail.backend.com_client import epoch_to_dasl_local

    epoch = 1_760_012_345
    literal = epoch_to_dasl_local(epoch)
    parsed = datetime.strptime(literal, "%Y-%m-%d %H:%M:%S")
    assert int(parsed.timestamp()) == epoch  # 本地时区往返无损


def test_start_progress_window_hider_noop_on_mac():
    from src.mail.backend.com_client import start_progress_window_hider

    start_progress_window_hider(0.01)  # win32gui 缺失 → 静默 no-op 不抛


# ---------------------------------------------------------------------------
# conversation_index 纯算法
# ---------------------------------------------------------------------------


def test_conversation_index_parse_contract():
    from src.mail.backend.conversation_index import parse

    root = "01" * 22  # 44 hex = 22 字节头
    parsed = parse(root)
    assert parsed is not None
    assert parsed.depth == 0
    assert parsed.root == root.upper()
    assert parsed.parent_index is None

    child = root + "ab" * 5  # +5 字节 = 一层回复
    parsed_child = parse(child)
    assert parsed_child.depth == 1
    assert parsed_child.root == root.upper()
    assert parsed_child.parent_index == root.upper()

    grand = child + "cd" * 5
    parsed_grand = parse(grand)
    assert parsed_grand.depth == 2
    assert parsed_grand.parent_index == child.upper()


def test_conversation_index_rejects_garbage():
    from src.mail.backend.conversation_index import parse

    assert parse(None) is None
    assert parse("") is None
    assert parse("abc") is None  # 短于 22 字节头
    assert parse("zz" * 22) is None  # 非 hex


def test_conversation_index_truncates_ragged_tail():
    from src.mail.backend.conversation_index import parse

    root = "0a" * 22
    ragged = root + "ff" * 5 + "123"  # 尾巴不是 10-hex 整倍
    parsed = parse(ragged)
    assert parsed is not None
    assert parsed.depth == 1  # 残块截断, 不算一层
    assert parsed.raw == root.upper() + "FF" * 5


# ---------------------------------------------------------------------------
# factory 三值化: 非 win32 平台选 outlook_com 必须清晰报错 (不是 ImportError 噪音)
# ---------------------------------------------------------------------------


def test_factory_outlook_com_rejected_on_non_win32():
    import sys

    from src.mail.backend.base import BackendStartupError
    from src.mail.backend.factory import create_backend

    assert sys.platform != "win32"  # 本套件跑在 macOS/CI linux
    cfg = SimpleNamespace(mailagent_backend="outlook_com")
    with pytest.raises(BackendStartupError) as ei:
        create_backend(cfg, sync_store=FakeSyncStore())
    assert "win" in str(ei.value).lower()  # 错误信息明示平台约束


def test_factory_unknown_backend_value_error():
    from src.mail.backend.factory import create_backend

    with pytest.raises(ValueError):
        create_backend(SimpleNamespace(mailagent_backend="gmail_api"))
