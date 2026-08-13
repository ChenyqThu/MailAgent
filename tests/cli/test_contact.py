"""mailagent contact backfill — 总闸 gate / dry-run 免 auth / 真写 auth / 全链落库。"""

from __future__ import annotations

import sqlite3

import pytest

from tests.cli.conftest import extract_last_json_object


@pytest.fixture
def contacts_on(monkeypatch):
    # CLI 每次 invoke 都从 env 重建 CLI-scoped Config (CliContext.from_flags) —— 走
    # env 注入而非 setattr 全局单例 (后者会被 _sync_global_cfg_from_cli 冲掉)。
    monkeypatch.setenv("MAILAGENT_CONTACTS_ENABLED", "true")


def _invoke(cli_runner, db, args):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["-o", "json", "--db-path", str(db), "contact", "backfill", *args],
    )


def test_backfill_refused_when_flag_off(cli_runner, cli_env, seeded_db):
    # cli_env 不设 MAILAGENT_CONTACTS_ENABLED → pydantic 默认 False (灰度关)
    result = _invoke(cli_runner, seeded_db, [])
    assert result.exit_code == 1, result.output
    payload = extract_last_json_object(result.output)
    assert payload["status"] == "error"
    assert "MAILAGENT_CONTACTS_ENABLED" in payload["error"]["message"]


def test_backfill_dry_run_reports_backlog_without_auth(
    cli_runner, cli_env, seeded_db, contacts_on,
):
    with sqlite3.connect(seeded_db) as conn:
        total = conn.execute("SELECT COUNT(*) FROM email_metadata").fetchone()[0]
    result = _invoke(cli_runner, seeded_db, ["--dry-run"])
    assert result.exit_code == 0, result.output
    payload = extract_last_json_object(result.output)
    data = payload["data"]
    assert data["dry_run"] is True
    assert data["pending"] == total      # 全量积压如实报告
    assert data["contacts"] == 0         # dry-run 零写入
    with sqlite3.connect(seeded_db) as conn:
        assert conn.execute("SELECT COUNT(*) FROM contact").fetchone()[0] == 0


def test_backfill_real_write_requires_auth(cli_runner, cli_env, seeded_db, contacts_on):
    # cli_env: API key 空 + 未 opt-in unauth writes → exit 4
    result = _invoke(cli_runner, seeded_db, [])
    assert result.exit_code == 4, result.output


def test_backfill_scans_and_calibrates(
    cli_runner, cli_env, seeded_db, contacts_on, monkeypatch,
):
    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    with sqlite3.connect(seeded_db) as conn:
        total = conn.execute("SELECT COUNT(*) FROM email_metadata").fetchone()[0]
    result = _invoke(cli_runner, seeded_db, [])
    assert result.exit_code == 0, result.output
    payload = extract_last_json_object(result.output)
    data = payload["data"]
    assert data["scan"]["processed"] == total
    assert data["scan"]["drained"] is True
    assert data["calibrated_contacts"] >= 1
    count_sql = (
        "SELECT mail_count FROM contact_email "
        "WHERE email_normalized='alice@example.com'"
    )
    with sqlite3.connect(seeded_db) as conn:
        first_pass = conn.execute(count_sql).fetchone()
        assert first_pass is not None and first_pass[0] >= 1

    # --rescan 幂等: 再全量跑一遍不重复计数
    result2 = _invoke(cli_runner, seeded_db, ["--rescan"])
    assert result2.exit_code == 0, result2.output
    with sqlite3.connect(seeded_db) as conn:
        assert conn.execute(count_sql).fetchone()[0] == first_pass[0]
