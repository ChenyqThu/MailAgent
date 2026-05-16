"""E2E coverage for ``mailagent llm compare-paths`` (PR-5 US-005)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from src.cli.main import app
from src.llm_agent.processor import AILabels, LLMProcessor
from src.models import Email
from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    return cli_runner.invoke(
        app,
        ["--db-path", str(db_path), "llm", "compare-paths", *args],
    )


class TestLLMComparePaths:
    def test_dry_run_default(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["mode"] == "dry_run"
        assert payload["data"]["plan"]["mode"] == "dry_run"
        assert "cost_preview" in payload["data"]

    def test_dry_run_with_internal_ids(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner,
            "--internal-ids",
            "1,2,3",
            "-o",
            "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["sample_size"] == 3
        assert payload["data"]["internal_ids"] == [1, 2, 3]

    def test_real_run_requires_yes(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner,
            "--no-dry-run",
            "--count",
            "2",
            "-o",
            "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_real_run_with_yes_mocked(
        self,
        cli_runner,
        cli_env,
        seeded_db,
        monkeypatch,
    ):
        from src.cli.commands import llm as llm_cmd

        labels = AILabels(
            category="x",
            action_type="x",
            priority="x",
            action_required=True,
            sender_priority="x",
            language="x",
            daily_digest_date="2026-05-16",
            model="claude-sonnet-4-6",
        )
        process_mock = AsyncMock(side_effect=[labels, labels, labels, labels])
        monkeypatch.setattr(LLMProcessor, "process_email", process_mock)

        fake_arm = MagicMock()
        fake_arm.fetch_email_content_by_id.return_value = {
            "source": "Subject: test\n\n<p>body html</p>",
            "message_id": "<msg-12345@example.com>",
        }
        monkeypatch.setattr(llm_cmd, "AppleScriptArm", MagicMock(return_value=fake_arm))

        fake_reader = MagicMock()

        def _parse_email(*args, **kwargs):
            return Email(
                message_id="<msg-12345@example.com>",
                subject="test",
                sender="alice@example.com",
                content="<p>body html</p>",
                content_type="text/html",
            )

        fake_reader.parse_email_source.side_effect = _parse_email
        monkeypatch.setattr(llm_cmd, "EmailReader", MagicMock(return_value=fake_reader))

        fake_store = MagicMock()
        fake_store.db_path = str(seeded_db)
        fake_store.attachment_store = MagicMock()
        monkeypatch.setattr(llm_cmd, "AttachmentStore", MagicMock())
        monkeypatch.setattr(llm_cmd, "EmailRepository", MagicMock(return_value=fake_store))
        monkeypatch.setattr(llm_cmd, "_pick_internal_ids", lambda count, db: [12345, 12345])

        result = _invoke(
            cli_runner,
            "--no-dry-run",
            "--yes",
            "--count",
            "2",
            "-o",
            "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["mode"] == "inline"
        assert len(payload["data"]["results"]) == 2
        assert payload["data"]["summary"]["all_match_pct"] == 100.0
        assert payload["data"]["summary"]["verdict"] == "pass"
        assert process_mock.await_count == 4

    def test_count_invalid_zero(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner,
            "--count",
            "0",
            "-o",
            "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
