"""issue #52 — davmail cipher key 双名兼容实测。

老用户 .env 是 DAVMAIL_CIPHER_KEY（旧文档/报错文案曾用此名），v1.15 起只认
DAVMAIL_POC_CIPHER_KEY 导致升级后 serve 静默罢工。修复 = AliasChoices 双名，
POC 键优先。pydantic-settings 的 env alias 有静默失效前科（config.py 顶
model_config 注释 + test_env_alias_invariant），AliasChoices 的实际读取行为
必须实测锁住，不能只靠静态解析。
"""

import os
from types import SimpleNamespace

import pytest

from src.config import Config
from src.mail.backend.imap_client import DavMailConnectionError, get_cipher_key

_POC_KEY = "DAVMAIL_POC_CIPHER_KEY"
_LEGACY_KEY = "DAVMAIL_CIPHER_KEY"


@pytest.fixture(autouse=True)
def _base_env(monkeypatch):
    monkeypatch.setenv("USER_EMAIL", "a@b.com")
    monkeypatch.delenv(_POC_KEY, raising=False)
    monkeypatch.delenv(_LEGACY_KEY, raising=False)


def _cfg() -> Config:
    return Config(_env_file=os.devnull)


def test_poc_key_read(monkeypatch):
    monkeypatch.setenv(_POC_KEY, "poc-secret")
    assert _cfg().davmail_cipher_key == "poc-secret"


def test_legacy_key_read(monkeypatch):
    """issue #52 本体：老用户只有 DAVMAIL_CIPHER_KEY 也必须读到。"""
    monkeypatch.setenv(_LEGACY_KEY, "legacy-secret")
    assert _cfg().davmail_cipher_key == "legacy-secret"


def test_poc_key_wins_when_both_set(monkeypatch):
    """双键同设时 POC 键优先（AliasChoices 顺序 = 优先级，现行为不变）。"""
    monkeypatch.setenv(_POC_KEY, "poc-secret")
    monkeypatch.setenv(_LEGACY_KEY, "legacy-secret")
    assert _cfg().davmail_cipher_key == "poc-secret"


def test_neither_set_default_empty():
    assert _cfg().davmail_cipher_key == ""


def test_get_cipher_key_error_names_real_keys():
    """报错文案必须提后端实际读取的键名（旧文案教用户设不被读的名字，加重排障误导）。"""
    cfg = SimpleNamespace(davmail_cipher_key="", davmail_poc_mode=False)
    with pytest.raises(DavMailConnectionError) as exc_info:
        get_cipher_key(cfg)
    assert _POC_KEY in str(exc_info.value)
    assert _LEGACY_KEY in str(exc_info.value)
