"""tests/cli/test_report_agent.py — F4a `mailagent report agent-create / agent-delete`。

覆盖：
- agent-create：建 type='search' 行 → resolve_agent 投影（tools_json 数组）。
- agent-create：id 冲突（种子 daily_email_digest）→ exit 2 / E_INVALID_ARG。
- agent-create：非法 --type → exit 2 / E_INVALID_ARG。
- agent-create：非法 --tools-json（非 JSON 数组）→ exit 2 / E_INVALID_ARG。
- agent-delete：删存在的行 → {deleted}；删不存在 → exit 1 / E_NOT_FOUND。
- 写命令鉴权：未授权（默认 cli_env）→ exit 4。
"""

from __future__ import annotations


import pytest

from tests.cli.conftest import extract_last_json_object as _extract


@pytest.fixture
def _unauth_writes_on(monkeypatch):
    """放行写命令鉴权（默认 cli_env 不开 ALLOW_UNAUTH_WRITES，写命令被 require_auth 拒）。"""
    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(app, ["--db-path", str(db_path), "report", *args])


# ============================================================
# agent-create
# ============================================================
class TestAgentCreate:
    def test_create_search_agent(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke(
            cli_runner,
            "agent-create",
            "--id",
            "my_search",
            "--type",
            "search",
            "--title",
            "My Search",
            "--tools-json",
            '["email_search_fulltext"]',
            "-o",
            "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        data = _extract(result.output)["data"]
        assert data["id"] == "my_search"
        assert data["type"] == "search"
        assert data["enabled"] is True  # --enabled 默认
        assert data["title"] == "My Search"
        assert data["tools_json"] == ["email_search_fulltext"]

    def test_create_no_enabled(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke(
            cli_runner, "agent-create", "--id", "off_agent", "--no-enabled",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        assert _extract(result.output)["data"]["enabled"] is False

    def test_create_conflict_invalid_arg(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        """id 已存在（种子 daily_email_digest）→ exit 2 / E_INVALID_ARG。"""
        result = _invoke(
            cli_runner, "agent-create", "--id", "daily_email_digest",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        assert _extract(result.output)["error"]["code"] == "E_INVALID_ARG"

    def test_create_invalid_type(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke(
            cli_runner, "agent-create", "--id", "bad", "--type", "garbage",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        assert _extract(result.output)["error"]["code"] == "E_INVALID_ARG"

    def test_create_invalid_tools_json(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke(
            cli_runner, "agent-create", "--id", "bad2", "--tools-json", "{not-an-array}",
            "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        assert _extract(result.output)["error"]["code"] == "E_INVALID_ARG"

    def test_create_requires_auth(self, cli_runner, cli_env, seeded_db):
        """默认 cli_env 未授权 → exit 4。"""
        result = _invoke(
            cli_runner, "agent-create", "--id", "x", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 4, result.output


# ============================================================
# agent-delete
# ============================================================
class TestAgentDelete:
    def test_delete_existing(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        # 先建
        _invoke(
            cli_runner, "agent-create", "--id", "tmp_agent", "-o", "json", db_path=seeded_db,
        )
        result = _invoke(
            cli_runner, "agent-delete", "--agent", "tmp_agent", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        assert _extract(result.output)["data"]["deleted"] == "tmp_agent"

    def test_delete_not_found(self, cli_runner, cli_env, seeded_db, _unauth_writes_on):
        result = _invoke(
            cli_runner, "agent-delete", "--agent", "ghost", "-o", "json", db_path=seeded_db,
        )
        assert result.exit_code == 1, result.output
        assert _extract(result.output)["error"]["code"] == "E_NOT_FOUND"

    def test_delete_requires_auth(self, cli_runner, cli_env, seeded_db):
        result = _invoke(
            cli_runner, "agent-delete", "--agent", "daily_email_digest", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 4, result.output


# ============================================================
# report run — type 守卫
# ============================================================
class TestReportRun:
    """report run 对 type='search' agent 拒绝，对 type='report' agent 正常（mock LLM）。"""

    def _seed_search_agent(self, db_path, agent_id: str = "email_search_agent") -> None:
        import sqlite3
        import time

        conn = sqlite3.connect(str(db_path))
        conn.execute(
            "INSERT OR REPLACE INTO report_agent "
            "(id, type, enabled, title, schedule_json, prompt, model, kos_enrich, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (agent_id, "search", 1, "Search Agent", "{}", None, None, 0, time.time()),
        )
        conn.commit()
        conn.close()

    def test_run_search_agent_rejected(
        self, cli_runner, cli_env, seeded_db, _unauth_writes_on
    ):
        """type='search' agent 调 report run → exit 2 / E_INVALID_ARG。"""
        self._seed_search_agent(seeded_db)
        result = _invoke(
            cli_runner, "run", "--agent", "email_search_agent", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 2, result.output
        body = _extract(result.output)
        assert body["error"]["code"] == "E_INVALID_ARG"
        assert "report-only" in body["error"]["message"]

    def test_run_report_agent_passes_guard(
        self, cli_runner, cli_env, seeded_db, _unauth_writes_on, monkeypatch
    ):
        """type='report' agent 不被守卫拦截（mock asyncio.run 不触发 LLM/config）。"""
        from src.reports.store import ReportStore

        rid = "daily_email_digest:daily:2026-06-04"

        def _fake_asyncio_run(coro):  # noqa: ANN001
            coro.close()  # 关闭协程避免 ResourceWarning
            store = ReportStore(str(seeded_db))
            store.create_report(
                report_id=rid, agent_id="daily_email_digest", cadence="daily",
                report_date="2026-06-04", window_start="x", window_end="y",
            )
            store.finish_report(rid, status="ready", headline="CLI guard OK")
            return rid

        monkeypatch.setattr("src.cli.commands.report.asyncio.run", _fake_asyncio_run)
        result = _invoke(
            cli_runner, "run", "--agent", "daily_email_digest", "-o", "json",
            db_path=seeded_db,
        )
        assert result.exit_code == 0, result.output
        data = _extract(result.output)["data"]
        assert data["status"] == "ready"
