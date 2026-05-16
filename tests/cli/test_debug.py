"""CLI debug 子命令测试 (RFC v2 §4.11, PR-3 US-008)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


def _patch_arm(monkeypatch, *, fetch_returns=None, raise_exc=None):
    """Stub AppleScriptArm.fetch_email_content_by_id."""
    from src.mail import applescript_arm

    monkeypatch.setattr(
        applescript_arm.AppleScriptArm, "__init__",
        lambda self, *a, **kw: None,
    )

    def fake_fetch(self, internal_id, mailbox):
        if raise_exc:
            raise raise_exc
        return fetch_returns

    monkeypatch.setattr(
        applescript_arm.AppleScriptArm, "fetch_email_content_by_id",
        fake_fetch,
    )


# ============================================================
# email-source
# ============================================================

class TestDebugEmailSource:
    def test_stdout_text(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_arm(monkeypatch, fetch_returns={
            "source": "From: alice@example.com\r\n\r\nbody bytes",
            "message_id": "<m@example.com>",
        })
        result = _invoke(cli_runner, "debug", "email-source", "12345",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert "From: alice@example.com" in result.output

    def test_json_size(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_arm(monkeypatch, fetch_returns={
            "source": "abcde",
            "message_id": "<x>",
        })
        result = _invoke(cli_runner, "debug", "email-source", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["size_bytes"] == 5
        assert payload["data"]["source"] == "abcde"

    def test_save_to(self, cli_runner, cli_env, seeded_db, monkeypatch, tmp_path):
        _patch_arm(monkeypatch, fetch_returns={
            "source": "hello", "message_id": "<x>",
        })
        out = tmp_path / "out" / "src.eml"
        out.parent.mkdir()
        result = _invoke(
            cli_runner, "debug", "email-source", "12345",
            "--save-to", str(out), "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["dest_path"] == str(out.resolve())
        assert out.read_text() == "hello"
        # source field should NOT be present when --save-to writes
        assert "source" not in payload["data"]

    def test_not_found(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "debug", "email-source", "99999",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_fetch_unavailable(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_arm(monkeypatch, raise_exc=RuntimeError("Mail.app not running"))
        result = _invoke(cli_runner, "debug", "email-source", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"


# ============================================================
# mail-structure
# ============================================================

class TestDebugMailStructure:
    def test_with_stub(self, cli_runner, cli_env, seeded_db, monkeypatch):
        from src.mail import applescript

        call_count = [0]

        def fake_execute(script, *args, **kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return "iCloud, Work"
            return "INBOX, Sent, Drafts"

        monkeypatch.setattr(
            applescript.AppleScriptExecutor, "execute",
            staticmethod(fake_execute),
        )
        result = _invoke(cli_runner, "debug", "mail-structure", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_accounts"] == 2
        assert payload["data"]["accounts"] == ["iCloud", "Work"]
        assert payload["data"]["total_mailboxes"] == 3

    def test_applescript_fails(self, cli_runner, cli_env, seeded_db, monkeypatch):
        from src.mail import applescript

        def fake_execute(*args, **kwargs):
            raise RuntimeError("osascript not installed")

        monkeypatch.setattr(
            applescript.AppleScriptExecutor, "execute",
            staticmethod(fake_execute),
        )
        result = _invoke(cli_runner, "debug", "mail-structure", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 1
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"


# ============================================================
# inline-images
# ============================================================

class TestDebugInlineImages:
    def _seed_inline_image_row(self, db_path: Path):
        """fixture seeded body html is `<p>body html</p>` w/o cid; add cid + att row."""
        now = 1736300000.0
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "UPDATE email_body SET body_html = ?, has_inline_images = 1 "
                "WHERE internal_id = 12345",
                ('<p>before <img src="cid:logo123"> after</p>',),
            )
            conn.execute(
                """INSERT INTO email_attachment
                     (internal_id, content_id, filename, content_type,
                      size_bytes, is_inline, local_path, sha256,
                      derived_from, derived_format, created_at, schema_version)
                   VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, NULL, ?, 1)""",
                (
                    12345, "logo123", "logo.png", "image/png", 256,
                    "data/attachments/12345/logo.png", "deadbeef", now,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def test_with_match(self, cli_runner, cli_env, seeded_db):
        self._seed_inline_image_row(seeded_db)
        result = _invoke(cli_runner, "debug", "inline-images", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_refs"] == 1
        assert payload["data"]["total_matched"] == 1
        assert payload["data"]["inline_refs"][0]["cid"] == "logo123"
        assert payload["data"]["inline_refs"][0]["matched"] is True
        assert payload["data"]["inline_refs"][0]["filename"] == "logo.png"

    def test_no_body(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "debug", "inline-images", "12346",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"


# ============================================================
# applescript-fetch
# ============================================================

class TestDebugApplescriptFetch:
    def test_found(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_arm(monkeypatch, fetch_returns={
            "source": "x" * 200,
            "message_id": "<m@example.com>",
            "subject": "Hello",
            "sender": "alice@example.com",
            "attachments": [],
        })
        result = _invoke(cli_runner, "debug", "applescript-fetch", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["found"] is True
        assert payload["data"]["source_size_bytes"] == 200
        assert payload["data"]["subject"] == "Hello"

    def test_not_found_returns_zero_size(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        _patch_arm(monkeypatch, fetch_returns=None)
        result = _invoke(cli_runner, "debug", "applescript-fetch", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["found"] is False
        assert payload["data"]["source_size_bytes"] == 0

    def test_arm_raises(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_arm(monkeypatch, raise_exc=RuntimeError("FDA denied"))
        result = _invoke(cli_runner, "debug", "applescript-fetch", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_mailbox_override(self, cli_runner, cli_env, seeded_db, monkeypatch):
        captured = {}
        from src.mail import applescript_arm

        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "__init__",
            lambda self, *a, **kw: None,
        )

        def fake_fetch(self, internal_id, mailbox):
            captured["mailbox"] = mailbox
            return {"source": "x", "message_id": "<x>", "subject": "s",
                    "sender": "a", "attachments": []}

        monkeypatch.setattr(
            applescript_arm.AppleScriptArm, "fetch_email_content_by_id",
            fake_fetch,
        )
        result = _invoke(
            cli_runner, "debug", "applescript-fetch", "12345",
            "--mailbox", "归档", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0
        assert captured["mailbox"] == "归档"


# ============================================================
# notion-page
# ============================================================

class TestDebugNotionPage:
    def test_happy(self, cli_runner, cli_env, seeded_db, monkeypatch):
        from src.notion import client as client_mod

        class StubPages:
            async def retrieve(self, *, page_id):
                return {
                    "id": page_id,
                    "archived": False,
                    "created_time": "2026-05-01T00:00:00.000Z",
                    "last_edited_time": "2026-05-15T00:00:00.000Z",
                    "url": f"https://www.notion.so/{page_id.replace('-', '')}",
                    "properties": {
                        "Subject": {
                            "type": "title",
                            "title": [{"plain_text": "Hello"}],
                        },
                        "Is Read": {"type": "checkbox", "checkbox": True},
                    },
                }

        class StubClient:
            def __init__(self):
                self.client = type("X", (), {"pages": StubPages()})()

            async def close(self):
                return None

        monkeypatch.setattr(client_mod, "NotionClient", StubClient)
        result = _invoke(cli_runner, "debug", "notion-page", "page-xyz",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["page_id"] == "page-xyz"
        assert payload["data"]["properties_summary"]["Subject"] == "Hello"
        assert payload["data"]["properties_summary"]["Is Read"] is True

    def test_retrieve_fails(self, cli_runner, cli_env, seeded_db, monkeypatch):
        from src.notion import client as client_mod

        class StubPages:
            async def retrieve(self, *, page_id):
                raise RuntimeError("404 not found")

        class StubClient:
            def __init__(self):
                self.client = type("X", (), {"pages": StubPages()})()

            async def close(self):
                return None

        monkeypatch.setattr(client_mod, "NotionClient", StubClient)
        result = _invoke(cli_runner, "debug", "notion-page", "missing",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"
