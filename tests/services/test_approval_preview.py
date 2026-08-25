"""审批卡 preview 服务端派生器（L4 批次 1 #6，``src/services/approval_preview.py``）。

钉三件事：
① ``email_draft_reply`` 的收件人来自**服务端派生**（模型不传 ``to`` 时 reply-all 的
   真实结果），而不是复述模型 args；模型显式给 ``to`` 时以模型的为准（那才是要发的）。
② ``calendar_event_reschedule`` 的「现值」来自 ``calendar_event`` 行；库里查不到就
   老实返回 None（不编现值）。
③ 无派生器 / 形状不对 / 派生失败一律 ``None`` —— 调用方据此 fail-open。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from src.calendar_sync import CalendarEventRepository
from src.calendar_sync.caldav_reader import CalendarEvent
from src.mail.sync_store import SyncStore
from src.services.approval_preview import (
    APPROVAL_PREVIEW_MAX_CHARS,
    build_approval_preview,
)


@pytest.fixture
def env(tmp_path):
    """ctx（真 SyncStore + 自有地址）+ settings（指向同一个临时库）。"""
    db_path = str(tmp_path / "t.db")
    ctx = MagicMock()
    ctx.sync_store = SyncStore(db_path)
    ctx.config.user_email = "me@x.com"
    settings = MagicMock()
    settings.sync_store_db_path = db_path
    return ctx, settings


def _seed_incoming(store: SyncStore, internal_id: int = 1) -> int:
    store.save_email(
        {
            "internal_id": internal_id,
            "message_id": f"orig-{internal_id}@x",
            "subject": "季度预算",
            "sender": "boss@x.com",
            "to_addr": "me@x.com, peer@y.com",
            "cc_addr": "watcher@z.com, me@x.com",
            "mailbox": "收件箱",
            "date_received": "2026-08-01T10:00:00+00:00",
        }
    )
    return internal_id


# ─────────────────────────────────────────────────────────────────────────────
# email_draft_reply —— 服务端派生的真实收件人
# ─────────────────────────────────────────────────────────────────────────────


def test_reply_all_preview_shows_server_derived_recipients(env):
    """模型只给了正文，收件人整段是服务端算的 —— preview 必须把它们摊开。"""
    ctx, settings = env
    iid = _seed_incoming(ctx.sync_store)

    preview = build_approval_preview(
        "email_draft_reply",
        {"internal_id": iid, "body_markdown": "收到，明天给你数字。"},
        ctx=ctx,
        settings=settings,
    )

    assert preview is not None
    # reply-all = 原发件人 + 原收件人（去掉自己），抄送保留（去掉自己）
    assert "boss@x.com" in preview
    assert "peer@y.com" in preview
    assert "watcher@z.com" in preview
    # 自己不该出现在收件人里（服务端派生的核心事实之一）
    assert "me@x.com" not in preview
    # 主题是真正会发出去的那个（带 Re: 前缀），不是模型说的
    assert "Re: 季度预算" in preview


def test_reply_preview_uses_model_override_when_given(env):
    """模型显式给了 to —— 那就是要发的，preview 跟着它走（不是「服务端说了算」）。"""
    ctx, settings = env
    iid = _seed_incoming(ctx.sync_store)

    preview = build_approval_preview(
        "email_draft_reply",
        {
            "internal_id": iid,
            "body_markdown": "只回你一个人。",
            "to": ["boss@x.com"],
        },
        ctx=ctx,
        settings=settings,
    )

    assert preview is not None
    assert "boss@x.com" in preview
    assert "peer@y.com" not in preview  # 被覆盖掉了


def test_empty_recipient_list_is_not_an_override(env):
    """``to: []`` = 「没有覆盖」不是「清空」—— 与 gateway wire 映射同一条语义。

    读反了就会在卡上显示「收件人 (空)」，而执行时服务端照样 reply-all 发出去。
    """
    ctx, settings = env
    iid = _seed_incoming(ctx.sync_store)

    preview = build_approval_preview(
        "email_draft_reply",
        {"internal_id": iid, "body_markdown": "正文", "to": [], "cc": []},
        ctx=ctx,
        settings=settings,
    )

    assert preview is not None
    assert "boss@x.com" in preview


def test_blank_or_non_string_addrs_are_not_an_override(env):
    """清完为空的列表 = 「没有覆盖」—— 与执行链第一步 ``normalizeAddrs`` 同一条语义。

    只镜像 wire 那一步（「列表非空就带上」）会让这里显示「收件人 (空)」，而执行时
    ``normalizeAddrs`` 把它清成 undefined、服务端照样 reply-all —— 卡上比现实少。
    """
    ctx, settings = env
    iid = _seed_incoming(ctx.sync_store)

    preview = build_approval_preview(
        "email_draft_reply",
        {"internal_id": iid, "body_markdown": "正文", "to": ["   "], "cc": [None]},
        ctx=ctx,
        settings=settings,
    )

    assert preview is not None
    assert "boss@x.com" in preview
    assert "peer@y.com" in preview
    assert "收件人 (空)" not in preview


def test_reply_mode_narrows_to_sender_only(env):
    ctx, settings = env
    iid = _seed_incoming(ctx.sync_store)

    preview = build_approval_preview(
        "email_draft_reply",
        {"internal_id": iid, "body_markdown": "正文", "mode": "reply"},
        ctx=ctx,
        settings=settings,
    )

    assert preview is not None
    assert "boss@x.com" in preview
    assert "peer@y.com" not in preview


def test_reply_preview_missing_email_row_degrades_to_none(env):
    """源邮件不在库里 → None（调用方回落旧文案），不抛。"""
    ctx, settings = env
    preview = build_approval_preview(
        "email_draft_reply",
        {"internal_id": 99999, "body_markdown": "正文"},
        ctx=ctx,
        settings=settings,
    )
    assert preview is None


def test_reply_preview_is_capped(env):
    """收件人再多也是一行 ≤ 上限（飞书卡按「上游已截断」渲染）。"""
    ctx, settings = env
    ctx.sync_store.save_email(
        {
            "internal_id": 7,
            "message_id": "many@x",
            "subject": "全员通知" * 20,
            "sender": "boss@x.com",
            "to_addr": ", ".join(f"p{i}@y.com" for i in range(40)),
            "mailbox": "收件箱",
            "date_received": "2026-08-01T10:00:00+00:00",
        }
    )

    preview = build_approval_preview(
        "email_draft_reply",
        {"internal_id": 7, "body_markdown": "正文"},
        ctx=ctx,
        settings=settings,
    )

    assert preview is not None
    assert len(preview) <= APPROVAL_PREVIEW_MAX_CHARS + 1  # +1 = 省略号
    assert "等 41 人" in preview or "…" in preview


# ─────────────────────────────────────────────────────────────────────────────
# calendar_event_reschedule —— 库内现值 vs 模型提案
# ─────────────────────────────────────────────────────────────────────────────


def _seed_event(db_path: str, uid: str = "evt-1") -> None:
    start = datetime(2026, 8, 25, 9, 0, tzinfo=timezone.utc)
    CalendarEventRepository(db_path).upsert_from_caldav_event(
        CalendarEvent(
            summary="周会",
            start=start,
            end=start + timedelta(hours=1),
            organizer="boss@x.com",
            attendees=[],
            location="",
            description="",
            url="",
            ical_uid=uid,
            sequence=0,
            recurrence_id=None,
            rrule="",
            exdates=[],
            rdates=[],
            status="CONFIRMED",
            response_status="",
            calendar_name="日历",
        ),
        source="caldav",
    )


def test_reschedule_preview_carries_current_event_facts(env):
    ctx, settings = env
    _seed_event(settings.sync_store_db_path)

    preview = build_approval_preview(
        "calendar_event_reschedule",
        {
            "event_id": "evt-1",
            "new_start": "2026-08-26T14:00:00",
            "new_end": "2026-08-26T15:00:00",
            "scope": "occurrence",
        },
        ctx=ctx,
        settings=settings,
    )

    assert preview is not None
    assert "周会" in preview  # 现标题 = 库里的，不是模型自述
    assert "08-25" in preview or "08-26 0" in preview  # 现起始（本机时区渲染）
    assert "2026-08-26T14:00:00" in preview  # 模型的提案原样透出
    assert "这一次" in preview


def test_reschedule_preview_unknown_event_degrades_to_none(env):
    ctx, settings = env
    preview = build_approval_preview(
        "calendar_event_reschedule",
        {"event_id": "nope", "new_start": "x", "new_end": "y"},
        ctx=ctx,
        settings=settings,
    )
    assert preview is None


# ─────────────────────────────────────────────────────────────────────────────
# 降级面
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "tool_name,tool_input",
    [
        ("email_prepare_send", {"to": ["a@x"], "subject": "s", "body_markdown": "b"}),
        ("web_fetch", {"url": "https://x"}),
        ("", {}),
        ("email_draft_reply", "not-a-dict"),
        ("email_draft_reply", {"internal_id": "1", "body_markdown": "b"}),
        ("calendar_event_reschedule", {"event_id": "   "}),
    ],
)
def test_no_deriver_or_bad_shape_returns_none(env, tool_name, tool_input):
    ctx, settings = env
    assert build_approval_preview(tool_name, tool_input, ctx=ctx, settings=settings) is None
