"""单测：island_dispatch — 9 个事件构造 + send 路径 + island_dispatch 表记录."""

from __future__ import annotations

import asyncio
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
    # 问题 A 去重是模块级 dict; 跨 test 复用 session_key (如 mailagent:email:100)
    # 会被上一个 test 留下的记录挡住 → 每个 test 前清空保证隔离。
    island_dispatch._dedup_seen.clear()
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


def test_llm_reviewed_urgent_attaches_options_with_skip(patch_send, fake_store):
    """问题 B: urgent 无 recommended → 静态 fallback 业务 option 截到 2 + 追加 skip = 3。"""
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
    # 业务 option 截到 2 (DEFAULT_OPTION_IDS 前 2 = open_notion / create_draft) + skip
    option_ids = [opt.id for opt in env.intervention.options]
    assert option_ids == ["open_notion", "create_draft", "skip"]
    assert len(env.intervention.options) == 3  # ≤3 (fork prefix(3) 上限)
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


def test_mail_completed_accepts_extra_metadata(patch_send, fake_store):
    """P0-1: extra_metadata 让 caller (snooze) 追加 mailagent.snoozeReason 等字段。"""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_mail_completed(
            internal_id=42, page_id="p", subject="S", mailbox="收件箱",
            sender_email="a@b.com", sender_name="A",
            extra_metadata={"mailagent.snoozeReason": "user_snooze_1h"},
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "MailCompleted"
    assert env.metadata["mailagent.snoozeReason"] == "user_snooze_1h"
    # sender 同时透传 → mascot 可推断
    assert env.metadata["mailagent.sender"] == "a@b.com"


# ─────────────────────────────────────────────────────────────────────────────
# P0-2: AIDraft 三函数 (start / stream / ready)
# ─────────────────────────────────────────────────────────────────────────────


def test_ai_draft_start_emits_notification(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")

    async def _scenario():
        island_dispatch.dispatch_ai_draft_start(
            internal_id=101, sender_email="alice@example.com",
            sender_name="Alice", subject="Hello", mailbox="收件箱",
            page_id="pid-101",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    assert len(captured) == 1
    env = captured[0]
    assert env.event_type == "AIDraftStart"
    assert env.session_key == "mailagent:email:101"
    assert env.status_kind == "notification"
    assert env.intervention is None
    assert env.expects_response is False
    assert env.metadata["mailagent.scenario"] == "AIDraftStart"
    assert env.metadata["mailagent.sender"] == "alice@example.com"


def test_ai_draft_stream_carries_chunk_text(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_ai_draft_stream(
            internal_id=102, chunk_text="Hi Bob, thanks for", chunk_index=3,
            sender_email="alice@example.com", subject="Re: Q3",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "AIDraftStream"
    assert env.metadata["mailagent.draftChunkIndex"] == "3"
    assert env.metadata["mailagent.draftChunkText"] == "Hi Bob, thanks for"
    assert env.intervention is None


def test_ai_draft_stream_truncates_long_chunk(patch_send, fake_store):
    """P0-2: chunk_text 截 500 字符 防 envelope > 64KiB."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    big = "X" * 1000

    async def _scenario():
        island_dispatch.dispatch_ai_draft_stream(
            internal_id=103, chunk_text=big, chunk_index=0,
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert len(env.metadata["mailagent.draftChunkText"]) == 500


def test_ai_draft_ready_has_three_options_and_waits(patch_send, fake_store):
    """P0-2: AIDraftReady → waitingForInput + 3 option (send/edit/discard)."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_ai_draft_ready(
            internal_id=104, draft_text="Hi Bob,\nThanks for your email.",
            sender_email="alice@example.com", sender_name="Alice",
            subject="Re: Q3", mailbox="收件箱", page_id="pid-104",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "AIDraftReady"
    assert env.status_kind == "waitingForInput"
    assert env.expects_response is True
    assert env.intervention is not None
    option_ids = [o.id for o in env.intervention.options]
    assert option_ids == ["send_draft", "edit_draft", "discard_draft"]
    # 草稿正文复用 aiSummary 字段渲染
    assert env.metadata["mailagent.aiSummary"].startswith("Hi Bob,")
    assert env.metadata["mailagent.scenario"] == "AIDraftReady"


def test_ai_draft_ready_truncates_long_draft_to_2000(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)
    big = "Y" * 5000

    async def _scenario():
        island_dispatch.dispatch_ai_draft_ready(
            internal_id=105, draft_text=big,
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert len(env.metadata["mailagent.aiSummary"]) == 2000


def test_ai_draft_disabled_dispatcher_is_noop(patch_send, fake_store):
    """disabled 时三函数均无副作用 (与其他 dispatch_* 同口径)."""
    captured, _ = patch_send
    island_dispatch.init(enabled=False, sync_store=fake_store)
    island_dispatch.dispatch_ai_draft_start(internal_id=1)
    island_dispatch.dispatch_ai_draft_stream(internal_id=1, chunk_text="x")
    island_dispatch.dispatch_ai_draft_ready(internal_id=1, draft_text="x")
    assert captured == []


# ─────────────────────────────────────────────────────────────────────────────
# P0-4: ActionAcked envelope (subprocess 结果回流 fork UI)
# ─────────────────────────────────────────────────────────────────────────────


def test_action_acked_ok_status_completed(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_action_acked(
            internal_id=200, envelope_id="abc-123", choice="mark_done", ok=True,
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.event_type == "ActionAcked"
    assert env.session_key == "mailagent:email:200"
    assert env.status_kind == "completed"
    assert env.status_detail is None
    assert env.metadata["mailagent.actionAckedChoice"] == "mark_done"
    assert env.metadata["mailagent.actionAckedEnvelopeId"] == "abc-123"
    assert env.metadata["mailagent.actionAckedOk"] == "true"
    assert env.metadata["mailagent.scenario"] == "ActionAcked"
    assert env.intervention is None
    assert env.expects_response is False


def test_action_acked_fail_status_error_with_detail(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_action_acked(
            internal_id=201, envelope_id="def-456", choice="create_draft",
            ok=False, error="IMAP timeout after 60s",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.status_kind == "error"
    assert env.status_detail == "IMAP timeout after 60s"
    assert env.metadata["mailagent.actionAckedOk"] == "false"
    assert env.metadata["mailagent.error"] == "IMAP timeout after 60s"
    # 失败时 preview 是 error 的截短 (≤80 chars)
    assert "IMAP timeout" in env.preview


def test_action_acked_truncates_long_error(patch_send, fake_store):
    """P0-4: error 截 200 (status_detail) + 80 (preview), 防 envelope > 64KiB."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)
    long_err = "E" * 500

    async def _scenario():
        island_dispatch.dispatch_action_acked(
            internal_id=202, envelope_id="z", choice="mark_done",
            ok=False, error=long_err,
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert len(env.status_detail) == 200
    assert len(env.preview) == 80


def test_action_acked_disabled_dispatcher_is_noop(patch_send, fake_store):
    captured, _ = patch_send
    island_dispatch.init(enabled=False, sync_store=fake_store)
    island_dispatch.dispatch_action_acked(
        internal_id=1, envelope_id="x", choice="mark_done", ok=True,
    )
    assert captured == []


def test_mail_completed_extra_metadata_rejects_invalid_values(patch_send, fake_store):
    """P0-1: extra_metadata 防御性 filter — 非 str/int/bool 的 value 不写入。"""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        island_dispatch.dispatch_mail_completed(
            internal_id=43, page_id="p", subject="S", mailbox="x",
            extra_metadata={
                "mailagent.snoozeReason": "ok",
                "mailagent.badList": [1, 2, 3],  # 应被丢弃
                "": "empty-key-should-skip",     # empty key 丢
            },
        )
        await asyncio.sleep(0.05)

    asyncio.run(_scenario())
    env = captured[0]
    assert env.metadata["mailagent.snoozeReason"] == "ok"
    assert "mailagent.badList" not in env.metadata
    assert "" not in env.metadata


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
    # 1 业务 survivor + skip (问题 B)
    assert [o.id for o in options] == ["archive_and_unsubscribe", "skip"]
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
    # 2 业务 survivor + skip (问题 B), 顺序保持
    ids = [o.id for o in env.intervention.options]
    assert ids == ["add_to_calendar", "decline_with_reason", "skip"]


def test_dispatch_urgent_three_recommended_capped_to_two_plus_skip(patch_send, fake_store):
    """问题 B: LLM 推满 3 个有效 action → 业务截到前 2 + skip (总 ≤3, fork prefix(3))。
    第 3 个业务 (quick_reply_yes) 让位给 skip。"""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(
        recommended_actions=[
            {"id": "archive_only", "title": "归档", "confidence": 0.93},
            {"id": "decline_with_reason", "title": "婉拒并说明", "confidence": 0.8},
            {"id": "quick_reply_yes", "title": "快速回复 是", "confidence": 0.55},
        ],
    ))
    ids = [o.id for o in env.intervention.options]
    assert ids == ["archive_only", "decline_with_reason", "skip"]


def test_dispatch_urgent_caps_recommended_actions_to_two_plus_skip(patch_send, fake_store):
    """问题 B: LLM 推 4 个有效 → 业务截到前 2 + skip (总 ≤3)。
    (_build_dynamic_options 内部仍 cap 3, _with_skip_option 再截到 2 + skip)。"""
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
    # 前 2 个业务保留 + skip
    assert [o.id for o in options] == [
        "archive_and_unsubscribe", "archive_only", "skip",
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
    # unknown id drop → 1 业务 survivor + skip
    ids = [o.id for o in env.intervention.options]
    assert ids == ["archive_only", "skip"]


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
    # 全 filter 掉 → fallback static; 业务截到前 2 (open_notion/create_draft) + skip
    options = env.intervention.options
    assert [o.id for o in options] == ["open_notion", "create_draft", "skip"]


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
    # 全低 confidence → fallback static; 业务截到 2 + skip
    assert [o.id for o in env.intervention.options] == ["open_notion", "create_draft", "skip"]


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
    # 2 业务 survivor + skip (问题 B)
    ids = [o.id for o in env.intervention.options]
    assert ids == ["add_to_calendar", "decline_with_reason", "skip"]


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
    # 2 条缺/空 title drop → 1 业务 survivor + skip
    ids = [o.id for o in env.intervention.options]
    assert ids == ["decline_with_reason", "skip"]


def test_dispatch_urgent_recommended_actions_none_falls_back(patch_send, fake_store):
    """recommended_actions=None → fallback static 5 (Phase 1 兼容路径)."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(recommended_actions=None))
    # fallback static; 业务截到前 2 + skip
    assert [o.id for o in env.intervention.options] == ["open_notion", "create_draft", "skip"]


def test_dispatch_urgent_recommended_actions_empty_list_falls_back(patch_send, fake_store):
    """recommended_actions=[] → fallback static 5."""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store, account_name="Ex")
    env = _run_dispatch(patch_send, **_urgent_kwargs(recommended_actions=[]))
    # fallback static; 业务截到前 2 + skip
    assert [o.id for o in env.intervention.options] == ["open_notion", "create_draft", "skip"]


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
    # 非 dict drop → 1 业务 survivor + skip
    ids = [o.id for o in env.intervention.options]
    assert ids == ["archive_only", "skip"]


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


# ──────────────────────────────────────────────────────────────────────────
# 问题 A — _fire 时间窗口去重 (同 session_key + event_type 在 DEDUP_WINDOW_SEC 内 skip)
# ──────────────────────────────────────────────────────────────────────────


@pytest.fixture
def fake_clock(monkeypatch):
    """可控的 _monotonic; 返 setter 让 test 推进虚拟时间。

    patch island_dispatch._monotonic 而非 time.monotonic，避免破坏 asyncio 内部时钟。
    """
    clock = {"t": 1000.0}
    monkeypatch.setattr(island_dispatch, "_monotonic", lambda: clock["t"])

    def advance(seconds: float) -> None:
        clock["t"] += seconds

    return advance


def _fire_received(internal_id: int = 500) -> None:
    """同步包装一次 dispatch_mail_received (固定 session_key=mailagent:email:<id>)。"""
    async def _scenario():
        island_dispatch.dispatch_mail_received(
            internal_id=internal_id, page_id="p", subject="s",
            sender_email="a@b.com", sender_name="A", mailbox="收件箱",
        )
        await asyncio.sleep(0.01)

    asyncio.run(_scenario())


def test_dedup_skips_same_key_within_window(patch_send, fake_store, fake_clock):
    """同 (session_key, event_type) 在窗口内重复 → 第 2 次 skip, send 只 1 次。"""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)
    _fire_received(internal_id=500)
    fake_clock(100)  # 100s < 300s 窗口
    _fire_received(internal_id=500)
    assert len(captured) == 1


def test_dedup_releases_after_window(patch_send, fake_store, fake_clock):
    """301s (> DEDUP_WINDOW_SEC=300) 后同 key 放行 → send 2 次。"""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)
    _fire_received(internal_id=500)
    fake_clock(301)  # 301s > 300s 窗口
    _fire_received(internal_id=500)
    assert len(captured) == 2


def test_dedup_does_not_block_different_event_type(patch_send, fake_store, fake_clock):
    """同 session_key 不同 event_type (MailReceived vs LLMReviewed) 互不挡。"""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    async def _scenario():
        # MailReceived (session_key=mailagent:email:500)
        island_dispatch.dispatch_mail_received(
            internal_id=500, page_id="p", subject="s",
            sender_email="a@b.com", sender_name="A", mailbox="收件箱",
        )
        # 同 internal_id 但 LLMReviewed event_type → key 不同, 放行
        island_dispatch.dispatch_llm_reviewed(
            internal_id=500, page_id="p", subject="s", sender_email="a@b.com",
            sender_name="A", mailbox="收件箱",
            priority="🟢 普通", action="仅供参考",
        )
        await asyncio.sleep(0.02)

    asyncio.run(_scenario())
    assert len(captured) == 2
    assert {e.event_type for e in captured} == {"MailReceived", "LLMReviewed"}


def test_dedup_allows_snooze_reemit(patch_send, fake_store, fake_clock):
    """snooze re-emit 间隔 ≥1h ≫ 300s → 同 LLMReviewedUrgent key 放行 (不被去重挡)。"""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)

    def _fire_urgent():
        async def _scenario():
            island_dispatch.dispatch_llm_reviewed(
                internal_id=501, page_id="p", subject="s", sender_email="a@b.com",
                sender_name="A", mailbox="收件箱",
                priority="🔴 紧急", action="需要回复",
            )
            await asyncio.sleep(0.01)
        asyncio.run(_scenario())

    _fire_urgent()
    fake_clock(3601)  # 1h+ 后 snooze re-emit
    _fire_urgent()
    assert len(captured) == 2


def test_dedup_dict_size_cap_clears(patch_send, fake_store, fake_clock):
    """去重 dict 超 _DEDUP_MAX_KEYS 时 clear, 防内存泄漏 (新 key 仍记得下)。"""
    captured, _ = patch_send
    island_dispatch.init(enabled=True, sync_store=fake_store)
    # 预填到 cap (用不同 internal_id 制造不同 key)
    for i in range(island_dispatch._DEDUP_MAX_KEYS):
        _fire_received(internal_id=10000 + i)
    assert len(island_dispatch._dedup_seen) == island_dispatch._DEDUP_MAX_KEYS
    # 再来一个新 key → 触发 clear 后只剩这一条
    _fire_received(internal_id=99999)
    assert len(island_dispatch._dedup_seen) == 1
