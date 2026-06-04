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
