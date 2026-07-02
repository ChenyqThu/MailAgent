"""per-skill 密钥加解密（S2 W3）—— Fernet 密文落库、master key Keychain/keyfile 通道、注入侧
二重校验、哨兵值不进密文/日志。

纯单测（tmp_path 直建 store，master key 通道全 mock —— **绝不**真弹系统钥匙串）。
"""

from __future__ import annotations

import os
import stat
import subprocess

import pytest

from src.agent_config import secrets
from src.agent_config.store import AgentConfigStore

SENTINEL = "s3ntinel-secret-VALUE-xyz"


def _store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_config.db"))


def _force_keyfile(monkeypatch):
    """把 Keychain 通道 mock 成不可用 → 走 keyfile fallback（默认隔离，不碰真钥匙串）。"""

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)


@pytest.fixture(autouse=True)
def _isolate_master_key(monkeypatch, tmp_path):
    """每测试：master key 缓存重置 + keyfile 落 tmp（不污染真 DATA_ROOT）。默认强制 keyfile 通道；
    需要 Keychain 通道的测试自行再 monkeypatch _run_security。"""
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))
    _force_keyfile(monkeypatch)
    secrets.reset_master_key_cache()
    yield
    secrets.reset_master_key_cache()


# ── 基本回环 + 密文不透明 ───────────────────────────────────────────────────────────


def test_set_get_roundtrip(tmp_path):
    st = _store(tmp_path)
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=st)
    assert secrets.get_secret("dms", "DMS_TOKEN", store=st) == SENTINEL
    assert secrets.get_secrets_for_skill("dms", store=st) == {"DMS_TOKEN": SENTINEL}


def test_ciphertext_is_not_plaintext(tmp_path):
    """DB 里的 value_ciphertext 不含明文哨兵（Fernet 加密）。"""
    st = _store(tmp_path)
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=st)
    ct = st.get_skill_secret_ciphertext("dms", "DMS_TOKEN")
    assert ct is not None and isinstance(ct, bytes)
    assert SENTINEL.encode() not in ct


def test_get_missing_returns_none(tmp_path):
    st = _store(tmp_path)
    assert secrets.get_secret("dms", "NOPE", store=st) is None
    assert secrets.get_secrets_for_skill("dms", store=st) == {}


def test_delete_secret_idempotent(tmp_path):
    st = _store(tmp_path)
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=st)
    assert secrets.delete_secret("dms", "DMS_TOKEN", store=st) is True
    assert secrets.get_secret("dms", "DMS_TOKEN", store=st) is None
    assert secrets.delete_secret("dms", "DMS_TOKEN", store=st) is False  # 幂等


def test_set_replaces_existing(tmp_path):
    st = _store(tmp_path)
    secrets.set_secret("dms", "DMS_TOKEN", "old", store=st)
    secrets.set_secret("dms", "DMS_TOKEN", "new", store=st)
    assert secrets.get_secret("dms", "DMS_TOKEN", store=st) == "new"


# ── secret 名校验（含 W3 新增 deny）────────────────────────────────────────────────


@pytest.mark.parametrize("bad", ["PATH", "NODE_OPTIONS", "BASH_ENV", "ENV", "IFS", "LD_PRELOAD",
                                 "DYLD_INSERT_LIBRARIES", "MAILAGENT_X", "token", "1BAD"])
def test_set_rejects_reserved_or_invalid_names(tmp_path, bad):
    st = _store(tmp_path)
    with pytest.raises(ValueError):
        secrets.set_secret("dms", bad, "x", store=st)


# ── 注入侧二重校验（get_secrets_for_skill 跳过被污染的库行）──────────────────────────


def test_injection_skips_illegal_name_in_db(tmp_path):
    """DB 被外部污染塞进一个 reserved 名的密钥（绕过 set_secret 校验）→ 注入时二重校验跳过。"""
    st = _store(tmp_path)
    # 直接 upsert 一个非法名（模拟污染），外加一个合法名。
    st.upsert_skill_secret("dms", "PATH", secrets.encrypt_secret("evil"))
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=st)
    result = secrets.get_secrets_for_skill("dms", store=st)
    assert result == {"DMS_TOKEN": SENTINEL}  # PATH 被二重校验跳过


def test_injection_skips_undecryptable_ciphertext(tmp_path):
    """密文损坏（master key 轮换 / 篡改）→ 跳过该 secret，不连累其它。"""
    st = _store(tmp_path)
    st.upsert_skill_secret("dms", "BROKEN", b"not-a-valid-fernet-token")
    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=st)
    result = secrets.get_secrets_for_skill("dms", store=st)
    assert result == {"DMS_TOKEN": SENTINEL}


# ── keyfile fallback：0600 + warning ────────────────────────────────────────────────


def test_keyfile_fallback_creates_0600_and_warns(tmp_path, caplog):
    st = _store(tmp_path)
    import logging

    from loguru import logger as _lg

    sink_id = _lg.add(caplog.handler, format="{message}", level="WARNING")
    caplog.set_level(logging.WARNING)
    try:
        secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=st)  # 触发 master key 建
    finally:
        _lg.remove(sink_id)
    keyfile = os.path.join(str(tmp_path), "data", "skill_secrets.key")
    assert os.path.exists(keyfile)
    assert stat.S_IMODE(os.stat(keyfile).st_mode) == 0o600
    assert "keyfile fallback" in caplog.text
    # keyfile 里是 master key（Fernet key），**不是**哨兵值。
    with open(keyfile, "rb") as fh:
        assert SENTINEL.encode() not in fh.read()


# ── Keychain 通道：值经 stdin 不进 argv ────────────────────────────────────────────


class _FakeKeychain:
    """模拟登录 Keychain 单条 generic-password：find 未存前 rc=44，存后 rc=0 回值；add via `-i`
    经 stdin 喂命令行。记录所有调用供断言 argv 不含 key 值。"""

    def __init__(self) -> None:
        self.value: str | None = None
        self.calls: list[tuple[list[str], str | None]] = []

    def run(self, args, *, stdin_text=None):
        self.calls.append((list(args), stdin_text))
        if args and args[0] == "find-generic-password":
            if self.value is None:
                return subprocess.CompletedProcess(args, secrets._ERR_SEC_ITEM_NOT_FOUND, "", "")
            return subprocess.CompletedProcess(args, 0, self.value + "\n", "")
        if args and args[0] == "-i":
            assert stdin_text is not None
            toks = stdin_text.split()
            self.value = toks[toks.index("-w") + 1]  # 从 stdin 命令行提取 key 值
            return subprocess.CompletedProcess(args, 0, "", "")
        return subprocess.CompletedProcess(args, 1, "", "")


def test_keychain_channel_value_via_stdin_not_argv(tmp_path, monkeypatch):
    st = _store(tmp_path)
    fake = _FakeKeychain()
    monkeypatch.setattr(secrets, "_run_security", fake.run)
    secrets.reset_master_key_cache()

    secrets.set_secret("dms", "DMS_TOKEN", SENTINEL, store=st)
    assert secrets.get_secret("dms", "DMS_TOKEN", store=st) == SENTINEL

    # master key 被存进 Keychain（fake.value 非空），且 key 值**只**出现在某个 `-i` 调用的 stdin，
    # **绝不**出现在任何调用的 argv（防 ps/argv 泄漏）。
    assert fake.value is not None
    add_calls = [c for c in fake.calls if c[0][:1] == ["-i"]]
    assert add_calls, "expected an `security -i` add call"
    assert any(fake.value in (stdin or "") for _args, stdin in add_calls)
    for args, _stdin in fake.calls:
        assert fake.value not in " ".join(args), "master key must never appear in argv"


def test_keychain_read_hit_skips_create(tmp_path, monkeypatch):
    """Keychain 已有 key（find rc=0）→ 直接用，不再 add。"""
    fake = _FakeKeychain()
    fake.value = "pre-existing-fernet-key="  # 预置（形状无所谓，本测试只验证不再走 add）
    monkeypatch.setattr(secrets, "_run_security", fake.run)
    secrets.reset_master_key_cache()
    # 用这个预置 key 触发一次解析。
    _ = secrets._get_master_key()
    assert not any(c[0][:1] == ["-i"] for c in fake.calls)  # 命中读 → 无 add


def test_master_key_cached_across_calls(tmp_path, monkeypatch):
    """master key 首次解析后进程内缓存 —— 不反复弹 security。"""
    st = _store(tmp_path)
    fake = _FakeKeychain()
    monkeypatch.setattr(secrets, "_run_security", fake.run)
    secrets.reset_master_key_cache()
    secrets.set_secret("dms", "A", "1", store=st)
    n_after_first = len(fake.calls)
    secrets.set_secret("dms", "B", "2", store=st)
    secrets.get_secret("dms", "A", store=st)
    assert len(fake.calls) == n_after_first  # 后续无新的 security 调用（缓存命中）
