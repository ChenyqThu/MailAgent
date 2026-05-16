"""mailagent backfill body / derivatives tests (PR-5 US-001).

Inline implementation — no subprocess.run. Tests patch the internal helpers
directly inside src.cli.commands.backfill.

Covers:
- backfill body --dry-run (inline, mode=="inline")
- backfill body --since-date / --limit candidate selection
- backfill body --all with --since-date mutually exclusive
- backfill body missing filter → exit 2
- backfill body non-dry-run missing auth → exit 4
- backfill body partial_failure → exit 6
- backfill body max-failures circuit breaker → exit 8
- backfill body checkpoint resume (--resume-from skips lower ids)
- backfill body dead-letter (fetch returns None → success, dead=True)
- backfill derivatives --dry-run (inline)
- backfill derivatives --internal-id passthrough
- backfill derivatives non-dry-run missing auth → exit 4
"""

from __future__ import annotations

import sqlite3
import time
from unittest.mock import MagicMock, patch

from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "backfill", *args],
    )


# ---------------------------------------------------------------------------
# Shared mock factories
# ---------------------------------------------------------------------------

def _make_arm_mock(fetch_result: dict | None = None):
    """Return a mock AppleScriptArm that returns fetch_result from fetch_email_content_by_id."""
    arm = MagicMock()
    arm.fetch_email_content_by_id.return_value = fetch_result
    arm_cls = MagicMock(return_value=arm)
    return arm_cls, arm


def _make_reader_mock(email_obj=None):
    """Return a mock EmailReader.parse_email_source returning email_obj."""
    if email_obj is None:
        email_obj = MagicMock()
        email_obj.attachments = []
        email_obj.message_id = "<msg-12345@example.com>"
        email_obj.mailbox = "收件箱"
        email_obj.internal_id = 12345
    reader = MagicMock()
    reader.parse_email_source.return_value = email_obj
    reader_cls = MagicMock(return_value=reader)
    return reader_cls, reader


def _minimal_fetch_result():
    return {
        "source": b"From: alice@example.com\r\n\r\nHello",
        "message_id": "<msg-12345@example.com>",
        "thread_id": "<thread-1@example.com>",
    }


def _seed_synced_email(db_path, internal_id=99901, mailbox="收件箱",
                        date_received="2026-04-01 10:00:00"):
    """Insert a 'synced' email_metadata row into the DB for _pick_candidates to find."""
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys=ON")
    now = time.time()
    try:
        conn.execute(
            """INSERT OR IGNORE INTO email_metadata
               (internal_id, message_id, subject, sender, sender_name,
                to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
                sync_status, notion_page_id, retry_count, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'synced', 'page-abc', 0, ?, ?)""",
            (internal_id, f"<msg-{internal_id}@example.com>",
             f"Subject {internal_id}", "alice@example.com", "Alice",
             "bob@example.com", "", date_received, mailbox, now, now),
        )
        conn.commit()
    finally:
        conn.close()


# ============================================================
# backfill body
# ============================================================

class TestBackfillBody:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db):
        """dry-run with --limit 5: exits 0, data.mode=='inline', no subprocess."""
        arm_cls, arm = _make_arm_mock(_minimal_fetch_result())
        reader_cls, reader = _make_reader_mock()
        _seed_synced_email(seeded_db, internal_id=99901)

        with (
            patch("src.cli.commands.backfill.AppleScriptArm", arm_cls),
            patch("src.cli.commands.backfill.EmailReader", reader_cls),
            patch("src.cli.commands.backfill.EmailRepository.commit_email_with_body",
                  return_value={}),
            patch("src.cli.commands.backfill.build_storage_payloads",
                  return_value=(MagicMock(body_format="html", markdown="x",
                                          html="<p>x</p>", has_inline_images=False), [])),
            patch("src.notion.sync.NotionSync._convert_office_attachments",
                  return_value=[]),
        ):
            result = _invoke(
                cli_runner, "body", "--dry-run", "--limit", "5",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["action"] == "backfill-body"
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["dry_run"] is True

    def test_since_date_passthrough(self, cli_runner, cli_env, seeded_db):
        """--since-date / --until-date / --mailbox narrow the candidate list."""
        _seed_synced_email(seeded_db, internal_id=99902, date_received="2026-03-15 10:00:00")
        _seed_synced_email(seeded_db, internal_id=99903, date_received="2026-02-01 10:00:00")

        arm_cls, _ = _make_arm_mock(_minimal_fetch_result())
        reader_cls, _ = _make_reader_mock()

        with (
            patch("src.cli.commands.backfill.AppleScriptArm", arm_cls),
            patch("src.cli.commands.backfill.EmailReader", reader_cls),
            patch("src.cli.commands.backfill.build_storage_payloads",
                  return_value=(MagicMock(body_format="html", markdown="x",
                                          html="<p>x</p>", has_inline_images=False), [])),
            patch("src.notion.sync.NotionSync._convert_office_attachments",
                  return_value=[]),
        ):
            result = _invoke(
                cli_runner, "body", "--dry-run",
                "--since-date", "2026-03-01",
                "--until-date", "2026-03-31",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        # only 99902 falls inside the date window
        succeeded_ids = [s["internal_id"] for s in payload["data"]["succeeded"]]
        assert 99903 not in succeeded_ids, "99903 is outside the date range"

    def test_all_mutually_exclusive_with_filters(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(
            cli_runner, "body", "--all", "--since-date", "2026-03-01",
            "-o", "json", "--dry-run",
            db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_no_filter_no_all_rejects(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(
            cli_runner, "body", "--dry-run",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2
        payload = _xj(result.output)
        msg = payload["error"]["message"].lower()
        assert "filter" in msg or "all" in msg

    def test_non_dry_run_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        result = _invoke(
            cli_runner, "body", "--limit", "5",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 4
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"

    # ------------------------------------------------------------------
    # NEW: partial_failure → exit 6
    # ------------------------------------------------------------------
    def test_partial_failure_returns_exit_6(self, cli_runner, cli_env, seeded_db, monkeypatch):
        """Two candidates: first commit raises, second succeeds → exit 6, status partial_failure."""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")

        _seed_synced_email(seeded_db, internal_id=88801)
        _seed_synced_email(seeded_db, internal_id=88802)

        arm_cls, arm = _make_arm_mock(_minimal_fetch_result())
        reader_cls, _ = _make_reader_mock()

        call_count = {"n": 0}

        def _commit_side_effect(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("Notion API error for first unit")
            return {}

        with (
            patch("src.cli.commands.backfill.AppleScriptArm", arm_cls),
            patch("src.cli.commands.backfill.EmailReader", reader_cls),
            patch("src.cli.commands.backfill.EmailRepository.commit_email_with_body",
                  side_effect=_commit_side_effect),
            patch("src.cli.commands.backfill.build_storage_payloads",
                  return_value=(MagicMock(body_format="html", markdown="x",
                                          html="<p>x</p>", has_inline_images=False), [])),
            patch("src.notion.sync.NotionSync._convert_office_attachments",
                  return_value=[]),
        ):
            result = _invoke(
                cli_runner, "body",
                "--internal-ids", "88801,88802",
                "--max-failures", "10",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 6, result.output
        payload = _xj(result.output)
        assert payload["status"] == "partial_failure"
        assert payload["data"]["summary"]["succeeded"] == 1
        assert payload["data"]["summary"]["failed"] == 1

    # ------------------------------------------------------------------
    # NEW: max-failures circuit breaker → exit 8
    # ------------------------------------------------------------------
    def test_max_failures_circuit_breaker(self, cli_runner, cli_env, seeded_db, monkeypatch):
        """5 candidates all commit raises, --max-failures=2 → exit 8, E_MAX_FAILURES."""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")

        for iid in [77701, 77702, 77703, 77704, 77705]:
            _seed_synced_email(seeded_db, internal_id=iid)

        arm_cls, _ = _make_arm_mock(_minimal_fetch_result())
        reader_cls, _ = _make_reader_mock()

        with (
            patch("src.cli.commands.backfill.AppleScriptArm", arm_cls),
            patch("src.cli.commands.backfill.EmailReader", reader_cls),
            patch("src.cli.commands.backfill.EmailRepository.commit_email_with_body",
                  side_effect=RuntimeError("always fail")),
            patch("src.cli.commands.backfill.build_storage_payloads",
                  return_value=(MagicMock(body_format="html", markdown="x",
                                          html="<p>x</p>", has_inline_images=False), [])),
            patch("src.notion.sync.NotionSync._convert_office_attachments",
                  return_value=[]),
        ):
            result = _invoke(
                cli_runner, "body",
                "--internal-ids", "77701,77702,77703,77704,77705",
                "--max-failures", "2",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 8, result.output
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_MAX_FAILURES"
        assert payload["data"]["summary"]["max_failures_hit"] is True

    # ------------------------------------------------------------------
    # NEW: checkpoint resume skips lower ids
    # ------------------------------------------------------------------
    def test_checkpoint_resume(self, cli_runner, cli_env, seeded_db, monkeypatch):
        """4 candidates [10,20,30,40], --resume-from=25 → only 30,40 processed."""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")

        for iid in [10, 20, 30, 40]:
            _seed_synced_email(seeded_db, internal_id=iid)

        processed = []
        arm_cls, arm = _make_arm_mock(_minimal_fetch_result())
        reader_cls, _ = _make_reader_mock()

        def _tracking_fetch(iid, mailbox):
            processed.append(iid)
            return _minimal_fetch_result()

        arm.fetch_email_content_by_id.side_effect = _tracking_fetch

        with (
            patch("src.cli.commands.backfill.AppleScriptArm", arm_cls),
            patch("src.cli.commands.backfill.EmailReader", reader_cls),
            patch("src.cli.commands.backfill.EmailRepository.commit_email_with_body",
                  return_value={}),
            patch("src.cli.commands.backfill.build_storage_payloads",
                  return_value=(MagicMock(body_format="html", markdown="x",
                                          html="<p>x</p>", has_inline_images=False), [])),
            patch("src.notion.sync.NotionSync._convert_office_attachments",
                  return_value=[]),
        ):
            result = _invoke(
                cli_runner, "body",
                "--internal-ids", "10,20,30,40",
                "--resume-from", "25",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["summary"]["total"] == 2
        # Only ids > 25 should have been processed
        assert set(processed) <= {30, 40}

    # ------------------------------------------------------------------
    # NEW: dead-letter inline (fetch returns None → success with dead=True)
    # ------------------------------------------------------------------
    def test_dead_letter_inline(self, cli_runner, cli_env, seeded_db, monkeypatch):
        """fetch returns None → unit returns dead=True (counts as success, not failure)."""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")

        _seed_synced_email(seeded_db, internal_id=66601)

        # Arm returns None → dead
        arm_cls, arm = _make_arm_mock(None)
        reader_cls, _ = _make_reader_mock()

        with (
            patch("src.cli.commands.backfill.AppleScriptArm", arm_cls),
            patch("src.cli.commands.backfill.EmailReader", reader_cls),
        ):
            result = _invoke(
                cli_runner, "body",
                "--internal-ids", "66601",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["summary"]["succeeded"] == 1
        assert payload["data"]["summary"]["failed"] == 0
        # Verify the dead=True flag appears in the succeeded row
        dead_rows = [s for s in payload["data"]["succeeded"] if s.get("dead")]
        assert len(dead_rows) == 1

        # Also verify the backfill_dead_ids table was written
        conn = sqlite3.connect(str(seeded_db))
        try:
            row = conn.execute(
                "SELECT internal_id FROM backfill_dead_ids WHERE internal_id=66601"
            ).fetchone()
        finally:
            conn.close()
        assert row is not None, "backfill_dead_ids row should have been inserted"


# ============================================================
# backfill derivatives
# ============================================================

class TestBackfillDerivatives:
    def test_dry_run_smoke(self, cli_runner, cli_env, seeded_db):
        """dry-run with no candidates: exits 0, data.mode=='inline'."""
        with patch("src.cli.commands.backfill._find_candidates", return_value=[]):
            result = _invoke(
                cli_runner, "derivatives", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["action"] == "backfill-derivatives"
        assert payload["data"]["mode"] == "inline"

    def test_internal_id_passthrough(self, cli_runner, cli_env, seeded_db):
        """--internal-id filters candidates to that internal_id."""
        captured = {}

        def _fake_find(db_path, internal_id_filter=None):
            captured["filter"] = internal_id_filter
            return []

        with patch("src.cli.commands.backfill._find_candidates", side_effect=_fake_find):
            result = _invoke(
                cli_runner, "derivatives", "--internal-id", "53677", "--dry-run",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        assert captured["filter"] == 53677

    def test_non_dry_run_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        with patch("src.cli.commands.backfill._find_candidates", return_value=[]):
            result = _invoke(
                cli_runner, "derivatives",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 4
        payload = _xj(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"
