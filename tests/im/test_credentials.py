"""env 首次 seed → external_credential 行权威（src/im/credentials.py）。

隔离手法镜像 ``tests/agent_config/test_credentials.py``：真 store 落 tmp_path，
master key 通道全 mock —— **绝不**真弹系统钥匙串。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from src.agent_config import credentials as ac_credentials
from src.agent_config import secrets
from src.agent_config.store import AgentConfigStore
from src.im import credentials as im_credentials
from src.im.credentials import (
    KEY_APP_ID,
    KEY_APP_SECRET,
    NAMESPACE,
    SEED_NO_ENV,
    SEED_ROW_EXISTS,
    SEED_WROTE,
)

SENTINEL_SECRET = "im-feishu-SENTINEL-secret"


@pytest.fixture(autouse=True)
def _isolate_master_key(monkeypatch, tmp_path):
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    yield
    secrets.reset_master_key_cache()


def _store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_config.db"))


def _cfg(app_id: str = "cli_seed", app_secret: str = SENTINEL_SECRET, enabled=True):
    return SimpleNamespace(
        im_feishu_enabled=enabled,
        feishu_im_app_id=app_id,
        feishu_im_app_secret=app_secret,
    )


class TestSeed:
    def test_seeds_once_from_env(self, tmp_path):
        st = _store(tmp_path)
        assert im_credentials.seed_from_env(_cfg(), store=st) == SEED_WROTE
        creds = im_credentials.load_credentials(store=st)
        assert creds is not None
        assert (creds.app_id, creds.app_secret) == ("cli_seed", SENTINEL_SECRET)

    def test_row_wins_over_env_on_later_starts(self, tmp_path):
        """🔴 行权威：seed 过之后改 env 不再影响运行时。"""
        st = _store(tmp_path)
        im_credentials.seed_from_env(_cfg("cli_first", "secret_first"), store=st)
        assert (
            im_credentials.seed_from_env(_cfg("cli_CHANGED", "secret_CHANGED"), store=st)
            == SEED_ROW_EXISTS
        )
        creds = im_credentials.load_credentials(store=st)
        assert (creds.app_id, creds.app_secret) == ("cli_first", "secret_first")

    def test_seed_is_idempotent(self, tmp_path):
        st = _store(tmp_path)
        for _ in range(3):
            im_credentials.seed_from_env(_cfg(), store=st)
        rows = ac_credentials.list_credentials(NAMESPACE, store=st)
        assert {r.credential_key for r in rows} == {KEY_APP_ID, KEY_APP_SECRET}

    def test_missing_env_is_not_an_error(self, tmp_path):
        st = _store(tmp_path)
        assert im_credentials.seed_from_env(_cfg("", ""), store=st) == SEED_NO_ENV
        assert im_credentials.load_credentials(store=st) is None

    def test_partial_env_does_not_seed_half_a_pair(self, tmp_path):
        st = _store(tmp_path)
        assert im_credentials.seed_from_env(_cfg("cli_x", ""), store=st) == SEED_NO_ENV
        assert ac_credentials.list_credentials(NAMESPACE, store=st) == []

    def test_secret_never_lands_in_plaintext_columns(self, tmp_path):
        """密文列以外的任何地方都不该出现 secret（metadata 是明文展示位）。"""
        st = _store(tmp_path)
        im_credentials.seed_from_env(_cfg(), store=st)
        im_credentials.record_bot_identity(
            app_id="cli_seed", app_name="MailAgent", bot_open_id="ou_bot", store=st
        )
        metas = ac_credentials.list_credentials(NAMESPACE, store=st)
        blob = "".join(str(m.metadata) for m in metas)
        assert SENTINEL_SECRET not in blob


class TestEnsure:
    def test_ensure_seeds_then_loads(self, tmp_path):
        st = _store(tmp_path)
        creds = im_credentials.ensure_credentials(_cfg(), store=st)
        assert creds is not None and creds.app_id == "cli_seed"

    def test_ensure_swallows_backend_failure(self, tmp_path, monkeypatch):
        """凭证层挂掉只该让 worker 不起，不该把 serve 带崩。"""

        def _boom(*_a, **_k):
            raise RuntimeError("agent_config.db unreadable")

        monkeypatch.setattr(im_credentials, "seed_from_env", _boom)
        assert im_credentials.ensure_credentials(_cfg(), store=_store(tmp_path)) is None

    def test_repr_does_not_leak_secret(self):
        creds = im_credentials.FeishuAppCredentials(
            app_id="cli_abcdefgh", app_secret=SENTINEL_SECRET
        )
        assert SENTINEL_SECRET not in repr(creds)


class TestBotIdentity:
    def test_records_app_name_and_open_id_as_plaintext_metadata(self, tmp_path):
        """破同名陷阱：设置页要能显示「你连的是哪个 bot」。"""
        st = _store(tmp_path)
        im_credentials.seed_from_env(_cfg(), store=st)
        assert im_credentials.record_bot_identity(
            app_id="cli_seed", app_name="MailAgent", bot_open_id="ou_bot", store=st
        )
        meta = ac_credentials.peek_credential(NAMESPACE, KEY_APP_ID, store=st)
        assert meta.metadata.get("app_name") == "MailAgent"
        assert meta.metadata.get("bot_open_id") == "ou_bot"
        # 🔴 set_credential 是整行替换 —— payload 必须还在（否则凭证被写坏）
        assert im_credentials.load_credentials(store=st).app_id == "cli_seed"

    def test_no_row_means_no_write(self, tmp_path):
        st = _store(tmp_path)
        assert (
            im_credentials.record_bot_identity(
                app_id="cli_x", app_name="n", bot_open_id="o", store=st
            )
            is False
        )
