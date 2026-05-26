"""单测：island_dispatch — 9 个事件构造 + send 路径 + island_dispatch 表记录."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
from pathlib import Path
from typing import Any, Dict, List

import pytest

from src.notify import island_dispatch, ping_island, island_reconnect


class _FakeSyncStore:
    """轻量 stub 替代 SyncStore，仅实现 record_island_dispatch."""

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
    """所有 dispatch_* 走假 send_async, 直接捕获最后一次 envelope."""
    captured: List[Any] = []
    response_to_return: Dict[str, Any] = {}

    async def fake_send_async(envelope, **kwargs):
        captured.append(envelope)
        resp = response_to_return.get("response")
        return ping_island.SendResult(ok=True, response=resp, latency_ms=12)

    monkeypatch.setattr(ping_island, "send_async", fake_send_async)
    monkeypatch.setattr(island_dispatch.ping_island, "send_async", fake_send_async)
    return captured, response_to_return


def test_disabled_dispatcher_is_noop(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=False, sync_store=fake_store)
    island_dispatch.dispatch_mail_received(
        internal_id=1, page_id="p", subject="s", sender_email="a@b",
        sender_name="A", mailbox="收件箱",
    )
    # 没拉起 task，没记录
    assert captured == []
    assert fake_store.rows == []


def test_mail_received_emits_mail_received(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store,
                          account_name="Exchange")

    async def _scenario():
        island_dispatch.dispatch_mail_received(
            internal_id=53675, page_id="31a1-5375", subject="Hello",
            sender_email="john@example.com", sender_name="John", mailbox="收件箱",
            attach_count=2,
        )
        # 让 fire 的 background task 跑完
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert len(captured) == 1
    env = captured[0]
    assert env.event_type == "MailReceived"
    assert env.session_key == "mailagent:email:53675"
    assert env.intervention is None
    assert env.expects_response is False
    assert env.metadata["mailagent.internalId"] == "53675"
    assert env.metadata["mailagent.notionPageId"] == "31a1-5375"
    assert env.metadata["mailagent.accountName"] == "Exchange"
    assert env.metadata["mailagent.attachCount"] == "2"
    # SQLite 记录
    assert len(fake_store.rows) == 1
    assert fake_store.rows[0]["event_type"] == "MailReceived"
    assert fake_store.rows[0]["dispatched_ok"] is True


def test_llm_reviewed_urgent_attaches_5_options(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")

    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(
            internal_id=7, page_id="pid", subject="S", sender_email="x@y",
            sender_name="X", mailbox="收件箱",
            priority="🔴 紧急", action="需要回复",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert len(captured) == 1
    env = captured[0]
    assert env.event_type == "LLMReviewedUrgent"
    assert env.intervention is not None
    assert len(env.intervention.options) == 5
    option_ids = {opt.id for opt in env.intervention.options}
    assert option_ids == {"create_draft", "open_mail", "open_notion",
                          "mark_done", "snooze_1h"}
    assert env.expects_response is True
    assert env.status_kind == "waitingForInput"


def test_llm_reviewed_non_urgent_has_no_intervention(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")

    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(
            internal_id=8, page_id="pid", subject="S", sender_email="x@y",
            sender_name="X", mailbox="收件箱",
            priority="🟢 普通", action="仅供参考",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "LLMReviewed"
    assert env.intervention is None
    assert env.expects_response is False


def test_mail_completed_status_kind(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_mail_completed(
            internal_id=42, page_id="p", subject="Done", mailbox="收件箱",
        )
        await asyncio.sleep(0.05)

    captured, _ = patch_send
    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "MailCompleted"
    assert env.status_kind == "completed"


def test_sync_failed_carries_error_in_status_detail(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_sync_failed(
            internal_id=99, subject="S", error="ECONNRESET 中断",
        )
        await asyncio.sleep(0.05)

    captured, _ = patch_send
    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "SyncFailed"
    assert env.status_kind == "error"
    assert "ECONNRESET" in (env.status_detail or "")


def test_dead_letter_accum_session_key(patch_send, fake_store):
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_dead_letter_accum(count=7, threshold=5)
        await asyncio.sleep(0.05)

    captured, _ = patch_send
    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "DeadLetterAccum"
    assert env.session_key == "mailagent:system:dead_letter"
    assert env.metadata["mailagent.deadLetterCount"] == "7"


def test_failed_send_enqueues_to_reconnect_backlog(monkeypatch, fake_store):
    """ping-island 离线 → send 返回 ok=False → envelope bytes 应入 reconnect 队列."""
    island_reconnect.clear_queue()
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def fake_send_async(envelope, **kwargs):
        return ping_island.SendResult(ok=False, error="ENOENT", latency_ms=5)

    monkeypatch.setattr(ping_island, "send_async", fake_send_async)
    monkeypatch.setattr(island_dispatch.ping_island, "send_async", fake_send_async)

    async def _scenario():
        island_dispatch.dispatch_mail_received(
            internal_id=1, page_id="p", subject="s", sender_email="a@b",
            sender_name="A", mailbox="收件箱",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert island_reconnect.queue_len() == 1
    # 失败也要写 SQLite 行（dispatched_ok=False）
    assert fake_store.rows
    assert fake_store.rows[0]["dispatched_ok"] is False
    island_reconnect.clear_queue()


def test_response_with_decision_invokes_response_handler(monkeypatch, fake_store):
    """收到 BridgeResponse.decision → island_response.handle_response 被调."""
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")

    captured_meta: Dict[str, Any] = {}
    captured_choice: List[str] = []

    async def fake_handle(resp, meta):
        captured_meta.update(meta)
        choice = resp.get("decision", {}).get("answer", {}).get("choice")
        captured_choice.append(choice)

    # 让 send_async 返回带 decision 的 response
    decision_resp = {"decision": {"answer": {"choice": "open_mail"}}}

    async def fake_send_async(envelope, **kwargs):
        return ping_island.SendResult(ok=True, response=decision_resp, latency_ms=8)

    monkeypatch.setattr(ping_island, "send_async", fake_send_async)
    monkeypatch.setattr(island_dispatch.ping_island, "send_async", fake_send_async)

    # 替换 island_response.handle_response（dispatch 内 lazy import）
    import src.notify.island_response as island_response_mod
    monkeypatch.setattr(island_response_mod, "handle_response", fake_handle)

    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(
            internal_id=53675, page_id="pid", subject="S", sender_email="a@b",
            sender_name="A", mailbox="收件箱",
            priority="🔴 紧急", action="需要回复",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())

    assert captured_choice == ["open_mail"]
    assert captured_meta.get("mailagent.internalId") == "53675"
    # 记录到 SQLite 的 response_decision 字段
    assert fake_store.rows[-1]["response_decision"] == "open_mail"


# ──────────────────────────────────────────────────────────────────────────
# Phase 1 (PRD §5.1) — mascot rules + envelope 新字段 (aiSummary/scenario/mascot/senderDigest)
# 设计 ref: ~/.claude/plans/ultrathink-session-curious-cloud.md §5.1 + §Appendix B
# ──────────────────────────────────────────────────────────────────────────


def test_resolve_mascot_personal_for_gmail(monkeypatch):
    """consumer email domain → ``personal`` mascot."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.delenv("USER_EMAIL", raising=False)
    assert island_dispatch._resolve_mascot("alice@gmail.com") == "personal"
    assert island_dispatch._resolve_mascot("alice@icloud.com") == "personal"
    assert island_dispatch._resolve_mascot("alice@qq.com") == "personal"
    assert island_dispatch._resolve_mascot("alice@163.com") == "personal"


def test_resolve_mascot_dev_for_dev_services(monkeypatch):
    """开发者通知 domain (含子域后缀匹配) → ``dev`` mascot."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.delenv("USER_EMAIL", raising=False)
    assert island_dispatch._resolve_mascot("noreply@github.com") == "dev"
    assert island_dispatch._resolve_mascot("alerts@app.sentry.io") == "dev"  # 子域
    assert island_dispatch._resolve_mascot("bot@stripe.com") == "dev"
    assert island_dispatch._resolve_mascot("digest@linear.app") == "dev"


def test_resolve_mascot_user_domain_is_work(monkeypatch):
    """``USER_EMAIL`` 同域 / 子域 → ``work`` mascot."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.setenv("USER_EMAIL", "me@acme.com")
    assert island_dispatch._resolve_mascot("boss@acme.com") == "work"
    assert island_dispatch._resolve_mascot("ceo@us.acme.com") == "work"  # 子域
    # 不在用户域 + 不在默认 rules → default
    assert island_dispatch._resolve_mascot("stranger@example.org") == "default"


def test_resolve_mascot_env_override(monkeypatch):
    """``MAILAGENT_MASCOT_DOMAIN_RULES`` JSON 覆盖默认规则表."""
    monkeypatch.setenv(
        "MAILAGENT_MASCOT_DOMAIN_RULES",
        '{"work":["acme.com"],"personal":["foo.com"]}',
    )
    monkeypatch.delenv("USER_EMAIL", raising=False)
    assert island_dispatch._resolve_mascot("a@acme.com") == "work"
    assert island_dispatch._resolve_mascot("b@foo.com") == "personal"
    # 默认 personal 规则（含 gmail.com）被覆盖 → default
    assert island_dispatch._resolve_mascot("c@gmail.com") == "default"


def test_resolve_mascot_invalid_env_falls_back_to_default(monkeypatch):
    """invalid JSON env → warning + 走 default rules (不 crash)."""
    monkeypatch.setenv("MAILAGENT_MASCOT_DOMAIN_RULES", "{not valid json")
    monkeypatch.delenv("USER_EMAIL", raising=False)
    # 默认 gmail.com 规则仍生效
    assert island_dispatch._resolve_mascot("a@gmail.com") == "personal"


def test_resolve_mascot_default_fallback(monkeypatch):
    """空 / 无 @ / 未匹配 → ``default``."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.delenv("USER_EMAIL", raising=False)
    assert island_dispatch._resolve_mascot("") == "default"
    assert island_dispatch._resolve_mascot("not-an-email") == "default"
    assert island_dispatch._resolve_mascot("@") == "default"
    assert island_dispatch._resolve_mascot("anon@randomdomain.xyz") == "default"


def test_mail_received_envelope_carries_scenario_and_mascot(patch_send, fake_store, monkeypatch):
    """MailReceived envelope metadata 含 scenario + mascot (PRD §Appendix B)."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.delenv("USER_EMAIL", raising=False)
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_mail_received(
            internal_id=99, page_id="p1", subject="Test",
            sender_email="alice@gmail.com", sender_name="Alice", mailbox="收件箱",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.metadata["mailagent.scenario"] == "MailReceived"
    assert env.metadata["mailagent.mascot"] == "personal"


def test_llm_reviewed_envelope_carries_ai_summary(patch_send, fake_store, monkeypatch):
    """LLMReviewed envelope metadata 含 ai_summary + scenario + mascot."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.delenv("USER_EMAIL", raising=False)
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(
            internal_id=10, page_id="p2", subject="Q3 OKR",
            sender_email="john@github.com", sender_name="John", mailbox="收件箱",
            priority="🟢 一般", action="仅供参考",
            ai_summary="John 询问 Q3 OKR 进度，期望本周回复。",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "LLMReviewed"
    assert env.metadata["mailagent.aiSummary"] == "John 询问 Q3 OKR 进度，期望本周回复。"
    assert env.metadata["mailagent.scenario"] == "LLMReviewed"
    assert env.metadata["mailagent.mascot"] == "dev"


def test_llm_reviewed_urgent_envelope_has_scenario_event_type(patch_send, fake_store, monkeypatch):
    """LLMReviewedUrgent scenario == event_type (fork 端按 scenario 选 4 scene)."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.delenv("USER_EMAIL", raising=False)
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(
            internal_id=11, page_id="p3", subject="Server down",
            sender_email="alerts@pagerduty.com", sender_name="PagerDuty",
            mailbox="收件箱",
            priority="🔴 紧急", action="需要回复",
            ai_summary="生产环境 webhook 502 中。",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "LLMReviewedUrgent"
    assert env.metadata["mailagent.scenario"] == "LLMReviewedUrgent"
    assert env.metadata["mailagent.aiSummary"] == "生产环境 webhook 502 中。"
    # pagerduty.com 不在默认 dev rule → default (除非 user 加 env 覆盖)
    assert env.metadata["mailagent.mascot"] == "default"


def test_mail_completed_envelope_has_scenario(patch_send, fake_store):
    """MailCompleted envelope metadata 含 scenario."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_mail_completed(
            internal_id=12, page_id="p4", subject="Done", mailbox="收件箱",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.metadata["mailagent.scenario"] == "MailCompleted"


def test_sync_failed_envelope_with_sender_has_mascot(patch_send, fake_store, monkeypatch):
    """SyncFailed 传 sender_email → mascot 按 domain 推断."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.delenv("USER_EMAIL", raising=False)
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_sync_failed(
            internal_id=13, subject="Bad email", error="Notion 409",
            sender_email="alice@gmail.com",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.metadata["mailagent.scenario"] == "SyncFailed"
    assert env.metadata["mailagent.mascot"] == "personal"


def test_sync_failed_envelope_without_sender_uses_default_mascot(patch_send, fake_store):
    """SyncFailed 不传 sender_email → mascot=default (向后兼容老 caller)."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_sync_failed(
            internal_id=14, subject="Bad", error="boom",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.metadata["mailagent.mascot"] == "default"
    assert env.metadata["mailagent.scenario"] == "SyncFailed"


def test_dead_letter_envelope_carries_scenario(patch_send, fake_store):
    """DeadLetterAccum envelope metadata 含 scenario + mascot=default."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_dead_letter_accum(count=10, threshold=5)
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.metadata["mailagent.scenario"] == "DeadLetterAccum"
    assert env.metadata["mailagent.mascot"] == "default"


def test_sender_digest_optional_field(patch_send, fake_store, monkeypatch):
    """sender_digest 非空才进 metadata（向后兼容，默认 envelope 不含此 key）."""
    monkeypatch.delenv("MAILAGENT_MASCOT_DOMAIN_RULES", raising=False)
    monkeypatch.delenv("USER_EMAIL", raising=False)
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_mail_received(
            internal_id=20, page_id="px", subject="Test",
            sender_email="bob@example.com", sender_name="Bob", mailbox="收件箱",
            sender_digest="Past 3 emails: project updates.",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.metadata["mailagent.senderDigest"] == "Past 3 emails: project updates."

    # 不传 sender_digest → 该 key 不应出现（保持 envelope 紧凑）
    captured.clear()

    async def _scenario2():
        island_dispatch.dispatch_mail_received(
            internal_id=21, page_id="py", subject="Test",
            sender_email="bob@example.com", sender_name="Bob", mailbox="收件箱",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario2())
    env2 = captured[0]
    assert "mailagent.senderDigest" not in env2.metadata


# ──────────────────────────────────────────────────────────────────────────
# Phase 2 (PRD §5.2) — recommended_actions 动态注入 intervention.options
# 处理 5 类输入: 0/1/2/3/4 actions (后者 cap 3) / unknown id / 低 confidence /
# 缺字段 / 静态 5 id 灰名单 / None → 全部 sanitize + fallback static 5 验证.
# ──────────────────────────────────────────────────────────────────────────


def _urgent_kwargs(**overrides):
    """LLMReviewedUrgent dispatch 参数 builder (priority/action urgent 命中)."""
    base = {
        "internal_id": 100, "page_id": "pid", "subject": "S",
        "sender_email": "a@example.com", "sender_name": "A", "mailbox": "收件箱",
        "priority": "🔴 紧急", "action": "需要回复",
    }
    base.update(overrides)
    return base


def _run_dispatch(patch_send, **kwargs):
    """同步包装异步 dispatch_llm_reviewed 等 fire-and-forget task drained."""
    async def _scenario():
        island_dispatch.dispatch_llm_reviewed(**kwargs)
        await asyncio.sleep(0.05)
    asyncio.run(_scenario())
    return patch_send[0][-1]


def test_dispatch_urgent_with_single_recommended_action(patch_send, fake_store):
    """LLM 推 1 个有效 action → intervention 仅 1 option, 不 fallback static."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "archive_and_unsubscribe", "title": "归档并退订",
             "detail": "Stripe weekly, 已订 6 个月", "confidence": 0.92},
        ],
    ))
    assert env.event_type == "LLMReviewedUrgent"
    assert env.intervention is not None
    options = env.intervention.options
    assert len(options) == 1
    assert options[0].id == "archive_and_unsubscribe"
    assert options[0].title == "归档并退订"
    assert options[0].detail == "Stripe weekly, 已订 6 个月"


def test_dispatch_urgent_with_two_recommended_actions(patch_send, fake_store):
    """LLM 推 2 个有效 action → intervention 2 option 全保留, 顺序保持."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "add_to_calendar", "title": "加入日历", "confidence": 0.95},
            {"id": "decline_with_reason", "title": "婉拒并说明", "confidence": 0.6},
        ],
    ))
    ids = [o.id for o in env.intervention.options]
    assert ids == ["add_to_calendar", "decline_with_reason"]


def test_dispatch_urgent_with_three_recommended_actions_all_kept(patch_send, fake_store):
    """LLM 推满 3 个有效 action → 全保留."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "ack_in_pagerduty", "title": "在 PagerDuty 确认", "confidence": 0.93},
            {"id": "escalate_to_oncall", "title": "升级 on-call", "confidence": 0.8},
            {"id": "quick_reply_yes", "title": "快速回复 是", "confidence": 0.55},
        ],
    ))
    ids = [o.id for o in env.intervention.options]
    assert ids == ["ack_in_pagerduty", "escalate_to_oncall", "quick_reply_yes"]


def test_dispatch_urgent_caps_recommended_actions_to_3(patch_send, fake_store):
    """LLM 推 4 个 (schema maxItems 已 cap 3, 但 dispatch 二次防御性 cap)."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "archive_and_unsubscribe", "title": "归档并退订", "confidence": 0.9},
            {"id": "archive_only", "title": "归档", "confidence": 0.85},
            {"id": "add_to_calendar", "title": "加入日历", "confidence": 0.8},
            {"id": "decline_with_reason", "title": "婉拒并说明", "confidence": 0.75},
        ],
    ))
    options = env.intervention.options
    assert len(options) == 3
    # 前 3 个保留
    assert [o.id for o in options] == [
        "archive_and_unsubscribe", "archive_only", "add_to_calendar",
    ]


def test_dispatch_urgent_unknown_id_silently_dropped(patch_send, fake_store):
    """LLM 出 whitelist 外 id → 单条 silent drop, 其他保留."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "delete_email_forever", "title": "永久删除", "confidence": 0.99},
            {"id": "archive_only", "title": "归档", "confidence": 0.8},
        ],
    ))
    ids = [o.id for o in env.intervention.options]
    assert ids == ["archive_only"]


def test_dispatch_urgent_static_5_id_dropped_from_llm_recs(patch_send, fake_store):
    """LLM 把 Phase 1 静态 5 id (open_mail 等) 当 recommended 推 → silent drop.
    静态 5 仅作为 fallback path, 不在 LLM recommendation 空间."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "open_mail", "title": "Open Mail", "confidence": 0.9},
            {"id": "create_draft", "title": "Draft", "confidence": 0.9},
        ],
    ))
    # 全 filter 掉 → fallback static 5
    options = env.intervention.options
    assert len(options) == 5
    assert {o.id for o in options} == {
        "create_draft", "open_mail", "open_notion", "mark_done", "snooze_1h",
    }


def test_dispatch_urgent_low_confidence_falls_back_to_static_5(patch_send, fake_store):
    """全部候选 confidence < 0.5 → fallback static 5."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "archive_only", "title": "归档", "confidence": 0.3},
            {"id": "add_to_calendar", "title": "加入日历", "confidence": 0.49},
        ],
    ))
    assert len(env.intervention.options) == 5


def test_dispatch_urgent_mixed_confidence_keeps_only_high(patch_send, fake_store):
    """混合 confidence → 只保留 >= 0.5 的, 其他 silent drop."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "archive_only", "title": "归档", "confidence": 0.3},     # drop
            {"id": "add_to_calendar", "title": "加入日历", "confidence": 0.8},  # keep
            {"id": "decline_with_reason", "title": "婉拒", "confidence": 0.5},  # keep (边界)
        ],
    ))
    ids = [o.id for o in env.intervention.options]
    assert ids == ["add_to_calendar", "decline_with_reason"]


def test_dispatch_urgent_missing_title_drops_entry(patch_send, fake_store):
    """缺 title / title 空字符串 → 单条 drop."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "archive_only", "confidence": 0.9},  # 缺 title
            {"id": "add_to_calendar", "title": "   ", "confidence": 0.9},  # 空 title
            {"id": "decline_with_reason", "title": "婉拒", "confidence": 0.9},
        ],
    ))
    ids = [o.id for o in env.intervention.options]
    assert ids == ["decline_with_reason"]


def test_dispatch_urgent_recommended_actions_none_falls_back(patch_send, fake_store):
    """recommended_actions=None → fallback static 5 (Phase 1 兼容路径)."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(recommended_actions=None))
    assert len(env.intervention.options) == 5
    assert {o.id for o in env.intervention.options} == {
        "create_draft", "open_mail", "open_notion", "mark_done", "snooze_1h",
    }


def test_dispatch_urgent_recommended_actions_empty_list_falls_back(patch_send, fake_store):
    """recommended_actions=[] → fallback static 5."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(recommended_actions=[]))
    assert len(env.intervention.options) == 5


def test_dispatch_non_urgent_ignores_recommended_actions(patch_send, fake_store):
    """非 urgent 邮件不应有 intervention, 即使 recommended_actions 有内容."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send,
        internal_id=200, page_id="pid", subject="S",
        sender_email="a@example.com", sender_name="A", mailbox="收件箱",
        priority="🟢 一般", action="仅供参考",
        recommended_actions=[
            {"id": "archive_only", "title": "归档", "confidence": 0.95},
        ],
    )
    # 非 urgent → 不应有 intervention
    assert env.event_type == "LLMReviewed"
    assert env.intervention is None


def test_dispatch_urgent_detail_optional(patch_send, fake_store):
    """LLM 未给 detail → InterventionOption.detail = None (不影响 button 渲染)."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "archive_only", "title": "归档", "confidence": 0.9},  # 无 detail
        ],
    ))
    opt = env.intervention.options[0]
    assert opt.detail is None


def test_dispatch_urgent_non_dict_entries_dropped(patch_send, fake_store):
    """recommended_actions 含非 dict 项 (str / list / None) → silent drop."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            "open_notion",  # str
            None,           # None
            {"id": "archive_only", "title": "归档", "confidence": 0.9},
        ],
    ))
    ids = [o.id for o in env.intervention.options]
    assert ids == ["archive_only"]


# ──────────────────────────────────────────────────────────────────────────
# Phase 2 — _build_dynamic_options 单元 (不走 envelope, 直接函数测)
# ──────────────────────────────────────────────────────────────────────────


def test_build_dynamic_options_invalid_confidence_dropped():
    """confidence 不是 number / NaN → silent drop."""
    opts = island_dispatch._build_dynamic_options([
        {"id": "archive_only", "title": "归档", "confidence": "high"},   # str
        {"id": "add_to_calendar", "title": "加入日历", "confidence": float("nan")},  # NaN
        {"id": "decline_with_reason", "title": "婉拒", "confidence": 0.8},  # OK
    ])
    assert [o.id for o in opts] == ["decline_with_reason"]


def test_build_dynamic_options_non_list_returns_empty():
    """输入非 list (dict / None / str) → 返 [] (调用方 fallback static)."""
    assert island_dispatch._build_dynamic_options(None) == []  # type: ignore[arg-type]
    assert island_dispatch._build_dynamic_options({"id": "archive_only"}) == []  # type: ignore[arg-type]
    assert island_dispatch._build_dynamic_options("archive_only") == []  # type: ignore[arg-type]


def test_build_dynamic_options_passes_through_long_title_and_detail():
    """processor 端已 sanitize 截 30/80; 这层不再截 (输入信任)."""
    opts = island_dispatch._build_dynamic_options([
        {"id": "archive_only", "title": "归档", "detail": "已订阅 6 个月", "confidence": 0.9},
    ])
    assert len(opts) == 1
    assert opts[0].title == "归档"
    assert opts[0].detail == "已订阅 6 个月"
