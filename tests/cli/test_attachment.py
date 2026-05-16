"""CLI attachment 子命令测试 (RFC v2 §4.3, PR-3 US-001/US-002)."""

from __future__ import annotations

import json
from pathlib import Path

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


class TestAttachmentList:
    def test_list_seeded_attachment_json(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(cli_runner, "attachment", "list", "12345", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["status"] == "success"
        data = payload["data"]
        assert len(data) == 1
        assert data[0]["filename"] == "report.pdf"
        assert data[0]["internal_id"] == 12345
        assert data[0]["is_inline"] is False
        assert payload["meta"]["count"] == 1

    def test_list_empty_email_json(
        self, cli_runner, cli_env, seeded_db,
    ):
        # internal_id=12346 在 fixture 没插 attachment
        result = _invoke(cli_runner, "attachment", "list", "12346", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"] == []

    def test_list_not_found(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(cli_runner, "attachment", "list", "99999", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["status"] == "error"
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_list_text_no_crash(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(cli_runner, "attachment", "list", "12345",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert "report.pdf" in result.output


class TestAttachmentDownload:
    def test_download_to_dest(
        self, cli_runner, seeded_db_with_real_attachment,
        monkeypatch, tmp_path,
    ):
        db_path, attachment_dir, att_id = seeded_db_with_real_attachment
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")
        dest = tmp_path / "out" / "file.pdf"
        dest.parent.mkdir(parents=True)
        result = _invoke(
            cli_runner, "attachment", "download", str(att_id),
            "--dest", str(dest), "-o", "json",
            db_path=db_path,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["attachment_id"] == att_id
        assert payload["data"]["size_bytes"] == 26  # len(b"PDF-FAKE-CONTENT-FOR-TESTS")
        assert dest.exists()
        assert dest.read_bytes() == b"PDF-FAKE-CONTENT-FOR-TESTS"

    def test_download_not_found(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(cli_runner, "attachment", "download", "9999",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_download_file_missing(
        self, cli_runner, cli_env, seeded_db,
    ):
        # seeded_db 默认 local_path='data/attachments/12345/report.pdf' 物理不存在
        # 找 attachment id (fixture 没固定, 用 SELECT)
        import sqlite3
        conn = sqlite3.connect(str(seeded_db))
        att_id = int(conn.execute(
            "SELECT id FROM email_attachment LIMIT 1"
        ).fetchone()[0])
        conn.close()
        result = _invoke(cli_runner, "attachment", "download", str(att_id),
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"
        assert "missing on disk" in payload["error"]["message"]

    def test_download_dest_missing_parent(
        self, cli_runner, seeded_db_with_real_attachment, monkeypatch, tmp_path,
    ):
        db_path, _, att_id = seeded_db_with_real_attachment
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")
        bad = tmp_path / "no" / "such" / "dir" / "out.bin"
        result = _invoke(cli_runner, "attachment", "download", str(att_id),
                         "--dest", str(bad), "-o", "json", db_path=db_path)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


class TestAttachmentDerive:
    def test_derive_dry_run_json(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "attachment", "derive", "12345",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["stub"] is True
        assert "PR-4" in payload["data"]["message"]

    def test_derive_non_dry_run_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "attachment", "derive", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        # PR-3 round-5: align attachment derive non-dry-run with error-codes.md
        # (E_NOT_IMPLEMENTED for "command exists but stub only" cases)
        assert payload["error"]["code"] == "E_NOT_IMPLEMENTED"
        assert "PR-4" in payload["error"]["message"]


class TestAttachmentCleanupOrphans:
    def test_dry_run_empty(self, cli_runner, cli_env, seeded_db,
                           monkeypatch, tmp_path):
        # 没插孤儿目录 → orphans=[]
        monkeypatch.setenv("ATTACHMENT_STORAGE_DIR", str(tmp_path / "att-empty"))
        result = _invoke(cli_runner, "attachment", "cleanup-orphans",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["orphans"] == []
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["mode"] == "dry-run"
        assert payload["data"]["deleted"] == 0

    def test_dry_run_lists_orphans(
        self, cli_runner, seeded_db, monkeypatch, tmp_path,
    ):
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")
        att_dir = tmp_path / "att-with-orphan"
        # 插一个不在 email_metadata 里的目录 (id=88888)
        orphan = att_dir / "88888"
        orphan.mkdir(parents=True)
        (orphan / "ghost.bin").write_bytes(b"x" * 100)
        monkeypatch.setenv("ATTACHMENT_STORAGE_DIR", str(att_dir))
        result = _invoke(cli_runner, "attachment", "cleanup-orphans",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_orphans"] == 1
        orph = payload["data"]["orphans"][0]
        assert orph["internal_id"] == 88888
        assert orph["file_count"] == 1
        assert orph["size_bytes"] == 100
        assert payload["data"]["deleted"] == 0
        assert orphan.exists()  # dry-run 不删

    def test_no_dry_run_without_yes_rejected(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(cli_runner, "attachment", "cleanup-orphans",
                         "--no-dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_no_dry_run_without_auth_rejected(
        self, cli_runner, seeded_db, monkeypatch, tmp_path,
    ):
        from src.cli.main import app
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")
        # 服务端配 token; caller 用 --api-key 传不同值 → 拒鉴权
        # (env 同时作"expected"和"provided fallback", 所以必须 --api-key 显式 override)
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "expected-token")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "")
        monkeypatch.setenv("ATTACHMENT_STORAGE_DIR", str(tmp_path / "x"))
        result = cli_runner.invoke(app, [
            "--db-path", str(seeded_db),
            "--api-key", "wrong-token",
            "attachment", "cleanup-orphans",
            "--no-dry-run", "--yes", "-o", "json",
        ])
        assert result.exit_code == 4, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"

    def test_no_dry_run_with_auth_deletes(
        self, cli_runner, seeded_db, monkeypatch, tmp_path,
    ):
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")
        # 开发模式 unsafe-flag opt-in 跳过 token 校验
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        att_dir = tmp_path / "att"
        orphan = att_dir / "77777"
        orphan.mkdir(parents=True)
        (orphan / "g.bin").write_bytes(b"abc")
        monkeypatch.setenv("ATTACHMENT_STORAGE_DIR", str(att_dir))
        result = _invoke(cli_runner, "attachment", "cleanup-orphans",
                         "--no-dry-run", "--yes", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total_orphans"] == 1
        assert payload["data"]["deleted"] == 1
        assert payload["data"]["mode"] == "deleted"
        assert not orphan.exists()
