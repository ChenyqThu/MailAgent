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


class TestSaveCredentials:
    """设置页表单写入（``POST /api/im/credential`` 的落库层）。"""

    def test_writes_a_usable_pair_from_scratch(self, tmp_path):
        st = _store(tmp_path)
        assert im_credentials.save_credentials("cli_ui", "secret_ui", store=st) is False
        creds = im_credentials.load_credentials(store=st)
        assert (creds.app_id, creds.app_secret) == ("cli_ui", "secret_ui")

    def test_overwrites_the_row_env_seeded(self, tmp_path):
        """🔴 与 env seed 写的是同一对行 —— 表单写完即行权威，不是第二个事实来源。"""
        st = _store(tmp_path)
        im_credentials.seed_from_env(_cfg("cli_seed", SENTINEL_SECRET), store=st)
        im_credentials.save_credentials("cli_seed", "rotated_secret", store=st)
        creds = im_credentials.load_credentials(store=st)
        assert (creds.app_id, creds.app_secret) == ("cli_seed", "rotated_secret")
        # 之后再启动一次也不会被 env 顶回去
        assert (
            im_credentials.seed_from_env(_cfg("cli_seed", SENTINEL_SECRET), store=st)
            == SEED_ROW_EXISTS
        )
        assert im_credentials.load_credentials(store=st).app_secret == "rotated_secret"

    def test_reports_app_change(self, tmp_path):
        """换了另一个自建应用 → True（调用方据此解绑：open_id 按应用签发）。"""
        st = _store(tmp_path)
        im_credentials.save_credentials("cli_first", "s1", store=st)
        assert im_credentials.save_credentials("cli_first", "s2", store=st) is False
        assert im_credentials.save_credentials("cli_second", "s3", store=st) is True

    def test_keeps_bot_identity_on_secret_rotation(self, tmp_path):
        """同 app 轮换 secret：连上后回填的展示位要留着，别让设置页倒退成「名称未知」。"""
        st = _store(tmp_path)
        im_credentials.save_credentials("cli_same", "s1", store=st)
        im_credentials.record_bot_identity(
            app_id="cli_same", app_name="MailAgent", bot_open_id="ou_bot", store=st
        )
        im_credentials.save_credentials("cli_same", "s2", store=st)
        meta = ac_credentials.peek_credential(NAMESPACE, KEY_APP_ID, store=st)
        assert meta.metadata.get("app_name") == "MailAgent"
        assert meta.metadata.get("bot_open_id") == "ou_bot"

    def test_drops_stale_bot_identity_when_app_changes(self, tmp_path):
        """🔴 换应用后旧 bot 的名字/open_id 就是别人的身份 —— 正是 C6 同名陷阱要防的误导。"""
        st = _store(tmp_path)
        im_credentials.save_credentials("cli_first", "s1", store=st)
        im_credentials.record_bot_identity(
            app_id="cli_first", app_name="MailAgent", bot_open_id="ou_old", store=st
        )
        im_credentials.save_credentials("cli_second", "s2", store=st)
        meta = ac_credentials.peek_credential(NAMESPACE, KEY_APP_ID, store=st)
        assert meta.metadata.get("app_id") == "cli_second"  # 用户刚亲手填的，可信
        assert meta.metadata.get("app_name") == ""
        assert meta.metadata.get("bot_open_id") == ""

    def test_detects_app_change_even_when_the_ciphertext_is_unreadable(self, tmp_path, monkeypatch):
        """🔴 master key 丢了照样判得出「换了应用」—— 靠明文 metadata 腿。

        这不是假想：``get_credential`` 解不开就返回 None，而「worker 报凭证不可解密」
        **正是**用户跑来这个表单的时刻。只用密文腿的话这里会判成「不知道换没换」→ 不解绑
        → 换了应用的人拿到「设置页显示已绑定、bot 永远不理人」这种查不出的状态。
        反过来的误判（多解绑一次）只是重走一遍绑定码，可恢复且响应里明说。
        """
        st = _store(tmp_path)
        im_credentials.save_credentials("cli_first", "s1", store=st)
        # 密文腿整条断掉（等价于 master key 换了/丢了）
        monkeypatch.setattr(ac_credentials, "get_credential", lambda *a, **k: None)
        assert im_credentials.save_credentials("cli_second", "s2", store=st) is True
        assert im_credentials.save_credentials("cli_second", "s3", store=st) is False

    def test_env_seed_records_plaintext_app_id(self, tmp_path):
        """env seed 也把 app_id 写进明文 metadata。

        ① 设置页在 bot 首次连上之前就能如实显示配的是哪个 app（否则「App ID —」，而这个
        值明明就在行里、只是被加密了）；② 上面那条明文腿要靠它。app_id 不是 secret ——
        ``/status`` 本来就把它摆出来（破 C6 同名陷阱的整个前提）。
        """
        st = _store(tmp_path)
        assert im_credentials.seed_from_env(_cfg("cli_seed", SENTINEL_SECRET), store=st) == SEED_WROTE
        meta = ac_credentials.peek_credential(NAMESPACE, KEY_APP_ID, store=st)
        assert meta.metadata.get("app_id") == "cli_seed"
        # 同一行的 secret 仍只在密文列（metadata 是明文展示位）
        metas = ac_credentials.list_credentials(NAMESPACE, store=st)
        assert SENTINEL_SECRET not in "".join(str(m.metadata) for m in metas)

    def test_secret_never_lands_in_plaintext_columns(self, tmp_path):
        st = _store(tmp_path)
        im_credentials.save_credentials("cli_ui", SENTINEL_SECRET, store=st)
        metas = ac_credentials.list_credentials(NAMESPACE, store=st)
        assert SENTINEL_SECRET not in "".join(str(m.metadata) for m in metas)

    @pytest.mark.parametrize("pair", [("", "s"), ("cli_x", ""), ("  ", "s")])
    def test_rejects_half_a_pair(self, tmp_path, pair):
        """``load_credentials`` 要两把都在，写一半只会做出「看着已配置却连不上」的行。"""
        st = _store(tmp_path)
        with pytest.raises(ValueError):
            im_credentials.save_credentials(pair[0], pair[1], store=st)
        assert ac_credentials.list_credentials(NAMESPACE, store=st) == []


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
