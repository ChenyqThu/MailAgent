"""`mailagent im pair` / `im status` 的 CLI 面（src/cli/commands/im.py）。

沿用 tests/cli 的 fixture 手法：tmp SQLite + CliRunner + `-o json` wrapper 解析。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from src.im.pairing import PAIR_CODE_DIGITS
from src.im.state import STATE_BOUND_OPEN_ID, STATE_PAIR_CODE


@pytest.fixture
def cli_runner():
    from typer.testing import CliRunner

    return CliRunner()


@pytest.fixture
def db(tmp_path: Path) -> Path:
    from src.mail.sync_store import SyncStore

    path = tmp_path / "sync_store.db"
    SyncStore(str(path))
    return path


@pytest.fixture(autouse=True)
def _allow_unauth_writes(monkeypatch):
    """写命令鉴权本身不是本文件的被测对象（tests/cli 已有覆盖）。

    🔴 ``MAILAGENT_CLI_API_KEY`` 要 ``setenv("")`` 而不是 ``delenv`` —— 删掉进程 env
    只会让 pydantic 退回读**仓库 .env**（开发机上真配着 token），于是每个写命令都
    exit 4。空串才是「服务端没配 token」（镜像 tests/cli 的既有手法）。
    """
    monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
    monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")


def _run(cli_runner, db: Path, *args):
    from src.cli.main import app

    return cli_runner.invoke(app, ["--db-path", str(db), *args])


def _json(result) -> dict[str, Any]:
    for line in reversed((result.output or "").strip().splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    raise AssertionError(f"no JSON in output: {result.output[:300]!r}")


def _state(db: Path, key: str) -> str:
    conn = sqlite3.connect(str(db))
    try:
        row = conn.execute(
            "SELECT value FROM sync_state WHERE key = ?", (key,)
        ).fetchone()
    finally:
        conn.close()
    return row[0] if row else ""


def _set_state(db: Path, key: str, value: str) -> None:
    conn = sqlite3.connect(str(db))
    try:
        conn.execute(
            "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)",
            (key, value, 0),
        )
        conn.commit()
    finally:
        conn.close()


class TestPair:
    def test_issues_a_six_digit_code_and_persists_it(self, cli_runner, db):
        result = _run(cli_runner, db, "im", "pair", "-o", "json")
        assert result.exit_code == 0, result.output
        payload = _json(result)
        code = payload["data"]["code"]
        assert len(code) == PAIR_CODE_DIGITS and code.isdigit()
        assert payload["data"]["expires_in_sec"] == 600
        # 跨进程存活：真的落进了 sync_state，长驻服务才读得到
        assert _state(db, STATE_PAIR_CODE) == code

    def test_text_mode_prints_the_code(self, cli_runner, db):
        result = _run(cli_runner, db, "im", "pair")
        assert result.exit_code == 0
        assert "绑定码" in result.output

    def test_refuses_when_already_bound(self, cli_runner, db):
        _set_state(db, STATE_BOUND_OPEN_ID, "ou_owner")
        result = _run(cli_runner, db, "im", "pair", "-o", "json")
        assert result.exit_code == 2
        assert _json(result)["error"]["code"] == "E_INVALID_ARG"
        assert _state(db, STATE_PAIR_CODE) == ""  # 没出码

    def test_rebind_unbinds_then_issues(self, cli_runner, db):
        _set_state(db, STATE_BOUND_OPEN_ID, "ou_old")
        result = _run(cli_runner, db, "im", "pair", "--rebind", "-o", "json")
        assert result.exit_code == 0
        assert _json(result)["data"]["unbound_from"] == "ou_old"
        assert _state(db, STATE_BOUND_OPEN_ID) == ""
        assert _state(db, STATE_PAIR_CODE)

    def test_wrong_api_key_is_refused(self, cli_runner, db, monkeypatch):
        """pair 是写命令 —— token 配了就必须对得上（exit 4）。"""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "")
        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "expected-token")
        from src.cli.main import app

        result = cli_runner.invoke(
            app,
            ["--db-path", str(db), "--api-key", "wrong-token", "im", "pair", "-o", "json"],
        )
        assert result.exit_code == 4
        assert _json(result)["error"]["code"] == "E_AUTH_FAILED"
        assert _state(db, STATE_PAIR_CODE) == ""  # 鉴权失败不出码


class TestStatus:
    def test_reports_unbound_state_without_auth(self, cli_runner, db, monkeypatch):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "")
        result = _run(cli_runner, db, "im", "status", "-o", "json")
        assert result.exit_code == 0, result.output
        data = _json(result)["data"]
        assert data["bound_open_id"] == ""
        assert data["pair_code_pending"] is False

    def test_never_echoes_the_pair_code(self, cli_runner, db):
        pair = _json(_run(cli_runner, db, "im", "pair", "-o", "json"))["data"]["code"]
        result = _run(cli_runner, db, "im", "status", "-o", "json")
        assert pair not in result.output
        assert _json(result)["data"]["pair_code_pending"] is True
