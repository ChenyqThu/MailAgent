"""docs/cli-schema/ ↔ 实际 CLI JSON 输出 契约一致性 (PR-2 critic round 3 follow-up).

每次 CLI emit 的 wrapper 必须能被对应 schema 验证。 防止 schema 文件偏离 emit() 真实行为
(round-3 bug 就是 email resync emit 了 archived_page_id 但 schema additionalProperties:false 拒之)。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


SCHEMA_DIR = Path(__file__).resolve().parents[2] / "docs" / "cli-schema"


@pytest.fixture
def schema_loader():
    """Return a callable that loads a schema by filename + injects ``_common`` $defs.

    我们的 schema 用 ``$ref: _common.schema.json#/$defs/...``。jsonschema 默认不解析
    跨文件 $ref, 这里手动把 _common 注册进 RegistryResolver。
    """
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    common_path = SCHEMA_DIR / "_common.schema.json"
    common_doc = json.loads(common_path.read_text())
    common_resource = Resource(contents=common_doc, specification=DRAFT202012)
    registry = Registry().with_resource(
        uri="_common.schema.json", resource=common_resource,
    )

    def _load(name: str) -> tuple[dict, Registry]:
        schema = json.loads((SCHEMA_DIR / name).read_text())
        return schema, registry

    return _load


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


class TestSchemaContract:
    """每个 leaf 命令的实际 -o json 输出走 jsonschema 验证."""

    def test_email_get_success_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "get", "12345", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-get.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_email_list_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "list", "--limit", "5", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_email_search_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "search", "redis", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-search.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_email_body_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "body", "12345",
                         "--format", "markdown", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-body.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_email_resync_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "email", "resync", "12345", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("email-resync.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_admin_health_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "admin", "health", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-health.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_admin_db_version_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "admin", "db-version", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-db-version.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_admin_stats_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "admin", "stats", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("admin-stats.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-001: attachment list / download / derive
    # ============================================================

    def test_attachment_list_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "attachment", "list", "12345", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("attachment-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_attachment_list_not_found_matches_error_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "attachment", "list", "99999",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1
        payload = _last_json(result.output)
        schema, registry = schema_loader("attachment-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_attachment_download_with_dest_matches_schema(
        self, cli_runner, seeded_db_with_real_attachment,
        monkeypatch, tmp_path, schema_loader,
    ):
        from jsonschema import validate

        db_path, _, att_id = seeded_db_with_real_attachment
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")
        dest = tmp_path / "outdir" / "x.bin"
        dest.parent.mkdir()
        result = _invoke(cli_runner, "attachment", "download", str(att_id),
                         "--dest", str(dest), "-o", "json", db_path=db_path)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("attachment-download.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_attachment_derive_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "attachment", "derive", "12345",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("attachment-derive.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-002: attachment cleanup-orphans
    # ============================================================

    def test_attachment_cleanup_orphans_matches_schema(
        self, cli_runner, cli_env, seeded_db, monkeypatch, tmp_path, schema_loader,
    ):
        from jsonschema import validate

        monkeypatch.setenv("ATTACHMENT_STORAGE_DIR", str(tmp_path / "att-co"))
        result = _invoke(cli_runner, "attachment", "cleanup-orphans",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader(
            "attachment-cleanup-orphans.schema.json"
        )
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-003 / US-004: llm
    # ============================================================

    def test_llm_run_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate
        from src.llm_agent import runner as runner_mod

        async def fake_run(self, internal_id, *, dry_run=False, overwrite=True,
                           force=False):
            return {
                "ok": True, "internal_id": internal_id, "page_id": "p",
                "mailbox": "收件箱", "dry_run": dry_run, "labels": {"x": 1},
            }

        async def fake_close(self):
            return None

        def safe_init(self, *args, **kwargs):
            self._processor = None
            self._writer = None
            self._store = None
            self._arm = None
            self._reader = None

        monkeypatch.setattr(runner_mod.LLMRunner, "__init__", safe_init)
        monkeypatch.setattr(runner_mod.LLMRunner, "run_for_internal_id", fake_run)
        monkeypatch.setattr(runner_mod.LLMRunner, "close", fake_close)

        # E1 §3.1 Step 3: `llm run` 经 LlmService._maybe_davmail_backend, davmail
        # 模式下会在 LLMRunner 构造前真连 IMAP probe —— 中和成 None, 保持 hermetic。
        from src.services.llm_service import LlmService
        monkeypatch.setattr(LlmService, "_maybe_davmail_backend", lambda self: None)

        result = _invoke(cli_runner, "llm", "run", "12345", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-run.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_llm_selftest_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate

        monkeypatch.setenv("LLM_API_KEY", "k")
        monkeypatch.setenv("LLM_API_BASE", "https://e")
        monkeypatch.setenv("LLM_MODEL", "m")
        result = _invoke(cli_runner, "llm", "selftest", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-selftest.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_llm_retry_failed_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "llm", "retry-failed", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-retry-failed.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_llm_stats_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "llm", "stats", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-stats.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_kos_stats_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "kos", "stats", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("kos-stats.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_llm_compare_paths_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "llm", "compare-paths", "--count", "10",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("llm-compare-paths.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-005 / US-006: notion
    # ============================================================

    def test_notion_update_flag_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "notion", "update-flag", "12345",
            "--is-read", "true", "--dry-run", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("notion-update-flag.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_notion_archive_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "notion", "archive", "some-page-id",
            "--dry-run", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("notion-archive.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_notion_page_orphans_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate
        from src.notion import client as client_mod

        class StubDS:
            async def query(self, **kwargs):
                return {"results": [], "has_more": False, "next_cursor": None}

        class StubClient:
            def __init__(self, *args, **kwargs):
                self.email_db_id = "x"
                self.client = type("P", (), {})()
                self.client.pages = type("X", (), {})()
                self.client.data_sources = StubDS()

            async def get_data_source_id(self, db_id):
                return "ds-id"

            async def query_database(self, **kwargs):
                return []

            async def close(self):
                return None

        monkeypatch.setattr(client_mod, "NotionClient", StubClient)
        result = _invoke(cli_runner, "notion", "page-orphans",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("notion-page-orphans.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_notion_file_link_audit_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "notion", "file-link-audit",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("notion-file-link-audit.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-007: calendar
    # ============================================================

    def test_calendar_expand_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate
        from src.mail.sync_store import SyncStore

        monkeypatch.setattr(
            SyncStore, "iter_series_needing_expansion",
            lambda self, c: iter([]),
        )
        result = _invoke(cli_runner, "calendar", "expand", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-expand.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_calendar_recurring_discover_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate

        async def fake_discover(*args, **kwargs):
            return []
        import src.calendar_notion.recurring_invite as rr_mod
        monkeypatch.setattr(rr_mod, "discover_recurring", fake_discover)
        # Phase 1.5: discover 不再走 backend factory, 不需要 stub CliContext.backend
        result = _invoke(cli_runner, "calendar", "recurring", "discover",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-recurring-discover.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_calendar_recurring_replay_dry_run_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(
            cli_runner, "calendar", "recurring", "replay",
            "53120", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-recurring-replay.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    # ============================================================
    # PR-3 US-008: debug
    # ============================================================

    def test_debug_email_source_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate
        from src.mail import applescript_arm

        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "__init__",
            lambda self, *a, **kw: None,
        )
        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "fetch_email_content_by_id",
            lambda self, iid, mb: {"source": "ok", "message_id": "<x>"},
        )
        result = _invoke(cli_runner, "debug", "email-source", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("debug-email-source.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_debug_mail_structure_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate
        from src.mail import applescript

        monkeypatch.setattr(
            applescript.AppleScriptExecutor, "execute",
            staticmethod(lambda *a, **kw: "iCloud"),
        )
        result = _invoke(cli_runner, "debug", "mail-structure", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("debug-mail-structure.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_debug_inline_images_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate

        result = _invoke(cli_runner, "debug", "inline-images", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("debug-inline-images.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_debug_applescript_fetch_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate
        from src.mail import applescript_arm

        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "__init__",
            lambda self, *a, **kw: None,
        )
        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "fetch_email_content_by_id",
            lambda self, iid, mb: {
                "source": "abc", "message_id": "<x>",
                "subject": "s", "sender": "a", "attachments": [],
            },
        )
        result = _invoke(cli_runner, "debug", "applescript-fetch", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("debug-applescript-fetch.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_debug_notion_page_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from jsonschema import validate
        from src.notion import client as client_mod

        class StubPages:
            async def retrieve(self, *, page_id):
                return {
                    "id": page_id, "archived": False,
                    "created_time": "2026-05-01T00:00:00.000Z",
                    "last_edited_time": "2026-05-15T00:00:00.000Z",
                    "url": f"https://www.notion.so/{page_id}",
                    "properties": {},
                }

        class StubClient:
            def __init__(self, *args, **kwargs):
                self.client = type("X", (), {"pages": StubPages()})()

            async def close(self):
                return None

        monkeypatch.setattr(client_mod, "NotionClient", StubClient)
        result = _invoke(cli_runner, "debug", "notion-page", "p-1",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("debug-notion-page.schema.json")
        validate(instance=payload, schema=schema, registry=registry)


from tests.cli.conftest import extract_last_json_object as _last_json  # noqa: E402


# ============================================================
# Phase 2 §2.2 — calendar events / today / week / event-get / sync-status / sync-now
# ============================================================

class TestCalendarPhase2SchemaContract:
    """Phase 2 新 CLI 输出 schema 契约 verification."""

    @staticmethod
    def _seed_event(db_path, **kwargs):
        from datetime import datetime, timedelta, timezone
        from src.calendar_sync.caldav_reader import CalendarEvent
        from src.calendar_sync import CalendarEventRepository

        start = kwargs.pop("start", datetime(2026, 5, 22, 9, 0, tzinfo=timezone.utc))
        ev = CalendarEvent(
            summary=kwargs.pop("summary", "Test"),
            start=start, end=start + timedelta(hours=1),
            ical_uid=kwargs.pop("ical_uid", "uid-1"),
            calendar_name=kwargs.pop("calendar_name", "Personal"),
            rrule=kwargs.pop("rrule", ""),
        )
        repo = CalendarEventRepository(str(db_path))
        return repo.upsert_from_caldav_event(
            ev, source=kwargs.pop("source", "caldav"),
        )

    def test_calendar_events_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate
        self._seed_event(seeded_db)
        result = _invoke(cli_runner, "calendar", "events",
                         "--from", "2026-05-01", "--to", "2026-07-01",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-events-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_calendar_today_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate
        result = _invoke(cli_runner, "calendar", "today",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-events-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_calendar_week_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate
        result = _invoke(cli_runner, "calendar", "week",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-events-list.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_calendar_event_get_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate
        self._seed_event(seeded_db, ical_uid="get-me")
        result = _invoke(cli_runner, "calendar", "event-get", "get-me",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-event-get.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_calendar_event_get_not_found_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        """error wrapper 也应 schema-conformant."""
        from jsonschema import validate
        result = _invoke(cli_runner, "calendar", "event-get", "nope-uid",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code != 0
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-event-get.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_calendar_sync_status_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader,
    ):
        from jsonschema import validate
        from src.calendar_sync import CalendarEventRepository
        # Seed 一行 sync_state
        repo = CalendarEventRepository(str(seeded_db))
        repo.upsert_sync_state("Personal", ctag="ctag-1", full_sync=True)

        result = _invoke(cli_runner, "calendar", "sync-status",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-sync-status.schema.json")
        validate(instance=payload, schema=schema, registry=registry)

    def test_calendar_sync_now_matches_schema(
        self, cli_runner, cli_env, seeded_db, schema_loader, monkeypatch,
    ):
        from datetime import datetime, timezone
        from jsonschema import validate
        from src.calendar_sync.caldav_reader import CalendarEvent, CalDAVReader

        stub_ev = CalendarEvent(
            summary="Stub", start=datetime(2026, 6, 1, 9, tzinfo=timezone.utc),
            end=datetime(2026, 6, 1, 10, tzinfo=timezone.utc),
            ical_uid="stub-1", calendar_name="StubCal",
        )
        monkeypatch.setattr(
            CalDAVReader, "list_calendar_names_for_sync",
            lambda self: ["StubCal"],
        )
        monkeypatch.setattr(
            CalDAVReader, "list_events_with_full_detail",
            lambda self, ws, we, *, calendar_name=None: [stub_ev],
        )
        monkeypatch.setattr(
            CalDAVReader, "get_collection_ctag",
            lambda self, cal: "fake-ctag",
        )
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")

        result = _invoke(cli_runner, "calendar", "sync-now",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        schema, registry = schema_loader("calendar-sync-now.schema.json")
        validate(instance=payload, schema=schema, registry=registry)
