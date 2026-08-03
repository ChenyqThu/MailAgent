"""外部服务授权凭证的通用保管层（阶段 0a）—— 加密回环、peek 不解密、namespace 隔离、
与 skill secrets 互不可见、delete 幂等、master key 复用（无多余 Keychain service）。

纯单测（tmp_path 直建 store，master key 通道全 mock —— **绝不**真弹系统钥匙串，镜像
``test_secrets.py`` 的隔离手法）。
"""

from __future__ import annotations

import json
import subprocess

import pytest

from src.agent_config import credentials, secrets
from src.agent_config.store import AgentConfigStore

# 哨兵：任何一处明文泄漏（密文列 / keyfile / 元数据）都能被 `in` 检出。
SENTINEL = "ext-cr3d-SENTINEL-xyz"


def _store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_config.db"))


@pytest.fixture(autouse=True)
def _isolate_master_key(monkeypatch, tmp_path):
    """每测试：master key 缓存重置 + keyfile 落 tmp；Keychain 通道默认 mock 成不可用
    （需要 Keychain 通道的测试自行再 monkeypatch ``_run_security``）。"""
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    yield
    secrets.reset_master_key_cache()


# ── 加密回环 + 形状不可知 ────────────────────────────────────────────────────────────


def test_set_get_roundtrip_token_set(tmp_path):
    """OAuth token set 形状：存进去能原样读回来。"""
    st = _store(tmp_path)
    payload = {
        "access_token": SENTINEL,
        "refresh_token": "rt-abc",
        "token_type": "Bearer",
        "scope": ["read", "write"],
    }
    credentials.set_credential("connector:notion", "tokens", payload, expires_at=1800000000, store=st)
    assert credentials.get_credential("connector:notion", "tokens", store=st) == payload


def test_payload_shape_is_agnostic(tmp_path):
    """同一张表装下三种完全不同的形状（token set / client_info / app 凭证）——本层不校验结构。"""
    st = _store(tmp_path)
    shapes = {
        ("connector:notion", "tokens"): {"access_token": "a", "expires_in": 3600},
        ("connector:notion", "client_info"): {
            "client_id": "cid",
            "client_secret": "cs",
            "redirect_uris": ["http://127.0.0.1/cb"],
        },
        ("im:feishu", "app_secret"): {"app_id": "cli_x", "app_secret": SENTINEL},
    }
    for (ns, key), payload in shapes.items():
        credentials.set_credential(ns, key, payload, store=st)
    for (ns, key), payload in shapes.items():
        assert credentials.get_credential(ns, key, store=st) == payload


def test_ciphertext_is_not_plaintext(tmp_path):
    """DB 里的 payload_ciphertext 不含明文哨兵（Fernet 加密）。"""
    st = _store(tmp_path)
    credentials.set_credential("im:feishu", "app_secret", {"app_secret": SENTINEL}, store=st)
    ct = st.get_external_credential_ciphertext("im:feishu", "app_secret")
    assert ct is not None and isinstance(ct, bytes)
    assert SENTINEL.encode() not in ct


def test_get_missing_returns_none(tmp_path):
    st = _store(tmp_path)
    assert credentials.get_credential("connector:notion", "tokens", store=st) is None
    assert credentials.peek_credential("connector:notion", "tokens", store=st) is None
    assert credentials.list_credentials("connector:notion", store=st) == []


# ── 🔴 peek 不解密（expires_at 是明文列）────────────────────────────────────────────


def test_peek_reads_expires_at_without_decrypting(tmp_path, monkeypatch):
    """peek/list 拿到 expires_at 且**一次都没调用 decrypt**；get 才解密。"""
    st = _store(tmp_path)
    credentials.set_credential(
        "connector:notion",
        "tokens",
        {"access_token": SENTINEL},
        expires_at=1800000000,
        metadata={"workspace": "acme"},
        store=st,
    )

    real_decrypt = credentials.decrypt_secret
    calls: list[bytes] = []

    def _spy(ciphertext):
        calls.append(ciphertext)
        return real_decrypt(ciphertext)

    monkeypatch.setattr(credentials, "decrypt_secret", _spy)

    meta = credentials.peek_credential("connector:notion", "tokens", store=st)
    assert meta is not None
    assert meta.expires_at == 1800000000
    assert meta.metadata == {"workspace": "acme"}
    assert credentials.list_credentials("connector:notion", store=st)[0].expires_at == 1800000000
    assert calls == [], "peek/list 绝不能解密 payload"

    # 对照：get 走的是解密路径。
    assert credentials.get_credential("connector:notion", "tokens", store=st) == {
        "access_token": SENTINEL
    }
    assert len(calls) == 1


def test_peek_works_when_master_key_unavailable(tmp_path, monkeypatch):
    """master key 整个拿不到时，peek/list 依然如实回答「存了没、什么时候过期」。

    这是 expires_at 独立明文列的**目的**：设置页的连接健康状态不该因钥匙串不可用而整页失效。
    """
    st = _store(tmp_path)
    credentials.set_credential(
        "connector:jira", "tokens", {"access_token": SENTINEL}, expires_at=1234567890, store=st
    )

    def _boom():
        raise secrets.MasterKeyUnavailable("no master key (test)")

    monkeypatch.setattr(secrets, "_get_master_key", _boom)

    meta = credentials.peek_credential("connector:jira", "tokens", store=st)
    assert meta is not None and meta.expires_at == 1234567890
    assert [m.credential_key for m in credentials.list_credentials("connector:jira", store=st)] == [
        "tokens"
    ]


def test_peek_never_exposes_payload(tmp_path):
    """peek 的返回类型里根本没有 payload 字段（结构性保证，不靠调用方自觉）。"""
    st = _store(tmp_path)
    credentials.set_credential("connector:notion", "tokens", {"access_token": SENTINEL}, store=st)
    meta = credentials.peek_credential("connector:notion", "tokens", store=st)
    assert meta is not None
    assert SENTINEL not in json.dumps(meta.__dict__, ensure_ascii=False)
    assert not hasattr(meta, "payload")


# ── namespace 隔离 ──────────────────────────────────────────────────────────────────


def test_namespace_isolation(tmp_path):
    """同名 credential_key 在不同 namespace 下互不可见、互不覆盖。"""
    st = _store(tmp_path)
    credentials.set_credential("connector:notion", "tokens", {"who": "notion"}, store=st)
    credentials.set_credential("connector:jira", "tokens", {"who": "jira"}, store=st)
    credentials.set_credential("im:feishu", "app_secret", {"who": "feishu"}, store=st)

    assert credentials.get_credential("connector:notion", "tokens", store=st) == {"who": "notion"}
    assert credentials.get_credential("connector:jira", "tokens", store=st) == {"who": "jira"}
    # 跨 namespace 取不到对方的 key。
    assert credentials.get_credential("connector:notion", "app_secret", store=st) is None
    assert credentials.get_credential("im:feishu", "tokens", store=st) is None

    assert [m.credential_key for m in credentials.list_credentials("connector:notion", store=st)] == [
        "tokens"
    ]
    assert [(m.namespace, m.credential_key) for m in credentials.list_credentials(store=st)] == [
        ("connector:jira", "tokens"),
        ("connector:notion", "tokens"),
        ("im:feishu", "app_secret"),
    ]


def test_credentials_and_skill_secrets_are_mutually_invisible(tmp_path):
    """🔴 两张表物理隔离：外部凭证不出现在 skill secret 面，反之亦然。"""
    st = _store(tmp_path)
    secrets.set_secret("dms", "DMS_TOKEN", "skill-side-value", store=st)
    credentials.set_credential("connector:notion", "tokens", {"access_token": SENTINEL}, store=st)

    # skill secret 面看不到外部凭证。
    assert st.list_skill_secret_names("dms") == ["DMS_TOKEN"]
    assert st.list_skill_secret_names("connector:notion") == []
    assert secrets.get_secret("connector:notion", "tokens", store=st) is None
    assert secrets.get_secrets_for_skill("connector:notion", store=st) == {}

    # 外部凭证面看不到 skill secret。
    assert [(m.namespace, m.credential_key) for m in credentials.list_credentials(store=st)] == [
        ("connector:notion", "tokens")
    ]
    assert credentials.get_credential("connector:notion", "dms_token", store=st) is None
    # skill secret 的 skill_name 不是合法 namespace（无冒号）→ 连查都查不进来。
    with pytest.raises(ValueError):
        credentials.get_credential("dms", "dms_token", store=st)


# ── delete ──────────────────────────────────────────────────────────────────────────


def test_delete_is_idempotent(tmp_path):
    st = _store(tmp_path)
    credentials.set_credential("connector:notion", "tokens", {"a": 1}, store=st)
    assert credentials.delete_credential("connector:notion", "tokens", store=st) is True
    assert credentials.get_credential("connector:notion", "tokens", store=st) is None
    assert credentials.peek_credential("connector:notion", "tokens", store=st) is None
    assert credentials.delete_credential("connector:notion", "tokens", store=st) is False


def test_delete_only_targets_one_row(tmp_path):
    st = _store(tmp_path)
    credentials.set_credential("connector:notion", "tokens", {"a": 1}, store=st)
    credentials.set_credential("connector:notion", "client_info", {"b": 2}, store=st)
    credentials.delete_credential("connector:notion", "tokens", store=st)
    assert [m.credential_key for m in credentials.list_credentials("connector:notion", store=st)] == [
        "client_info"
    ]


# ── upsert 语义（整行替换 + created_at 保留）──────────────────────────────────────────


def test_upsert_replaces_payload_and_expiry(tmp_path):
    """token 刷新 = payload 与 expires_at **一起**换掉；不传 expires_at 即清空（不留旧到期时间）。"""
    st = _store(tmp_path)
    credentials.set_credential(
        "connector:notion", "tokens", {"access_token": "old"}, expires_at=1000, store=st
    )
    credentials.set_credential(
        "connector:notion", "tokens", {"access_token": "new"}, expires_at=2000, store=st
    )
    assert credentials.get_credential("connector:notion", "tokens", store=st) == {
        "access_token": "new"
    }
    assert credentials.peek_credential("connector:notion", "tokens", store=st).expires_at == 2000

    credentials.set_credential("connector:notion", "tokens", {"access_token": "no-exp"}, store=st)
    assert credentials.peek_credential("connector:notion", "tokens", store=st).expires_at is None


def test_upsert_preserves_created_at(tmp_path):
    st = _store(tmp_path)
    credentials.set_credential("connector:notion", "tokens", {"v": 1}, store=st)
    first = credentials.peek_credential("connector:notion", "tokens", store=st)
    credentials.set_credential("connector:notion", "tokens", {"v": 2}, store=st)
    second = credentials.peek_credential("connector:notion", "tokens", store=st)
    assert second.created_at == first.created_at
    assert second.updated_at >= first.updated_at


# ── 键形状校验 ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad_ns",
    ["", "notion", "Connector:notion", "connector:", ":notion", "connector notion", "connector:NOTION"],
)
def test_rejects_invalid_namespace(tmp_path, bad_ns):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        credentials.set_credential(bad_ns, "tokens", {"a": 1}, store=st)


@pytest.mark.parametrize("bad_key", ["", "TOKENS", "1tokens", "client-info", "client info"])
def test_rejects_invalid_credential_key(tmp_path, bad_key):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        credentials.set_credential("connector:notion", bad_key, {"a": 1}, store=st)


def test_rejects_non_object_payload_and_bad_expiry(tmp_path):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        credentials.set_credential("connector:notion", "tokens", ["not", "a", "dict"], store=st)
    with pytest.raises(ValueError):
        credentials.set_credential("connector:notion", "tokens", {"a": 1}, expires_at="soon", store=st)
    # bool 是 int 子类 —— 必须显式拒，否则 True 静默变 epoch 1。
    with pytest.raises(ValueError):
        credentials.set_credential("connector:notion", "tokens", {"a": 1}, expires_at=True, store=st)


def test_multi_segment_namespace_allowed(tmp_path):
    """多账号预留：``connector:jira:acme`` 是合法 namespace。"""
    st = _store(tmp_path)
    credentials.set_credential("connector:jira:acme", "tokens", {"a": 1}, store=st)
    assert credentials.get_credential("connector:jira:acme", "tokens", store=st) == {"a": 1}
    assert credentials.get_credential("connector:jira", "tokens", store=st) is None


# ── 损坏密文：get 收敛成「无凭证」，peek 仍可用 ───────────────────────────────────────


def test_undecryptable_payload_reads_as_absent_but_peek_survives(tmp_path):
    st = _store(tmp_path)
    st.upsert_external_credential(
        "connector:notion", "tokens", b"not-a-valid-fernet-token", expires_at=4242
    )
    assert credentials.get_credential("connector:notion", "tokens", store=st) is None
    meta = credentials.peek_credential("connector:notion", "tokens", store=st)
    assert meta is not None and meta.expires_at == 4242


def test_non_object_payload_reads_as_absent(tmp_path):
    """密文解得开但里面不是 JSON 对象（被外部污染）→ 收敛成「无凭证」，不把裸值交出去。"""
    st = _store(tmp_path)
    st.upsert_external_credential(
        "connector:notion", "tokens", secrets.encrypt_secret('"just-a-string"')
    )
    assert credentials.get_credential("connector:notion", "tokens", store=st) is None


# ── master key 复用：同一把钥匙、无多余 Keychain service ──────────────────────────────


class _RecordingKeychain:
    """模拟登录 Keychain 单条 generic-password，并记录每次请求的 ``-s <service>``。"""

    def __init__(self) -> None:
        self.value: str | None = None
        self.services: list[str] = []
        self.add_calls = 0

    def run(self, args, *, stdin_text=None):
        args = list(args)
        if args and args[0] == "find-generic-password":
            self.services.append(args[args.index("-s") + 1])
            if self.value is None:
                return subprocess.CompletedProcess(args, secrets._ERR_SEC_ITEM_NOT_FOUND, "", "")
            return subprocess.CompletedProcess(args, 0, self.value + "\n", "")
        if args and args[0] == "-i":
            assert stdin_text is not None
            toks = stdin_text.split()
            self.services.append(toks[toks.index("-s") + 1])
            self.value = toks[toks.index("-w") + 1]
            self.add_calls += 1
            return subprocess.CompletedProcess(args, 0, "", "")
        return subprocess.CompletedProcess(args, 1, "", "")


def test_reuses_skill_secret_master_key_no_extra_keychain_service(tmp_path, monkeypatch):
    """🔴 外部凭证与 skill secret 共用**同一把** master key、**同一个** Keychain service。

    多一个 service = 多一个用户要授权/迁移/丢失的对象，而威胁模型完全相同。
    """
    st = _store(tmp_path)
    fake = _RecordingKeychain()
    monkeypatch.setattr(secrets, "_run_security", fake.run)
    secrets.reset_master_key_cache()

    credentials.set_credential("connector:notion", "tokens", {"access_token": SENTINEL}, store=st)
    secrets.set_secret("dms", "DMS_TOKEN", "skill-side", store=st)

    assert set(fake.services) == {"MailAgent-SkillSecrets"}, "不得新增第二个 Keychain service"
    assert fake.add_calls == 1, "两侧共用一把 master key —— 只建一次"
    # 同一把钥匙：两侧都读得回来。
    assert credentials.get_credential("connector:notion", "tokens", store=st) == {
        "access_token": SENTINEL
    }
    assert secrets.get_secret("dms", "DMS_TOKEN", store=st) == "skill-side"


def test_module_declares_no_keychain_constants_of_its_own(tmp_path):
    """credentials.py 不得自带 Keychain/keyfile 常量（复制一份 = 迟早漂移成第二套通道）。"""
    for attr in ("_KEYCHAIN_SERVICE", "_SECURITY_BIN", "_keyfile_path", "_get_master_key"):
        assert not hasattr(credentials, attr), f"credentials 不应自持 {attr}"
