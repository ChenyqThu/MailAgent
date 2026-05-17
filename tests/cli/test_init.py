"""mailagent init * tests (PR-4 US-007).

Mock InitialSync. Covers:
- fetch-cache (--inbox-count) → _fetch_emails_from_applescript
- analyze --skip-fetch → analyze_only(skip_fetch=True)
- fix-properties --yes 缺 auth → exit 4
- sync-new auth 校验 + auto_confirm
- all --yes 烟测
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from tests.cli.conftest import extract_last_json_object as _xj


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(
        app, ["--db-path", str(db_path), "init", *args],
    )


def _make_mock_initial_sync():
    cls = MagicMock()
    instance = MagicMock()
    instance._fetch_emails_from_applescript = AsyncMock(return_value=None)
    instance.analyze_only = AsyncMock(return_value=MagicMock(spec=object))
    instance.fix_properties = AsyncMock(return_value=None)
    instance.fix_critical_mismatch = AsyncMock(return_value=None)
    instance.update_all_parent_items = AsyncMock(return_value=None)
    instance.sync_new_emails = AsyncMock(return_value=None)
    instance.run = AsyncMock(return_value=None)
    cls.return_value = instance
    return cls, instance


class TestInitFetchCache:
    def test_fetch_cache_smoke(self, cli_runner, cli_env, seeded_db):
        cls, instance = _make_mock_initial_sync()
        with patch("src.init.initial_sync.InitialSync", cls):
            result = _invoke(
                cli_runner, "fetch-cache", "--inbox-count", "100",
                "--sent-count", "20", "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0, result.output
        payload = _xj(result.output)
        assert payload["data"]["action"] == "init-fetch-cache"
        assert payload["data"]["mode"] == "inline"
        assert payload["data"]["ok"] is True
        cls.assert_called_once_with(mailbox_limits={"收件箱": 100, "发件箱": 20})
        instance._fetch_emails_from_applescript.assert_awaited_once_with()


class TestInitAnalyze:
    def test_skip_fetch_passthrough(self, cli_runner, cli_env, seeded_db):
        cls, instance = _make_mock_initial_sync()
        with patch("src.init.initial_sync.InitialSync", cls):
            result = _invoke(
                cli_runner, "analyze", "--skip-fetch",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["data"]["mode"] == "inline"
        instance.analyze_only.assert_awaited_once_with(skip_fetch=True)


class TestInitWriteActions:
    """fix-properties / fix-critical / update-parents / sync-new / all 是写命令."""

    def test_fix_properties_missing_auth_exit_4(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.delenv("MAILAGENT_CLI_API_KEY", raising=False)
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        cls, _ = _make_mock_initial_sync()
        with patch("src.init.initial_sync.InitialSync", cls):
            result = _invoke(
                cli_runner, "fix-properties", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 4
        cls.assert_not_called()

    def test_fix_critical_with_unsafe_writes(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        cls, instance = _make_mock_initial_sync()
        with patch("src.init.initial_sync.InitialSync", cls):
            result = _invoke(
                cli_runner, "fix-critical", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["data"]["mode"] == "inline"
        instance.fix_critical_mismatch.assert_awaited_once_with(auto_confirm=True)

    def test_update_parents_action_name_mapping(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        """update-parents CLI 名 → update_all_parent_items method."""
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        cls, instance = _make_mock_initial_sync()
        with patch("src.init.initial_sync.InitialSync", cls):
            result = _invoke(
                cli_runner, "update-parents", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        instance.update_all_parent_items.assert_awaited_once_with(auto_confirm=True)

    def test_sync_new_yes_passthrough(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        cls, instance = _make_mock_initial_sync()
        with patch("src.init.initial_sync.InitialSync", cls):
            result = _invoke(
                cli_runner, "sync-new", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        instance.sync_new_emails.assert_awaited_once_with(
            limit=None,
            auto_confirm=True,
        )

    def test_init_all_smoke(self, cli_runner, cli_env, seeded_db, monkeypatch):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        cls, instance = _make_mock_initial_sync()
        with patch("src.init.initial_sync.InitialSync", cls):
            result = _invoke(
                cli_runner, "all", "--yes",
                "--inbox-count", "100",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 0
        payload = _xj(result.output)
        assert payload["data"]["mode"] == "inline"
        cls.assert_called_once_with(mailbox_limits={"收件箱": 100})
        instance.run.assert_awaited_once_with(auto_confirm=True, limit=None)

    def test_action_failure_returns_exit_1(
        self, cli_runner, cli_env, seeded_db, monkeypatch,
    ):
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        cls, instance = _make_mock_initial_sync()
        instance.fix_properties = AsyncMock(side_effect=RuntimeError("boom"))
        with patch("src.init.initial_sync.InitialSync", cls):
            result = _invoke(
                cli_runner, "fix-properties", "--yes",
                "-o", "json", db_path=seeded_db,
            )
        assert result.exit_code == 1
        payload = _xj(result.output)
        assert payload["data"]["ok"] is False
        assert "RuntimeError" in payload["data"]["error"]
