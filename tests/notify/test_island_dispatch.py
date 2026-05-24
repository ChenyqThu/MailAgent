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
