"""Smoke / help snapshot — 防 typer 升级时静默改 help layout / 命令丢失."""

from __future__ import annotations

import json


def test_root_help(cli_runner, cli_env):
    from src.cli.main import app

    result = cli_runner.invoke(app, ["--help"])
    assert result.exit_code == 0, result.output
    out = result.output
    assert "Usage" in out
    assert "mailagent" in out
    # 两个 sub-typer 必须暴露
    assert "email" in out
    assert "admin" in out


def test_email_help(cli_runner, cli_env):
    from src.cli.main import app

    result = cli_runner.invoke(app, ["email", "--help"])
    assert result.exit_code == 0, result.output
    out = result.output
    # 5 个 leaf commands 必须列出 (US-003 / US-004 / US-005)
    for leaf in ("get", "list", "body", "search", "resync"):
        assert leaf in out, f"missing leaf {leaf} in: {out}"


def test_admin_help(cli_runner, cli_env):
    from src.cli.main import app

    result = cli_runner.invoke(app, ["admin", "--help"])
    assert result.exit_code == 0, result.output
    out = result.output
    # 3 个 admin leaves
    for leaf in ("stats", "health", "db-version"):
        assert leaf in out, f"missing leaf {leaf} in: {out}"


def test_version_flag(cli_runner, cli_env):
    from src.cli.main import app

    result = cli_runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert "mailagent" in result.output
