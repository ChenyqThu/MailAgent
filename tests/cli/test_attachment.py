"""CLI attachment 子命令测试 (RFC v2 §4.3, PR-3 US-001/US-002)."""

from __future__ import annotations

import sqlite3

import typer

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
    def test_alias_dry_run(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "attachment", "derive", "12345",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["action"] == "backfill-derivatives"
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["dry_run"] is True
        assert payload["data"]["deprecated_alias"] is True

    def test_alias_real_run(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        def fake_inline(cli, **kwargs):
            from src.cli.output import emit

            data = {
                "action": "backfill-derivatives",
                "mode": "inline",
                "dry_run": kwargs["dry_run"],
                "target_kind": "ids",
                "target_key": f"ids:{kwargs['internal_id']}",
                "succeeded": [],
                "failed": [],
                "summary": {
                    "total": 0,
                    "succeeded": 0,
                    "failed": 0,
                    "skipped": 0,
                    "aborted": False,
                    "aborted_reason": None,
                    "max_failures_hit": False,
                },
            }
            data.update(kwargs.get("data_extra") or {})
            emit(cli, data)
            return typer.Exit(0)

        monkeypatch.setattr(
            "src.cli.commands.backfill._run_backfill_derivatives_inline",
            fake_inline,
        )
        result = _invoke(cli_runner, "attachment", "derive", "12345",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["deprecated_alias"] is True
        assert payload["data"]["dry_run"] is False

    def test_deprecation_warning_in_stderr(self, cli_runner, cli_env, seeded_db):
        # CliRunner mixes stderr into output in this test suite; the command
        # itself prints the warning with print(..., file=sys.stderr).
        result = _invoke(cli_runner, "attachment", "derive", "12345",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert "deprecated" in result.output

    def test_alias_forwards_internal_id(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        captured = {}

        def fake_inline(cli, **kwargs):
            from src.cli.output import emit

            captured.update(kwargs)
            data = {
                "action": "backfill-derivatives",
                "mode": "inline",
                "dry_run": kwargs["dry_run"],
                "target_kind": "ids",
                "target_key": f"ids:{kwargs['internal_id']}",
                "succeeded": [],
                "failed": [],
                "summary": {
                    "total": 0,
                    "succeeded": 0,
                    "failed": 0,
                    "skipped": 0,
                    "aborted": False,
                    "aborted_reason": None,
                    "max_failures_hit": False,
                },
            }
            data.update(kwargs.get("data_extra") or {})
            emit(cli, data)
            return typer.Exit(0)

        monkeypatch.setattr(
            "src.cli.commands.backfill._run_backfill_derivatives_inline",
            fake_inline,
        )
        result = _invoke(cli_runner, "attachment", "derive", "67890",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        assert captured["internal_id"] == 67890
        assert captured["dry_run"] is True
        assert captured["data_extra"] == {"deprecated_alias": True}


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


class TestAttachmentExtract:
    """PR0: extract --pending 经共享真源 process_pending_extractions 处理.

    CLI 与长驻 worker 共用同一消费逻辑 (src/mail/attachment_text_worker.py),
    这里 pin 「CLI 委派 → stats 语义一致」的接线。
    """

    def _enqueue_txt_pending(self, db_path, attachment_dir, att_id) -> None:
        """把 12345 的附件换成可抽取 .txt + enqueue pending 行."""
        txt = attachment_dir / "12345" / "notes.txt"
        txt.parent.mkdir(parents=True, exist_ok=True)
        txt.write_text("cli parity redis timeout content", encoding="utf-8")
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                "UPDATE email_attachment SET filename='notes.txt', "
                "content_type='text/plain', local_path=? WHERE id=?",
                (str(txt), att_id),
            )
            conn.execute(
                """INSERT OR REPLACE INTO email_attachment_text
                     (attachment_id, text_content, text_size_bytes, extractor,
                      status, retry_count, created_at, updated_at)
                   VALUES (?, NULL, 0, 'pending', 'pending', 0,
                           strftime('%s','now'), strftime('%s','now'))""",
                (att_id,),
            )
            conn.commit()
        finally:
            conn.close()

    def _set_env(self, monkeypatch):
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")

    def test_extract_pending_extracts_via_shared_function(
        self, cli_runner, seeded_db_with_real_attachment, monkeypatch,
    ):
        db_path, attachment_dir, att_id = seeded_db_with_real_attachment
        self._set_env(monkeypatch)
        self._enqueue_txt_pending(db_path, attachment_dir, att_id)

        result = _invoke(cli_runner, "attachment", "extract", "--pending",
                         "-o", "json", db_path=db_path)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["processed"] == 1
        assert payload["data"]["extracted"] == 1
        assert payload["data"]["failed"] == 0
        assert payload["data"]["skipped"] == 0

        # 落库确实转成 extracted
        conn = sqlite3.connect(str(db_path))
        status = conn.execute(
            "SELECT status FROM email_attachment_text WHERE attachment_id=?",
            (att_id,),
        ).fetchone()[0]
        conn.close()
        assert status == "extracted"

    def test_extract_dry_run_no_writes(
        self, cli_runner, seeded_db_with_real_attachment, monkeypatch,
    ):
        db_path, attachment_dir, att_id = seeded_db_with_real_attachment
        self._set_env(monkeypatch)
        self._enqueue_txt_pending(db_path, attachment_dir, att_id)

        result = _invoke(cli_runner, "attachment", "extract", "--pending",
                         "--dry-run", "-o", "json", db_path=db_path)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["processed"] == 1
        assert payload["data"]["extracted"] == 0
        assert payload["data"]["dry_run"] is True

        # dry-run 不落写: 仍 pending
        conn = sqlite3.connect(str(db_path))
        status = conn.execute(
            "SELECT status FROM email_attachment_text WHERE attachment_id=?",
            (att_id,),
        ).fetchone()[0]
        conn.close()
        assert status == "pending"

    def test_extract_requires_a_mode_flag(
        self, cli_runner, seeded_db, monkeypatch,
    ):
        self._set_env(monkeypatch)
        result = _invoke(cli_runner, "attachment", "extract",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


class TestAttachmentRequeueUnsupported:
    """批次4 PR-H: attachment extract --requeue-unsupported 存量回填。"""

    def _set_env(self, monkeypatch):
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")

    def _seed_unsupported(
        self, db_path, filename, status="unsupported",
        content_type="application/octet-stream",
    ) -> int:
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            cur = conn.execute(
                """INSERT INTO email_attachment
                     (internal_id, content_id, filename, content_type, size_bytes,
                      is_inline, local_path, sha256, derived_from, derived_format,
                      created_at, schema_version)
                   VALUES (12345, NULL, ?, ?, 10, 0, ?, ?, NULL, NULL,
                           strftime('%s','now'), 1)""",
                (filename, content_type,
                 f"data/attachments/12345/{filename}", "aa" * 16),
            )
            att_id = int(cur.lastrowid)
            conn.execute(
                """INSERT INTO email_attachment_text
                     (attachment_id, text_content, text_size_bytes, extractor,
                      status, retry_count, created_at, updated_at)
                   VALUES (?, NULL, 0, 'none', ?, 0,
                           strftime('%s','now'), strftime('%s','now'))""",
                (att_id, status),
            )
            conn.commit()
        finally:
            conn.close()
        return att_id

    def test_requeue_dry_run_reports_counts(
        self, cli_runner, seeded_db, monkeypatch,
    ):
        self._set_env(monkeypatch)
        self._seed_unsupported(seeded_db, "scan.png")
        self._seed_unsupported(seeded_db, "old.doc")
        self._seed_unsupported(seeded_db, "scanned.pdf", status="failed")
        result = _invoke(cli_runner, "attachment", "extract",
                         "--requeue-unsupported", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        rq = payload["data"]["requeued"]
        assert rq["unsupported_images"] == 1
        assert rq["unsupported_legacy"] == 1
        assert rq["failed_pdf"] == 1
        assert rq["total"] == 3
        assert rq["dry_run"] is True
        # dry-run 不写: 没有任何行变 pending。
        conn = sqlite3.connect(str(seeded_db))
        n = conn.execute(
            "SELECT COUNT(*) FROM email_attachment_text WHERE status='pending'"
        ).fetchone()[0]
        conn.close()
        assert n == 0

    def test_requeue_writes_pending(
        self, cli_runner, seeded_db, monkeypatch,
    ):
        self._set_env(monkeypatch)
        aid = self._seed_unsupported(seeded_db, "scan.png")
        result = _invoke(cli_runner, "attachment", "extract",
                         "--requeue-unsupported", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["requeued"]["total"] == 1
        conn = sqlite3.connect(str(seeded_db))
        status = conn.execute(
            "SELECT status FROM email_attachment_text WHERE attachment_id=?",
            (aid,),
        ).fetchone()[0]
        conn.close()
        assert status == "pending"

    def test_requeue_alone_is_valid_mode(
        self, cli_runner, seeded_db, monkeypatch,
    ):
        """单独 --requeue-unsupported (无 --pending/--include-missing) 是合法 mode。"""
        self._set_env(monkeypatch)
        result = _invoke(cli_runner, "attachment", "extract",
                         "--requeue-unsupported", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["requeued"]["total"] == 0
