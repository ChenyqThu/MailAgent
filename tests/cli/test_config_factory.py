"""load_cli_config priority test (RFC v2 §5.4)."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _required_env(monkeypatch):
    """Config 有几个 required Field, 测试时填 dummy 值."""
    for k, v in {
        "NOTION_TOKEN": "test",
        "EMAIL_DATABASE_ID": "test",
        "USER_EMAIL": "test@example.com",
    }.items():
        monkeypatch.setenv(k, v)


def test_flag_override_takes_priority(tmp_path, monkeypatch):
    """flag_overrides 必须覆盖 env / .env 中的同名字段."""
    from src.cli.config import load_cli_config

    # env 设一个值, flag 设另一个
    monkeypatch.setenv("SYNC_STORE_DB_PATH", "/env/value.db")
    cfg = load_cli_config(
        flag_overrides={"sync_store_db_path": "/flag/value.db"},
    )
    assert cfg.sync_store_db_path == "/flag/value.db"


def test_flag_override_none_keeps_env(monkeypatch):
    """flag_overrides 为 None 时不覆盖, env 值生效."""
    from src.cli.config import load_cli_config

    monkeypatch.setenv("SYNC_STORE_DB_PATH", "/env/value.db")
    cfg = load_cli_config(
        flag_overrides={"sync_store_db_path": None},
    )
    assert cfg.sync_store_db_path == "/env/value.db"


def test_factory_not_module_singleton(monkeypatch):
    """factory 应该是独立实例; 改一个不影响 src.config.config 全局 singleton."""
    from src.cli.config import load_cli_config
    from src.config import config as global_singleton

    cfg = load_cli_config(flag_overrides={"sync_store_db_path": "/isolated/x.db"})
    assert cfg is not global_singleton
    assert cfg.sync_store_db_path == "/isolated/x.db"
