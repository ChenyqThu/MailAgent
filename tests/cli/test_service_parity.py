"""A2 parity: MailWriteService 输出 == 旧 fork-CLI golden (service-layer 重构安全网).

DoD: 证明把 ``email flag`` / ``email resync`` 的编排从 CLI 命令体下沉到
``MailWriteService`` 后, 输出形状**逐字段不变**。两层证据:

1. **golden 字面量**: service 直调的输出 == 旧 CLI emit 的 data 形状 (与
   tests/cli/test_email_flag.py / test_schema_contract.py 锚定的同一份 golden)。
2. **CLI == service 直调**: 同一输入下, CLI 命令 (现已走 service) emit 的 ``data``
   与 service 直调的结果**逐字节相同** —— 证明 CLI 薄壳无形状漂移。

seeded_db: internal_id=12345 (is_read=1/is_flagged=0/notion_page_id 已种), email_outbox 空。
"""

from __future__ import annotations

import shutil

import pytest

from tests.cli.conftest import extract_last_json_object as _extract


def _service_ctx(db_path):
    """ServiceContext 指向给定 db (serve-api in-process 写端点用的同一种 ctx)。"""
    from src.cli.config import load_cli_config
    from src.services.context import ServiceContext

    cfg = load_cli_config(flag_overrides={"sync_store_db_path": str(db_path)})
    return ServiceContext(cfg)


def _cli_actor():
    from src.services.guards import Actor

    return Actor(kind="cli", authenticated=True, label="cli")


def _flag_data_from_result(result):
    """按 CLI 适配器的方式把 FlagResult reshape 成 emit 的 data (含 not_found 条件键)。"""
    data = {
        "dry_run": False,
        "updated_ids": result.updated_ids,
        "payload": result.payload,
        "outbox_entries": result.outbox_entries,
    }
    if result.not_found:
        data["not_found"] = result.not_found
    return data


# ============================================================
# flag — golden 字面量
# ============================================================


def test_plan_flags_matches_golden(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).plan_flags([12345], is_read=True)
    assert plan == {
        "dry_run": True,
        "internal_ids": [12345],
        "payload": {"is_read": True},
        "would_enqueue": [
            {
                "internal_id": 12345,
                "mailapp_payload": {"is_read": True},
                "notion_payload": {"is_read": True},
            }
        ],
    }


def test_plan_flags_processing_status_excluded_from_mailapp(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).plan_flags(
        [12345], processing_status="已完成"
    )
    # MailAppFanout 不读 processing_status → mailapp_payload 为空。
    assert plan["payload"] == {"processing_status": "已完成"}
    assert plan["would_enqueue"][0]["mailapp_payload"] == {}
    assert plan["would_enqueue"][0]["notion_payload"] == {"processing_status": "已完成"}


def test_set_flags_matches_golden(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    result = MailWriteService(_service_ctx(seeded_db)).set_flags(
        [12345], is_flagged=True, actor=_cli_actor(), allow_concurrent=True
    )
    assert result.updated_ids == [12345]
    assert result.payload == {"is_flagged": True}
    assert result.not_found == []
    assert len(result.outbox_entries) == 1
    entry = result.outbox_entries[0]
    assert entry["internal_id"] == 12345
    assert entry["mailapp_outbox_id"] > 0
    assert entry["notion_outbox_id"] > 0
    # not_found 空 → reshape 后不出现该键 (历史形状)。
    assert "not_found" not in _flag_data_from_result(result)


def test_set_flags_not_found_matches_golden(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    result = MailWriteService(_service_ctx(seeded_db)).set_flags(
        [99999], is_read=True, actor=_cli_actor(), allow_concurrent=True
    )
    assert result.updated_ids == []
    assert result.not_found == [99999]
    assert _flag_data_from_result(result)["not_found"] == [99999]


def test_set_flags_processing_status_only_no_mailapp_outbox(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    result = MailWriteService(_service_ctx(seeded_db)).set_flags(
        [12345], processing_status="已完成", actor=_cli_actor(), allow_concurrent=True
    )
    entry = result.outbox_entries[0]
    assert entry["mailapp_outbox_id"] is None  # mailapp_payload 空 → 不入队
    assert entry["notion_outbox_id"] > 0


def test_set_flags_requires_authenticated_actor(cli_env, seeded_db):
    from src.services.errors import ServiceAuthError
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    with pytest.raises(ServiceAuthError):
        MailWriteService(_service_ctx(seeded_db)).set_flags(
            [12345], is_read=True,
            actor=Actor(kind="cli", authenticated=False), allow_concurrent=True,
        )


# ============================================================
# resync — golden 字面量
# ============================================================


def test_plan_resync_matches_golden(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).plan_resync(12345)
    assert plan == {
        "internal_id": 12345,
        "subject": "Hello Test",
        "current_page_id": "abc12345-0000-0000-0000-000000000001",
        "action": "create_or_skip",
        "would_replace": False,
        "skip_parent_lookup": False,
        "dry_run": True,
    }


def test_plan_resync_replace_action(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).plan_resync(
        12345, replace_existing=True
    )
    assert plan["action"] == "replace"
    assert plan["would_replace"] is True


def test_plan_resync_not_found_raises(cli_env, seeded_db):
    from src.services.errors import ServiceNotFoundError
    from src.services.mail_write import MailWriteService

    with pytest.raises(ServiceNotFoundError):
        MailWriteService(_service_ctx(seeded_db)).plan_resync(99999)


def test_resync_executed_maps_create_result(cli_env, seeded_db, monkeypatch):
    from src.notion._common import CreateEmailFromSqliteResult
    from src.services.mail_write import MailWriteService

    async def fake_create(self, internal_id, **kwargs):
        return CreateEmailFromSqliteResult(
            page_id="new-pg", action="created",
            existing_page_id=None, archived_page_id=None,
        )

    monkeypatch.setattr(
        "src.notion.sync.NotionSync.create_email_page_from_sqlite", fake_create
    )
    result = MailWriteService(_service_ctx(seeded_db)).resync(
        12345, actor=_cli_actor(), allow_concurrent=True
    )
    assert result.internal_id == 12345
    assert result.new_page_id == "new-pg"
    assert result.action == "created"
    # old_page_id = existing_page_id or meta.notion_page_id (12345 已种 notion_page_id)。
    assert result.old_page_id == "abc12345-0000-0000-0000-000000000001"
    assert result.archived_page_id is None


# ============================================================
# CLI (走 service) == service 直调 —— 证明薄壳无漂移
# ============================================================


def test_cli_flag_data_equals_service_direct(
    cli_runner, cli_env, seeded_db, tmp_path, monkeypatch
):
    from src.cli.main import app
    from src.services.mail_write import MailWriteService

    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")

    # service 直调先跑在干净副本上 (CLI 会改 seeded_db 的 outbox; 两边都从空 outbox 起,
    # outbox_id 自增序列一致 → 含 outbox_id 在内逐字段可比)。
    copy_db = tmp_path / "copy.db"
    shutil.copy(seeded_db, copy_db)
    res = MailWriteService(_service_ctx(copy_db)).set_flags(
        [12345], is_flagged=True, actor=_cli_actor(), allow_concurrent=True
    )
    data_svc = _flag_data_from_result(res)

    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "flag", "12345",
         "--is-flagged", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == data_svc


def test_cli_resync_dryrun_data_equals_service_direct(
    cli_runner, cli_env, seeded_db
):
    from src.cli.main import app
    from src.services.mail_write import MailWriteService

    # dry-run 只读 → 同一 DB 双跑无副作用。
    plan_svc = MailWriteService(_service_ctx(seeded_db)).plan_resync(12345)
    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "resync", "12345",
         "--dry-run", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == plan_svc


# ============================================================
# archive — golden 字面量 (A3)
# ============================================================


def _fake_archive_reader(moved=True):
    class _Reader:
        def __init__(self):
            self.calls = []

        def archive_inbox_message(self, message_id, fallback_uid=None, src_imap="INBOX"):
            # P4: archive_inbox_message 加 src_imap 泛化; 仍记 (message_id, fallback_uid)。
            self.calls.append((message_id, fallback_uid))
            return moved

    return _Reader()


def test_plan_archive_matches_golden(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).plan_archive(12345)
    assert plan == {
        "internal_id": 12345,
        "action": "archive",
        "from_mailbox": "收件箱",
        "to_mailbox": "存档",
        "message_id": "<msg-12345@example.com>",
        "has_imap_uid": False,  # seeded 无 imap_uid
        "notion_page_id": "abc12345-0000-0000-0000-000000000001",
        "dry_run": True,
    }


def test_plan_archive_not_found_raises(cli_env, seeded_db):
    from src.services.errors import ServiceNotFoundError
    from src.services.mail_write import MailWriteService

    with pytest.raises(ServiceNotFoundError):
        MailWriteService(_service_ctx(seeded_db)).plan_archive(99999)


def test_archive_already_archived_raises(cli_env, seeded_db):
    import sqlite3

    from src.services.errors import ServiceInvalidArgError
    from src.services.mail_write import MailWriteService

    conn = sqlite3.connect(str(seeded_db))
    conn.execute("UPDATE email_metadata SET mailbox='存档' WHERE internal_id=12345")
    conn.commit()
    conn.close()

    with pytest.raises(ServiceInvalidArgError):
        MailWriteService(_service_ctx(seeded_db)).archive(12345, actor=_cli_actor())


def test_archive_executed_matches_golden(cli_env, seeded_db, monkeypatch):
    from src.services.mail_write import MailWriteService

    reader = _fake_archive_reader(moved=True)
    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._folder_imap_reader",
        lambda self: reader,
    )
    notion_calls = []

    async def _fake_notion(self, page_id, mailbox):
        notion_calls.append((page_id, mailbox))

    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._update_notion_mailbox", _fake_notion
    )

    result = MailWriteService(_service_ctx(seeded_db)).archive(12345, actor=_cli_actor())
    assert result.internal_id == 12345
    assert result.from_mailbox == "收件箱"
    assert result.to_mailbox == "存档"
    assert result.notion_updated is True
    assert result.notion_error is None
    assert reader.calls == [("<msg-12345@example.com>", None)]
    assert notion_calls == [("abc12345-0000-0000-0000-000000000001", "存档")]


def test_archive_imap_failure_raises(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceError
    from src.services.mail_write import MailWriteService

    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._folder_imap_reader",
        lambda self: _fake_archive_reader(moved=False),
    )
    with pytest.raises(ServiceError):
        MailWriteService(_service_ctx(seeded_db)).archive(12345, actor=_cli_actor())


def test_archive_requires_authenticated_actor(cli_env, seeded_db):
    from src.services.errors import ServiceAuthError
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    with pytest.raises(ServiceAuthError):
        MailWriteService(_service_ctx(seeded_db)).archive(
            12345, actor=Actor(kind="cli", authenticated=False)
        )


# ============================================================
# pin — golden 字面量 (A3)
# ============================================================


def test_plan_pin_matches_golden(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).plan_pin(12345, pinned=True)
    assert plan == {
        "internal_id": 12345,
        "is_pinned": True,
        "changed": True,  # seeded is_pinned=0 → pin 改变
        "dry_run": True,
    }


def test_plan_unpin_already_unpinned_no_change(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).plan_pin(12345, pinned=False)
    # seeded is_pinned=0, unpin → changed=False (already != pinned → False != False)
    assert plan["is_pinned"] is False
    assert plan["changed"] is False


def test_set_pin_matches_golden(cli_env, seeded_db):
    from src.services.mail_write import MailWriteService

    result = MailWriteService(_service_ctx(seeded_db)).set_pin(
        12345, pinned=True, actor=_cli_actor()
    )
    assert result.internal_id == 12345
    assert result.is_pinned is True
    assert result.changed is True


def test_plan_pin_not_found_raises(cli_env, seeded_db):
    from src.services.errors import ServiceNotFoundError
    from src.services.mail_write import MailWriteService

    with pytest.raises(ServiceNotFoundError):
        MailWriteService(_service_ctx(seeded_db)).plan_pin(99999, pinned=True)


def test_set_pin_requires_authenticated_actor(cli_env, seeded_db):
    from src.services.errors import ServiceAuthError
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    with pytest.raises(ServiceAuthError):
        MailWriteService(_service_ctx(seeded_db)).set_pin(
            12345, pinned=True, actor=Actor(kind="cli", authenticated=False)
        )


# ============================================================
# llm run — golden 字面量 (A3)
# ============================================================


def _patch_llm_runner(monkeypatch, run_returns):
    """Mock LLMRunner.__init__/run_for_internal_id/close (service.run function-level
    import 拿 monkeypatched 类)。"""
    from src.llm_agent import runner as runner_mod

    async def fake_run(self, internal_id, *, dry_run=False, overwrite=True, force=False):
        return run_returns

    async def fake_close(self):
        return None

    def safe_init(self, *args, **kwargs):
        pass

    monkeypatch.setattr(runner_mod.LLMRunner, "__init__", safe_init)
    monkeypatch.setattr(runner_mod.LLMRunner, "run_for_internal_id", fake_run)
    monkeypatch.setattr(runner_mod.LLMRunner, "close", fake_close)


def test_llm_run_matches_golden(cli_env, seeded_db, monkeypatch):
    from src.services.llm_service import LlmService

    _patch_llm_runner(monkeypatch, {
        "ok": True, "internal_id": 12345,
        "page_id": "abc12345-0000-0000-0000-000000000001",
        "mailbox": "收件箱", "dry_run": False,
        "labels": {"category": "Action"}, "writer_summary": {"updated": 5},
    })
    result = LlmService(_service_ctx(seeded_db)).run(12345, actor=_cli_actor())
    assert result.internal_id == 12345
    assert result.page_id == "abc12345-0000-0000-0000-000000000001"
    assert result.mailbox == "收件箱"
    assert result.dry_run is False
    assert result.labels == {"category": "Action"}
    assert result.writer_summary == {"updated": 5}


def test_llm_run_not_found_raises(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceNotFoundError
    from src.services.llm_service import LlmService

    _patch_llm_runner(monkeypatch, {
        "ok": False, "internal_id": 12345,
        "error": "email not synced to Notion yet (notion_page_id empty)",
    })
    with pytest.raises(ServiceNotFoundError):
        LlmService(_service_ctx(seeded_db)).run(12345, actor=_cli_actor())


def test_llm_run_failed_raises(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceLLMFailedError
    from src.services.llm_service import LlmService

    _patch_llm_runner(monkeypatch, {
        "ok": False, "internal_id": 12345, "error": "gateway HTTP 500",
        "retry_count": 1, "status": "failed",
    })
    with pytest.raises(ServiceLLMFailedError):
        LlmService(_service_ctx(seeded_db)).run(12345, actor=_cli_actor())


def test_llm_run_dry_run_skips_auth(cli_env, seeded_db, monkeypatch):
    from src.services.guards import Actor
    from src.services.llm_service import LlmService

    _patch_llm_runner(monkeypatch, {
        "ok": True, "internal_id": 12345, "page_id": "p",
        "mailbox": "收件箱", "dry_run": True, "labels": {},
    })
    # dry_run=True → 不过 require_write_auth, 未鉴权 actor 也 OK (真跑 LLM 不写 Notion)。
    result = LlmService(_service_ctx(seeded_db)).run(
        12345, dry_run=True, actor=Actor(kind="cli", authenticated=False)
    )
    assert result.dry_run is True


def test_llm_run_requires_authenticated_actor(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceAuthError
    from src.services.guards import Actor
    from src.services.llm_service import LlmService

    _patch_llm_runner(monkeypatch, {"ok": True, "internal_id": 12345})
    with pytest.raises(ServiceAuthError):
        LlmService(_service_ctx(seeded_db)).run(
            12345, actor=Actor(kind="cli", authenticated=False)
        )


# ============================================================
# CLI (走 service) == service 直调 —— archive / pin dry-run 薄壳无漂移
# ============================================================


def test_cli_pin_dryrun_data_equals_service_direct(cli_runner, cli_env, seeded_db):
    from src.cli.main import app
    from src.services.mail_write import MailWriteService

    plan_svc = MailWriteService(_service_ctx(seeded_db)).plan_pin(12345, pinned=True)
    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "pin", "12345", "--dry-run", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == plan_svc


def test_cli_archive_dryrun_data_equals_service_direct(cli_runner, cli_env, seeded_db):
    from src.cli.main import app
    from src.services.mail_write import MailWriteService

    plan_svc = MailWriteService(_service_ctx(seeded_db)).plan_archive(12345)
    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "archive", "12345",
         "--dry-run", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == plan_svc


def test_cli_pin_executed_data_equals_service_direct(
    cli_runner, cli_env, seeded_db, tmp_path, monkeypatch
):
    from src.cli.main import app
    from src.services.mail_write import MailWriteService

    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")

    # service 直调跑在副本 (set_pin 写 is_pinned; 两边都从 is_pinned=0 起 → 逐字段可比)。
    copy_db = tmp_path / "copy.db"
    shutil.copy(seeded_db, copy_db)
    res = MailWriteService(_service_ctx(copy_db)).set_pin(
        12345, pinned=True, actor=_cli_actor()
    )
    data_svc = {
        "internal_id": res.internal_id,
        "is_pinned": res.is_pinned,
        "changed": res.changed,
        "dry_run": False,
    }

    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "pin", "12345", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == data_svc


def test_cli_archive_executed_data_equals_service_direct(
    cli_runner, cli_env, seeded_db, tmp_path, monkeypatch
):
    from src.cli.main import app
    from src.services.mail_write import MailWriteService

    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    # IMAP MOVE + Notion 镜像下沉为 service 私有方法 → 同一份 mock 覆盖 CLI 与直调两路。
    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._folder_imap_reader",
        lambda self: _fake_archive_reader(moved=True),
    )

    async def _fake_notion(self, page_id, mailbox):
        return None

    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._update_notion_mailbox", _fake_notion
    )

    # service 直调跑在副本 (archive 改 mailbox→存档; 防 CLI 先改后直调撞 already-archived)。
    copy_db = tmp_path / "copy.db"
    shutil.copy(seeded_db, copy_db)
    res = MailWriteService(_service_ctx(copy_db)).archive(12345, actor=_cli_actor())
    data_svc = {
        "internal_id": res.internal_id,
        "action": "archive",
        "success": True,
        "from_mailbox": res.from_mailbox,
        "to_mailbox": res.to_mailbox,
        "notion_updated": res.notion_updated,
        "notion_error": res.notion_error,
        "dry_run": False,
    }

    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "archive", "12345", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == data_svc


# ============================================================
# compose — golden 字面量 + CLI==service (A4)
# ============================================================


def _seed_reply(db_path, internal_id, reply_md):
    """seed llm_processing.labels_json.reply_suggestion_md (compose 正文来源 SSoT)。"""
    import json
    import sqlite3
    import time as _time

    from src.llm_agent.store import LLMProcessingStore

    LLMProcessingStore(str(db_path))  # _init 建 llm_processing 表
    conn = sqlite3.connect(str(db_path))
    labels = {"reply_suggestion_md": reply_md}
    now = _time.time()
    conn.execute(
        "INSERT INTO llm_processing (internal_id, status, labels_json, created_at, updated_at) "
        "VALUES (?, 'success', ?, ?, ?) "
        "ON CONFLICT(internal_id) DO UPDATE SET labels_json=excluded.labels_json, "
        "updated_at=excluded.updated_at",
        (internal_id, json.dumps(labels, ensure_ascii=False), now, now),
    )
    conn.commit()
    conn.close()


class _FakeComposeBackend:
    """fake IMailBackend: append_draft + send_email, 记录 DraftRequest。"""

    def __init__(self):
        self.appended = []
        self.sent = []

    def append_draft(self, draft):
        from src.mail.backend.types import DraftAppendResult

        self.appended.append(draft)
        return DraftAppendResult(
            success=True, drafts_folder="Drafts", appended_uid=42, method="imap_append",
        )

    def send_email(self, draft):
        from src.mail.backend.types import SendResult

        self.sent.append(draft)
        return SendResult(
            success=True, message_id="<sent-1@mailagent.local>", method="smtp_davmail",
        )


def _patch_compose_backend(monkeypatch, fake):
    """patch factory.create_backend → CLI (cli.backend) 与 service (ctx.backend) 同 fake。"""
    monkeypatch.setattr(
        "src.mail.backend.factory.create_backend", lambda *a, **k: fake
    )


_REPLY_MD = "Hi Alice,\n\nSounds good."


def test_compose_plan_matches_golden(cli_env, seeded_db):
    from src.services.mail_write import ComposeRequest, MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).compose_plan(
        ComposeRequest(internal_id=12345, mode="reply-all")
    )
    # 无 reply_suggestion → allow_missing_reply 放宽: reply_html 空, 收件人照常推导
    # (reply-all: sender alice + to_addr bob, self=test@example.com 不在内不排除)。
    assert plan["internal_id"] == 12345
    assert plan["mode"] == "reply-all"
    assert plan["to"] == ["alice@example.com", "bob@example.com"]
    assert plan["subject"] == "Re: Hello Test"
    assert plan["reply_source"] == "sqlite:llm_processing.labels_json"
    assert not plan["reply_html"]
    # 引用块单独走 quote_html (split_quote: TipTap 只载建议, 引用前端折叠)。
    assert "写道" in plan["quote_html"]
    assert "写道" not in (plan["reply_html"] or "")
    assert plan["dry_run"] is True


def test_compose_plan_forward_prefills_intro(cli_env, seeded_db):
    from src.services.mail_write import ComposeRequest, MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).compose_plan(
        ComposeRequest(internal_id=12345, mode="forward")
    )
    assert plan["mode"] == "forward"
    assert plan["subject"] == "Fwd: Hello Test"
    assert plan["forward_intro_html"] is not None
    assert "Forwarded message" in plan["forward_intro_html"]


def test_compose_plan_body_text_reply_source(cli_env, seeded_db):
    from src.services.mail_write import ComposeRequest, MailWriteService

    plan = MailWriteService(_service_ctx(seeded_db)).compose_plan(
        ComposeRequest(internal_id=12345, mode="reply", body_text="用户正文")
    )
    assert plan["reply_source"] == "body-file"


def test_compose_plan_not_found_raises(cli_env, seeded_db):
    from src.services.errors import ServiceNotFoundError
    from src.services.mail_write import ComposeRequest, MailWriteService

    with pytest.raises(ServiceNotFoundError):
        MailWriteService(_service_ctx(seeded_db)).compose_plan(
            ComposeRequest(internal_id=99999, mode="reply")
        )


def test_compose_draft_matches_golden(cli_env, seeded_db, monkeypatch):
    from src.services.mail_write import ComposeRequest, MailWriteService

    _seed_reply(seeded_db, 12345, _REPLY_MD)
    fake = _FakeComposeBackend()
    _patch_compose_backend(monkeypatch, fake)
    result = MailWriteService(_service_ctx(seeded_db)).compose_draft(
        ComposeRequest(internal_id=12345, mode="reply-all"), actor=_cli_actor()
    )
    assert result.internal_id == 12345
    assert result.drafts_folder == "Drafts"
    assert result.appended_uid == 42
    assert result.method == "imap_append"
    assert result.mode == "reply-all"
    assert result.to_count == 2  # alice + bob
    # backend.append_draft 真被调 + reply_text = suggestion + 原邮件引用 (Mail.app 行为)。
    assert len(fake.appended) == 1
    draft = fake.appended[0]
    assert draft.reply_text.startswith(_REPLY_MD)
    assert "写道" in draft.reply_text


def test_compose_draft_no_reply_raises(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceNotFoundError
    from src.services.mail_write import ComposeRequest, MailWriteService

    fake = _FakeComposeBackend()
    _patch_compose_backend(monkeypatch, fake)
    # execute (allow_missing_reply=False) 无 reply_suggestion → NotFound, 不发。
    with pytest.raises(ServiceNotFoundError):
        MailWriteService(_service_ctx(seeded_db)).compose_draft(
            ComposeRequest(internal_id=12345, mode="reply"), actor=_cli_actor()
        )
    assert fake.appended == []


def test_compose_draft_forward_requires_recipient(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceInvalidArgError
    from src.services.mail_write import ComposeRequest, MailWriteService

    fake = _FakeComposeBackend()
    _patch_compose_backend(monkeypatch, fake)
    # forward 无收件人 → InvalidArg (业务校验, 在 require_write_auth 之前)。
    with pytest.raises(ServiceInvalidArgError):
        MailWriteService(_service_ctx(seeded_db)).compose_draft(
            ComposeRequest(internal_id=12345, mode="forward"), actor=_cli_actor()
        )
    assert fake.appended == []


def test_compose_draft_requires_authenticated_actor(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceAuthError
    from src.services.guards import Actor
    from src.services.mail_write import ComposeRequest, MailWriteService

    _seed_reply(seeded_db, 12345, _REPLY_MD)
    _patch_compose_backend(monkeypatch, _FakeComposeBackend())
    with pytest.raises(ServiceAuthError):
        MailWriteService(_service_ctx(seeded_db)).compose_draft(
            ComposeRequest(internal_id=12345, mode="reply"),
            actor=Actor(kind="cli", authenticated=False),
        )


def test_send_matches_golden(cli_env, seeded_db, monkeypatch):
    from src.services.mail_write import ComposeRequest, MailWriteService

    _seed_reply(seeded_db, 12345, _REPLY_MD)
    fake = _FakeComposeBackend()
    _patch_compose_backend(monkeypatch, fake)
    result = MailWriteService(_service_ctx(seeded_db)).send(
        ComposeRequest(internal_id=12345, mode="reply-all"),
        actor=_cli_actor(), confirmed=True,
    )
    assert result.internal_id == 12345
    assert result.message_id == "<sent-1@mailagent.local>"
    assert result.method == "smtp_davmail"
    assert result.to_count == 2
    assert len(fake.sent) == 1


def test_send_unconfirmed_raises(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceInvalidArgError
    from src.services.mail_write import ComposeRequest, MailWriteService

    _seed_reply(seeded_db, 12345, _REPLY_MD)
    fake = _FakeComposeBackend()
    _patch_compose_backend(monkeypatch, fake)
    # confirmed=False → 二次确认拒绝 (对齐 json 模式无 --yes), 不发。
    with pytest.raises(ServiceInvalidArgError):
        MailWriteService(_service_ctx(seeded_db)).send(
            ComposeRequest(internal_id=12345, mode="reply"),
            actor=_cli_actor(), confirmed=False,
        )
    assert fake.sent == []


def test_send_requires_authenticated_actor(cli_env, seeded_db, monkeypatch):
    from src.services.errors import ServiceAuthError
    from src.services.guards import Actor
    from src.services.mail_write import ComposeRequest, MailWriteService

    _seed_reply(seeded_db, 12345, _REPLY_MD)
    _patch_compose_backend(monkeypatch, _FakeComposeBackend())
    with pytest.raises(ServiceAuthError):
        MailWriteService(_service_ctx(seeded_db)).send(
            ComposeRequest(internal_id=12345, mode="reply"),
            actor=Actor(kind="cli", authenticated=False), confirmed=True,
        )


def test_cli_draft_dryrun_data_equals_service_direct(cli_runner, cli_env, seeded_db):
    from src.cli.main import app
    from src.services.mail_write import ComposeRequest, MailWriteService

    # dry-run 只读 → 同一 DB 双跑无副作用。
    plan_svc = MailWriteService(_service_ctx(seeded_db)).compose_plan(
        ComposeRequest(internal_id=12345, mode="reply-all")
    )
    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "draft", "12345",
         "--dry-run", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == plan_svc


def test_cli_draft_execute_data_equals_service_direct(
    cli_runner, cli_env, seeded_db, monkeypatch
):
    from src.cli.main import app
    from src.services.mail_write import ComposeRequest, MailWriteService

    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    _seed_reply(seeded_db, 12345, _REPLY_MD)
    # append_draft 无 DB 副作用 → 同 db 双跑可比 (fake backend 恒返回同结果)。
    _patch_compose_backend(monkeypatch, _FakeComposeBackend())

    res = MailWriteService(_service_ctx(seeded_db)).compose_draft(
        ComposeRequest(internal_id=12345, mode="reply-all"), actor=_cli_actor()
    )
    data_svc = {
        "internal_id": res.internal_id, "success": True,
        "drafts_folder": res.drafts_folder, "appended_uid": res.appended_uid,
        "method": res.method, "mode": res.mode,
        "to_count": res.to_count, "cc_count": res.cc_count,
        "attachments": res.attachments, "warnings": res.warnings,
        "dry_run": False,
    }
    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "draft", "12345", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == data_svc


def test_cli_send_execute_data_equals_service_direct(
    cli_runner, cli_env, seeded_db, monkeypatch
):
    from src.cli.main import app
    from src.services.mail_write import ComposeRequest, MailWriteService

    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    _seed_reply(seeded_db, 12345, _REPLY_MD)
    _patch_compose_backend(monkeypatch, _FakeComposeBackend())

    res = MailWriteService(_service_ctx(seeded_db)).send(
        ComposeRequest(internal_id=12345, mode="reply-all"),
        actor=_cli_actor(), confirmed=True,
    )
    data_svc = {
        "internal_id": res.internal_id, "sent": True, "mode": res.mode,
        "message_id": res.message_id, "archived_to_sent": res.archived_to_sent,
        "method": res.method, "to_count": res.to_count, "cc_count": res.cc_count,
        "attachments": res.attachments, "warnings": res.warnings,
    }
    result_cli = cli_runner.invoke(
        app,
        ["--db-path", str(seeded_db), "email", "send", "12345", "--yes", "-o", "json"],
    )
    assert result_cli.exit_code == 0, result_cli.output
    data_cli = _extract(result_cli.output)["data"]

    assert data_cli == data_svc
