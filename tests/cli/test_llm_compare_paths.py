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


def _mock_compare_result(internal_id: int, *, all_match: bool = True) -> dict:
    diff = {
        key: ("same", "same" if all_match else "different", all_match)
        for key in (
            "category",
            "action_type",
            "priority",
            "action_required",
            "sender_priority",
            "language",
            "daily_digest_date",
        )
    }
    return {
        "internal_id": internal_id,
        "subject": f"mail {internal_id}",
        "mailbox": "收件箱",
        "ok": True,
        "fallback_text_len": 100,
        "sqlite_md_len": 120,
        "model_a": "test-model",
        "model_b": "test-model",
        "diff": diff,
        "all_match": all_match,
    }


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

    def test_dry_run_no_candidates(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        from src.cli.commands import llm as llm_cmd

        monkeypatch.setattr(llm_cmd, "_pick_internal_ids", lambda count, db: [])

        result = _invoke(cli_runner, "-o", "json", db_path=seeded_db)

        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["sample_size"] == 0
        assert payload["data"]["internal_ids"] == []
        assert payload["data"]["cost_preview"]["total_emails"] == 0

    def test_dry_run_cost_preview_internal_ids(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(
            cli_runner,
            "--internal-ids",
            "1,2,3,4,5",
            "-o",
            "json",
            db_path=seeded_db,
        )

        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        preview = payload["data"]["cost_preview"]
        assert payload["data"]["sample_size"] == 5
        assert payload["data"]["internal_ids"] == [1, 2, 3, 4, 5]
        assert preview["total_emails"] == 5
        assert preview["estimated_total_tokens"] == 11_000
        assert preview["estimated_cost_usd"] == 0.033

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

    def test_real_run_partial_failure(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        from src.cli.commands import llm as llm_cmd

        async def fake_compare_one(internal_id, arm, reader, store):
            results = {
                1: _mock_compare_result(1, all_match=True),
                2: _mock_compare_result(2, all_match=False),
                3: {
                    "internal_id": 3,
                    "ok": False,
                    "error": "metadata not found",
                },
            }
            return results[internal_id]

        monkeypatch.setattr(llm_cmd, "_ensure_compare_deps", lambda: None)
        monkeypatch.setattr(llm_cmd, "AppleScriptArm", MagicMock())
        monkeypatch.setattr(llm_cmd, "EmailReader", MagicMock())
        monkeypatch.setattr(llm_cmd, "AttachmentStore", MagicMock())
        monkeypatch.setattr(llm_cmd, "EmailRepository", MagicMock())
        monkeypatch.setattr(llm_cmd, "_compare_one", fake_compare_one)

        result = _invoke(
            cli_runner,
            "--no-dry-run",
            "--yes",
            "--internal-ids",
            "1,2,3",
            "-o",
            "json",
            db_path=seeded_db,
        )

        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        summary = payload["data"]["summary"]
        assert summary["ok_count"] == 2
        assert summary["total"] == 3
        assert summary["all_match_pct"] == 50.0
        assert summary["verdict"] == "fail"

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
