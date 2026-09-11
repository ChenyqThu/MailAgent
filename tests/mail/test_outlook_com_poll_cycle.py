"""outlook_com + new_watcher._poll_cycle 联测 (task 09-11-outlook-com-dasl-utc-fix R3/R4).

真 SyncStore + 真 OutlookComBackend (fake COM); _poll_cycle 里与本题无关的步骤 stub 掉
(同 test_poll_cycle_cursor_guard.py 的 harness)。

- R3: 新邮件入库带 entry_id, 取正文走 GetItemFromID, 不调 Items.Find
  (2026-09-11 反馈: 漏传 entry_id + message_id 反查落空 → 那封永远取不到正文);
- R4: 单轮被 MAX_BATCH 截断时水位只推进到「已取完的那一分钟末尾」, 下一轮取完剩余;
  同一分钟挤了超过 MAX_BATCH 封时轮次照样收敛 (水位不会原地打转)。
"""
from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from src.mail.new_watcher import NewWatcher
from src.mail.sync_store import SyncStore
from tests.mail.backend.com_fakes import FakeItem, FakeItems, make_backend

T0 = 1_760_000_040  # 整分钟; 下面的邮件逐分钟排开, 分钟取整不引入额外边界封


@pytest.fixture()
def ctx(tmp_path: Path):
    store = SyncStore(str(tmp_path / "t.db"))
    env = make_backend(sync_store=store)
    w = NewWatcher.__new__(NewWatcher)
    w.sync_store = store
    w.backend = env.backend
    w._stats = {"polls": 0, "new_emails_detected": 0}
    w._throttle_pause_announced = False
    w._kos_unhealthy_until = time.monotonic() + 3600

    async def _noop():
        return

    for name in (
        "_process_pending_emails",
        "_process_retry_queue",
        "_process_llm_retry_queue",
        "_detect_and_sync_flag_changes",
        "_extract_contacts",
        "_scan_calendar_contacts",
        "_contact_governance_tick",
    ):
        setattr(w, name, _noop)
    store.set_last_max_row_id(T0)
    yield SimpleNamespace(w=w, env=env, store=store)
    env.backend.shutdown()


def _message_ids(store: SyncStore) -> list:
    with sqlite3.connect(str(store.db_path)) as conn:
        return sorted(r[0] for r in conn.execute("SELECT message_id FROM email_metadata"))


def test_new_mail_saved_with_entry_id_and_body_fetch_skips_find(ctx, monkeypatch):
    assert T0 % 60 == 0
    item = ctx.env.store.inbox.add_item(
        FakeItem(
            received_epoch=T0 + 60,
            message_id="<n1@example.test>",
            subject="new",
            html_body="<html><body>正文</body></html>",
            text_body="正文",
        )
    )
    asyncio.run(ctx.w._poll_cycle())
    row = ctx.store.get_by_message_id("n1@example.test")
    assert row is not None
    assert row["entry_id"] == item.EntryID

    find_calls = []
    monkeypatch.setattr(FakeItems, "Find", lambda self, flt: find_calls.append(flt))
    result = ctx.env.backend.fetch_email_content_by_id(row["internal_id"])
    assert result is not None
    assert "正文" in result["content"]
    assert find_calls == []  # 走 GetItemFromID 快路径


def test_truncated_round_advances_to_last_fetched_then_next_round_gets_rest(ctx):
    epochs = [T0 + 60 * i for i in range(1, 251)]
    for epoch in epochs:
        ctx.env.store.inbox.add_item(
            FakeItem(received_epoch=epoch, message_id=f"<b-{epoch}@example.test>")
        )
    expected = sorted(f"b-{epoch}@example.test" for epoch in epochs)

    asyncio.run(ctx.w._poll_cycle())
    # 水位 = 第 200 封所在分钟的末尾 (邮件逐分钟排开, 恰是第 201 封的时刻)
    assert ctx.store.get_last_max_row_id() == epochs[199] + 60
    assert _message_ids(ctx.store) == expected[:200]  # 最早的 200 封

    asyncio.run(ctx.w._poll_cycle())
    assert ctx.store.get_last_max_row_id() == epochs[-1]
    assert _message_ids(ctx.store) == expected  # 250 行: 无遗漏、无重复


def test_crowded_minute_ingests_every_mail_exactly_once(ctx):
    """同一分钟 250 封 + 之后每分钟一封: 轮次收敛, 每封恰好一行, 水位严格递增."""
    minute = T0 + 60
    epochs = [minute + i % 60 for i in range(250)]
    epochs += [minute + 60 * k for k in range(1, 31)]
    for idx, epoch in enumerate(epochs):
        ctx.env.store.inbox.add_item(
            FakeItem(received_epoch=epoch, message_id=f"<c{idx}@example.test>")
        )
    expected = sorted(f"c{idx}@example.test" for idx in range(len(epochs)))

    markers = [ctx.store.get_last_max_row_id()]
    for _ in range(6):
        asyncio.run(ctx.w._poll_cycle())
        markers.append(ctx.store.get_last_max_row_id())
        if _message_ids(ctx.store) == expected:
            break
    else:
        pytest.fail(f"轮次没有收敛 (水位: {markers})")
    assert markers == sorted(set(markers))  # 严格递增: 没有原地打转, 也没有回退
