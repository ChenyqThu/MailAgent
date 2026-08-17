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


def test_backfill_bootstraps_me_in_a_single_run(
    cli_runner, cli_env, seeded_db, contacts_on, monkeypatch,
):
    """🔴 「我」的引导在**一次** backfill 里就收敛 —— 这正是 `contact_backfill` 在
    扫描前后各引导一次的唯一理由 (全新库里 USER_EMAIL 那条联系人是本次扫描才建出来
    的, 扫描前那次必然扑空)。少了扫描后那次就得再跑一遍命令 / 等下个 tick。

    单选不破: 库里恒最多一条 is_self=1 (两次调用都幂等, 记号只在真标上时才写)。
    """
    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    # cli_env 的 USER_EMAIL = test@example.com —— 给它一封往来, 扫描才会建出那条人。
    with sqlite3.connect(seeded_db) as conn:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, sender, sender_email, "
            "sender_name, to_addr, date_received, mailbox) VALUES "
            "(987654, 'Alice <alice@example.com>', 'alice@example.com', 'Alice', "
            "'Me <test@example.com>', '2026-08-01T08:00:00+00:00', '收件箱')"
        )
        conn.commit()

    result = _invoke(cli_runner, seeded_db, ["--rescan"])
    assert result.exit_code == 0, result.output
    data = extract_last_json_object(result.output)["data"]

    with sqlite3.connect(seeded_db) as conn:
        selves = conn.execute("SELECT id FROM contact WHERE is_self=1").fetchall()
        marker = conn.execute(
            "SELECT value FROM sync_state WHERE key='contact_self.bootstrap_at'"
        ).fetchone()
        own = conn.execute(
            "SELECT contact_id FROM contact_email "
            "WHERE email_normalized='test@example.com'"
        ).fetchone()
    assert own is not None, "USER_EMAIL 那条联系人应由本次扫描建出"
    assert [row[0] for row in selves] == [own[0]]
    assert data["self_bootstrapped"] == own[0]
    assert marker is not None


# ---- 老库 (未迁移到 v54) 经 CLI 入口: 必须先走完整迁移, 不许 no such table ----
# (活库冒烟真 bug: ContactRepository 轻量连接不触发 migration → OperationalError
#  裸 traceback / E_INTERNAL。修法 = 惯例对齐, 命令先过 cli.sync_store 完整 init。)


@pytest.fixture
def old_version_db(seeded_db):
    """把库退回「v52 形态」的关键面: contact 三表不存在 + matter_contact 在场带
    存量行 + db_version=52。stakeholder rebuild 等全保真三形态归
    tests/matters/test_contact_v54_migration.py; 这里只钉 CLI 入口先迁再扫。"""
    from src.mail.sync_store import MATTER_TABLE_DDLS

    mc_ddl = next(
        d for d in MATTER_TABLE_DDLS
        if d.startswith("CREATE TABLE IF NOT EXISTS matter_contact")
    )
    with sqlite3.connect(seeded_db) as conn:
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("DROP TABLE contact_email_link")
        conn.execute("DROP TABLE contact_email")
        conn.execute("DROP TABLE contact")
        conn.execute(mc_ddl)
        conn.execute(
            "INSERT INTO matter_contact (id, email_normalized, display_name, "
            "organization, created_at, updated_at) "
            "VALUES (42, 'legacy@x.com', 'Legacy', NULL, 1, 1)"
        )
        conn.execute("UPDATE sync_state SET value='52' WHERE key='db_version'")
        conn.commit()
    return seeded_db


def test_backfill_dry_run_migrates_old_db_first(
    cli_runner, cli_env, old_version_db, contacts_on,
):
    result = _invoke(cli_runner, old_version_db, ["--dry-run"])
    assert result.exit_code == 0, result.output
    payload = extract_last_json_object(result.output)
    assert payload["status"] == "success"
    assert payload["data"]["dry_run"] is True
    # SyncStore init 已把库迁到当前版本: 三表在场 + matter_contact 数据迁入 (id 保持)。
    # 版本号引用 SyncStore.DB_VERSION 而非手抄字面量 —— 本测试盯的是「迁移发生过」，
    # 不是某个具体版本号（v55 起字面量 pin 每次 bump 都要来改这里）。
    from src.mail.sync_store import SyncStore as _SyncStore

    with sqlite3.connect(old_version_db) as conn:
        assert conn.execute(
            "SELECT value FROM sync_state WHERE key='db_version'"
        ).fetchone()[0] == str(_SyncStore.DB_VERSION)
        assert conn.execute(
            "SELECT display_name FROM contact WHERE id=42"
        ).fetchone()[0] == "Legacy"
        # dry-run 不写扫描数据: 账本仍空
        assert conn.execute(
            "SELECT COUNT(*) FROM contact_email_link"
        ).fetchone()[0] == 0


def test_backfill_real_run_migrates_old_db_then_scans(
    cli_runner, cli_env, old_version_db, contacts_on, monkeypatch,
):
    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    with sqlite3.connect(old_version_db) as conn:
        total = conn.execute("SELECT COUNT(*) FROM email_metadata").fetchone()[0]
    result = _invoke(cli_runner, old_version_db, [])
    assert result.exit_code == 0, result.output
    payload = extract_last_json_object(result.output)
    assert payload["data"]["scan"]["processed"] == total
    with sqlite3.connect(old_version_db) as conn:
        # 迁移产物 (legacy 行 + 主邮箱锚点) 与扫描产物同时在场
        assert conn.execute(
            "SELECT contact_id FROM contact_email "
            "WHERE email_normalized='legacy@x.com'"
        ).fetchone()[0] == 42
        assert conn.execute(
            "SELECT COUNT(*) FROM contact_email "
            "WHERE email_normalized='alice@example.com'"
        ).fetchone()[0] == 1


def test_backfill_newer_db_fails_with_error_envelope(
    cli_runner, cli_env, seeded_db, contacts_on,
):
    """库版本高于代码 (降级守卫) → 明确错误信封, 不裸喷 traceback; dry-run 同形。"""
    with sqlite3.connect(seeded_db) as conn:
        conn.execute("UPDATE sync_state SET value='999' WHERE key='db_version'")
        conn.commit()
    for args in (["--dry-run"], []):
        result = _invoke(cli_runner, seeded_db, args)
        assert result.exit_code == 1, result.output
        payload = extract_last_json_object(result.output)
        assert payload["status"] == "error"
        assert "db_version" in payload["error"]["message"]
