"""单测: island_dispatch.dispatch_daily_digest — DailyDigest envelope 构造.

断言:
- wire eventType = Notification (内部 event_type=DailyDigest 透传 metadata.eventType)
- scenario = DailyDigest
- metadata 带 digestBulk.<id>.ids 命名空间 + digestUnread/digestUrgent/digestHeadline/aiSummary
- options 数 = confirmed_actions 数; status_kind = waitingForInput when options
- title 里数字 = len(internal_ids) (risk 表第 1 条: 防 LLM 写错数量)
- 无 confirmed_actions → status_kind=notification + expects_response=False + intervention None
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

import pytest

from src.notify import island_dispatch, ping_island
from src.notify.island_dispatch import DigestBulkAction


class _FakeSyncStore:
    def __init__(self):
        self.rows: List[Dict[str, Any]] = []

    def record_island_dispatch(self, **kwargs):
        self.rows.append(kwargs)
        return len(self.rows)


@pytest.fixture
def fake_store():
    return _FakeSyncStore()


@pytest.fixture
def patch_send(monkeypatch):
    captured: List[Any] = []

    async def fake_send_async(envelope, **kwargs):
        captured.append(envelope)
        return ping_island.SendResult(ok=True, response=None, latency_ms=5)

    monkeypatch.setattr(ping_island, "send_async", fake_send_async)
    monkeypatch.setattr(island_dispatch.ping_island, "send_async", fake_send_async)
    # 问题 A 去重模块级 dict — 跨 test 复用 digest_date session_key 会互挡, 清空保隔离。
    island_dispatch._dedup_seen.clear()
    return captured


def _dispatch(actions, **kw):
    """跑 dispatch_daily_digest 于一个事件循环里 (内部 _fire 需要 running loop)。"""

    async def _run():
        island_dispatch.dispatch_daily_digest(
            digest_date=kw.get("digest_date", "20260526"),
            headline=kw.get("headline", "3封紧急待回复"),
            summary_md=kw.get("summary_md", "今天有 **3** 封紧急邮件。"),
            unread=kw.get("unread", 12),
            urgent=kw.get("urgent", 3),
            confirmed_actions=actions,
            max_bulk_ids=kw.get("max_bulk_ids", 30),
        )
        # 让 fire-and-forget 的 _bg task 跑完
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    asyncio.run(_run())


def test_disabled_dispatcher_is_noop(patch_send, fake_store):
    island_dispatch.init(enabled=False, sync_store=fake_store)
    _dispatch([DigestBulkAction(id="bulk_mark_read", title="标记 5 封已读", internal_ids=[1, 2])])
    assert patch_send == []


def test_envelope_wire_event_and_scenario(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)
    _dispatch(
        [DigestBulkAction(
            id="bulk_archive_newsletter", title="归档 3 封", internal_ids=[53675, 53680, 53681],
        )]
    )
    assert len(patch_send) == 1
    env = patch_send[0]
    assert env.event_type == "DailyDigest"
    body = env.to_wire_dict()
    # wire 层翻成 Notification, 原名透传 metadata
    assert body["eventType"] == "Notification"
    assert body["metadata"]["mailagent.eventType"] == "DailyDigest"
    assert body["metadata"]["mailagent.scenario"] == "DailyDigest"
    # session_key 按天
    assert env.session_key == "mailagent:daily_digest:20260526"


def test_metadata_carries_counts_and_bulk_ids(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)
    _dispatch(
        [
            DigestBulkAction(
                id="bulk_archive_newsletter", title="归档 2 封", internal_ids=[53675, 53680],
            ),
            DigestBulkAction(
                id="bulk_mark_read", title="标记 1 封已读", internal_ids=[53710],
            ),
        ],
        unread=12,
        urgent=3,
        headline="HL",
        summary_md="SM",
    )
    meta = patch_send[0].metadata
    assert meta["mailagent.digestUnread"] == "12"
    assert meta["mailagent.digestUrgent"] == "3"
    assert meta["mailagent.digestHeadline"] == "HL"
    assert meta["mailagent.aiSummary"] == "SM"
    assert meta["mailagent.digestDate"] == "20260526"
    # ids 走 metadata 命名空间, 逗号分隔
    assert meta["mailagent.digestBulk.bulk_archive_newsletter.ids"] == "53675,53680"
    assert meta["mailagent.digestBulk.bulk_mark_read.ids"] == "53710"


def test_options_count_and_status_kind(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)
    _dispatch(
        [
            DigestBulkAction(id="bulk_archive_newsletter", title="归档 1 封", internal_ids=[1]),
            DigestBulkAction(id="bulk_mark_read", title="标记 1 封已读", internal_ids=[2]),
        ]
    )
    env = patch_send[0]
    assert env.status_kind == "waitingForInput"
    assert env.expects_response is True
    assert env.intervention is not None
    # 问题 B: 2 业务 bulk + skip (≤3, fork prefix(3))
    assert len(env.intervention.options) == 3
    ids = [o.id for o in env.intervention.options]
    assert ids == ["bulk_archive_newsletter", "bulk_mark_read", "skip"]


def test_title_number_forced_to_len_ids(patch_send, fake_store):
    """risk 表第 1 条: LLM 写"归档 8 封"但代码只给 3 个 id → title 强制改 3。"""
    island_dispatch.init(enabled=True, sync_store=fake_store)
    _dispatch(
        [DigestBulkAction(
            id="bulk_archive_newsletter", title="归档 8 封 newsletter",
            internal_ids=[53675, 53680, 53681],
        )]
    )
    opt = patch_send[0].intervention.options[0]
    assert opt.title == "归档 3 封 newsletter"
    # ids 也只 3 个
    assert patch_send[0].metadata[
        "mailagent.digestBulk.bulk_archive_newsletter.ids"
    ] == "53675,53680,53681"


def test_max_bulk_ids_caps_metadata_list(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)
    many = list(range(1, 40))  # 39 ids
    _dispatch(
        [DigestBulkAction(id="bulk_mark_read", title="标记 39 封已读", internal_ids=many)],
        max_bulk_ids=5,
    )
    ids_str = patch_send[0].metadata["mailagent.digestBulk.bulk_mark_read.ids"]
    assert ids_str == "1,2,3,4,5"
    # title 数字校准到 capped len (5)，不是 LLM 写的 39
    assert patch_send[0].intervention.options[0].title == "标记 5 封已读"


def test_no_actions_is_pure_notification(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)
    _dispatch([], unread=5, urgent=0, headline="纯告知")
    env = patch_send[0]
    assert env.status_kind == "notification"
    assert env.expects_response is False
    assert env.intervention is None
    # 无 digestBulk.* key
    assert not any(k.startswith("mailagent.digestBulk.") for k in env.metadata)


def test_envelope_under_64kib_with_max_ids(patch_send, fake_store):
    """risk 表第 2 条: 30 ids × 3 action 的 envelope 远低于 64KiB。"""
    island_dispatch.init(enabled=True, sync_store=fake_store)
    ids30 = list(range(530000, 530030))
    _dispatch(
        [
            DigestBulkAction(id="bulk_archive_newsletter", title="归档 30 封", internal_ids=ids30),
            DigestBulkAction(id="bulk_mark_read", title="标记 30 已读", internal_ids=ids30),
            DigestBulkAction(id="bulk_mark_done", title="标记 30 完成", internal_ids=ids30),
        ]
    )
    encoded = patch_send[0].encode()
    assert len(encoded) < 64 * 1024
