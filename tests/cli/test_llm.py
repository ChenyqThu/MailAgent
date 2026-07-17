"""CLI llm 子命令测试 (RFC v2 §4.4, PR-3 US-003/US-004)."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


# ============================================================
# LLMRunner mock helper
# ============================================================

def _patch_llm_runner(monkeypatch, run_returns):
    """Replace LLMRunner.run_for_internal_id and close with async stubs.

    ``run_returns`` is a callable ``(internal_id, kwargs) -> dict``, or a fixed dict.
    """
    from src.llm_agent import runner as runner_mod

    async def fake_run(self, internal_id, *, dry_run=False, overwrite=True, force=False):
        if callable(run_returns):
            return run_returns(internal_id, {
                "dry_run": dry_run, "overwrite": overwrite, "force": force,
            })
        return run_returns

    async def fake_close(self):
        return None

    monkeypatch.setattr(runner_mod.LLMRunner, "run_for_internal_id", fake_run)
    monkeypatch.setattr(runner_mod.LLMRunner, "close", fake_close)
    # 同时屏蔽 LLMRunner.__init__ 的 EmailRepository 构造 (默认 sync_store_db_path
    # 可能不存在; 测试用 monkeypatched cfg 路径就够了)

    def safe_init(self, *args, **kwargs):
        # 不做真实 client / store 初始化
        self._processor = None
        self._writer = None
        self._store = kwargs.get("store")
        self._arm = None
        self._reader = None
    monkeypatch.setattr(runner_mod.LLMRunner, "__init__", safe_init)

    # E1 §3.1 Step 3: davmail 模式下 `llm run` (经 LlmService._maybe_davmail_backend)
    # 和 `llm retry-failed` (经 CLI 层 _maybe_create_davmail_backend) 都会在
    # LLMRunner 构造前真连 IMAP probe (测试环境 MAILAGENT_BACKEND 落到 .env 的
    # davmail) —— 一并中和成 None (等同 applescript 模式), 保持 hermetic。
    from src.cli.commands import llm as llm_cmd_mod
    from src.services.llm_service import LlmService
    monkeypatch.setattr(LlmService, "_maybe_davmail_backend", lambda self: None)
    monkeypatch.setattr(llm_cmd_mod, "_maybe_create_davmail_backend", lambda cli: None)


# ============================================================
# US-003: llm run
# ============================================================

class TestLLMRun:
    def test_run_happy(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_llm_runner(monkeypatch, {
            "ok": True, "internal_id": 12345,
            "page_id": "abc12345-0000-0000-0000-000000000001",
            "mailbox": "收件箱", "dry_run": False,
            "labels": {"category": "Action"},
            "writer_summary": {"updated": 5},
        })
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, "llm", "run", "12345", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["status"] == "success"
        assert payload["data"]["internal_id"] == 12345
        assert payload["data"]["labels"]["category"] == "Action"

    def test_run_dry_run_skips_auth(self, cli_runner, cli_env, seeded_db,
                                    monkeypatch):
        _patch_llm_runner(monkeypatch, {
            "ok": True, "internal_id": 12345, "page_id": "p",
            "mailbox": "收件箱", "dry_run": True, "labels": {"x": 1},
        })
        # NO unsafe-flag opt-in — dry-run 应跳过 auth
        result = _invoke(cli_runner, "llm", "run", "12345", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["dry_run"] is True

    def test_run_not_synced_not_found(self, cli_runner, cli_env, seeded_db,
                                      monkeypatch):
        _patch_llm_runner(monkeypatch, {
            "ok": False, "internal_id": 12345,
            "error": "email not synced to Notion yet (notion_page_id empty)",
        })
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, "llm", "run", "12345", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_NOT_FOUND"

    def test_run_llm_failed(self, cli_runner, cli_env, seeded_db, monkeypatch):
        _patch_llm_runner(monkeypatch, {
            "ok": False, "internal_id": 12345,
            "error": "gateway HTTP 500", "retry_count": 1, "status": "failed",
        })
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, "llm", "run", "12345", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_LLM_FAILED"

    def test_run_no_auth_rejected(self, cli_runner, seeded_db, monkeypatch):
        monkeypatch.setenv("NOTION_TOKEN", "x")
        monkeypatch.setenv("EMAIL_DATABASE_ID", "y")
        monkeypatch.setenv("USER_EMAIL", "t@example.com")
        monkeypatch.setenv("MAIL_ACCOUNT_NAME", "t")
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "expected")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "")
        from src.cli.main import app
        result = cli_runner.invoke(app, [
            "--db-path", str(seeded_db),
            "--api-key", "wrong",
            "llm", "run", "12345", "-o", "json",
        ])
        assert result.exit_code == 4, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_AUTH_FAILED"


# ============================================================
# US-003: llm selftest
# ============================================================

class TestLLMSelftest:
    def test_selftest_healthy(self, cli_runner, cli_env, seeded_db, monkeypatch):
        monkeypatch.setenv("LLM_API_KEY", "cr_test_key")
        monkeypatch.setenv("LLM_API_BASE", "https://example.com/api")
        monkeypatch.setenv("LLM_MODEL", "claude-sonnet-4-6")
        result = _invoke(cli_runner, "llm", "selftest", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["healthy"] is True
        assert payload["data"]["primary_model"] == "claude-sonnet-4-6"
        assert payload["data"]["api_base"] == "https://example.com/api"

    def test_selftest_unhealthy(self, cli_runner, cli_env, seeded_db, monkeypatch):
        monkeypatch.setenv("LLM_API_KEY", "")
        monkeypatch.setenv("LLM_API_BASE", "https://x")
        monkeypatch.setenv("LLM_MODEL", "m")
        result = _invoke(cli_runner, "llm", "selftest", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 1, result.output
        payload = _last_json(result.output)
        assert payload["data"]["healthy"] is False
        assert "LLM_API_KEY is empty" in payload["data"]["reasons"]


# ============================================================
# US-003: llm retry-failed
# ============================================================

class TestLLMRetryFailed:
    def _seed_failed_row(self, db_path: Path, internal_id: int, *,
                         next_retry_at: float):
        conn = sqlite3.connect(str(db_path))
        # llm_processing 表用 store 自动建
        from src.llm_agent.store import LLMProcessingStore
        LLMProcessingStore(db_path=str(db_path))
        conn.execute(
            """INSERT INTO llm_processing
                 (internal_id, status, retry_count, next_retry_at,
                  last_error, created_at, updated_at)
               VALUES (?, 'failed', 1, ?, 'mock fail', ?, ?)""",
            (internal_id, next_retry_at, time.time(), time.time()),
        )
        conn.commit()
        conn.close()

    def test_retry_dry_run_empty(self, cli_runner, cli_env, seeded_db, monkeypatch):
        result = _invoke(cli_runner, "llm", "retry-failed", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["candidates"] == 0
        assert payload["data"]["dry_run"] is True

    def test_retry_dry_run_lists(self, cli_runner, cli_env, seeded_db, monkeypatch):
        self._seed_failed_row(seeded_db, 12345, next_retry_at=time.time() - 60)
        result = _invoke(cli_runner, "llm", "retry-failed", "--dry-run",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["candidates"] == 1
        assert 12345 in payload["data"]["candidate_internal_ids"]

    def test_retry_runs(self, cli_runner, cli_env, seeded_db, monkeypatch):
        self._seed_failed_row(seeded_db, 12345, next_retry_at=time.time() - 60)
        # 一半成功一半失败 — 我们只 seed 一封, mock 返回 ok
        _patch_llm_runner(monkeypatch, {
            "ok": True, "internal_id": 12345, "page_id": "p",
            "mailbox": "收件箱", "dry_run": False, "labels": {},
        })
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        result = _invoke(cli_runner, "llm", "retry-failed", "--limit", "5",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["candidates"] == 1
        assert payload["data"]["succeeded"] == 1
        assert payload["data"]["failed"] == 0

    def test_retry_invalid_limit(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "llm", "retry-failed", "--limit", "0",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


# ============================================================
# US-004: llm stats
# ============================================================

class TestLLMStats:
    def test_stats_empty(self, cli_runner, cli_env, seeded_db):
        # v37 起 SyncStore._init_database 版本化建 llm_processing (首启缺表修复),
        # seeded_db 恒有表 → 空表走 live_query 返回 total=0 (不再是 table_missing)
        result = _invoke(cli_runner, "llm", "stats", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 0
        assert payload["data"]["by_status"] == {}
        assert payload["data"]["_source"] == "live_query"

    def test_stats_table_missing_fallback(self, cli_runner, cli_env, seeded_db):
        # 防御分支覆盖: 未经 SyncStore 迁移的外部/旧库 (无 llm_processing 表) →
        # stats 不崩, 走 table_missing 零值 fallback。v37 后正常路径建库恒有表,
        # 这里显式 DROP 模拟缺表现场。
        conn = sqlite3.connect(str(seeded_db))
        try:
            conn.execute("DROP TABLE llm_processing")
            conn.commit()
        finally:
            conn.close()
        result = _invoke(cli_runner, "llm", "stats", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["total"] == 0
        assert payload["data"]["_source"] == "table_missing"

    def test_stats_with_rows(self, cli_runner, cli_env, seeded_db):
        # 插一行 success + 一行 failed
        from src.llm_agent.store import LLMProcessingStore
        store = LLMProcessingStore(db_path=str(seeded_db))
        now = time.time()
        with store._conn() as c:
            c.execute(
                """INSERT INTO llm_processing
                     (internal_id, status, retry_count, model, input_tokens,
                      output_tokens, cache_read_input_tokens,
                      cache_creation_input_tokens, latency_ms,
                      labels_json, created_at, updated_at)
                   VALUES (?, 'success', 0, 'claude-sonnet-4-6', 1000, 200,
                           700, 0, 3500, '{}', ?, ?)""",
                (12345, now, now),
            )
            c.execute(
                """INSERT INTO llm_processing
                     (internal_id, status, retry_count, last_error,
                      created_at, updated_at)
                   VALUES (?, 'failed', 1, 'oops', ?, ?)""",
                (12346, now, now),
            )
            c.commit()
        result = _invoke(cli_runner, "llm", "stats", "-o", "json",
                         db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["_source"] == "live_query"
        assert payload["data"]["total"] == 2
        assert payload["data"]["by_status"]["success"] == 1
        assert payload["data"]["by_status"]["failed"] == 1
        assert payload["data"]["cost"]["input_tokens"] == 1000
        assert payload["data"]["cost"]["cache_hit_rate_pct"] == 100.0

    def test_stats_days_zero_rejected(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "llm", "stats", "--days", "0",
                         "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"


# ============================================================
# US-004: llm compare-paths
# ============================================================

class TestLLMComparePaths:
    def test_compare_paths_dry_run_recent(self, cli_runner, cli_env, seeded_db):
        result = _invoke(cli_runner, "llm", "compare-paths", "--count", "10",
                         "--dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["mode"] == "dry_run"
        assert payload["data"]["selection_mode"] == "recent"
        assert payload["data"]["internal_ids"] == [12345]
        assert payload["data"]["plan"]["sample_size"] == 1
        assert "cost_preview" in payload["data"]

    def test_compare_paths_dry_run_explicit(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "llm", "compare-paths",
            "--internal-ids", "53674,53675", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        payload = _last_json(result.output)
        assert payload["data"]["mode"] == "dry_run"
        assert payload["data"]["selection_mode"] == "explicit"
        assert payload["data"]["internal_ids"] == [53674, 53675]

    def test_compare_paths_non_dry_run_requires_yes(
        self, cli_runner, cli_env, seeded_db,
    ):
        result = _invoke(cli_runner, "llm", "compare-paths", "--count", "5",
                         "--no-dry-run", "-o", "json", db_path=seeded_db)
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"

    def test_compare_paths_bad_ids(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "llm", "compare-paths",
            "--internal-ids", "abc,123", "--dry-run", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        payload = _last_json(result.output)
        assert payload["error"]["code"] == "E_INVALID_ARG"
