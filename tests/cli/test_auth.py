"""require_auth(ctx) 分支测试 (RFC v2 §5.3)."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _required_env(monkeypatch):
    for k, v in {
        "NOTION_TOKEN": "test",
        "EMAIL_DATABASE_ID": "test",
        "USER_EMAIL": "test@example.com",
    }.items():
        monkeypatch.setenv(k, v)


def _make_ctx(api_key=None):
    from src.cli.context import CliContext

    ctx = CliContext.from_flags(api_key=api_key)
    return ctx


class TestRequireAuth:
    def test_no_token_no_optin_rejects(self, monkeypatch):
        from src.cli.auth import require_auth
        from src.cli.exceptions import CliAuthError

        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")
        monkeypatch.delenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", raising=False)
        ctx = _make_ctx(api_key=None)
        with pytest.raises(CliAuthError):
            require_auth(ctx)

    def test_unsafe_optin_allows(self, monkeypatch):
        from src.cli.auth import require_auth

        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "")
        monkeypatch.setenv("MAILAGENT_CLI_ALLOW_UNAUTH_WRITES", "true")
        ctx = _make_ctx(api_key=None)
        # 不抛 = OK
        require_auth(ctx)

    def test_token_match_allows(self, monkeypatch):
        from src.cli.auth import require_auth

        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "secret-123")
        ctx = _make_ctx(api_key="secret-123")
        require_auth(ctx)

    def test_token_mismatch_rejects(self, monkeypatch):
        from src.cli.auth import require_auth
        from src.cli.exceptions import CliAuthError

        monkeypatch.setenv("MAILAGENT_CLI_API_KEY", "secret-123")
        ctx = _make_ctx(api_key="wrong-key")
        with pytest.raises(CliAuthError):
            require_auth(ctx)
