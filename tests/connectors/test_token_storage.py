"""CredentialTokenStorage 四缺口逐个钉死（排雷报告 §五）＋ expires_at 明文列语义（风险 4）。

纯单测：tmp_path 直建 AgentConfigStore 注入（不碰 env 单例），master key 通道全 mock
（镜像 tests/agent_config/test_credentials.py 的隔离手法 —— 绝不真弹系统钥匙串）。
async 用例沿用本仓范式 ``asyncio.run(_())``（无 asyncio_mode=auto）。
"""

from __future__ import annotations

import asyncio
import time

import pytest
from pydantic import AnyUrl

from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from src.agent_config import credentials, secrets
from src.agent_config.store import AgentConfigStore
from src.connectors.token_storage import KEY_CLIENT_INFO, KEY_TOKENS, CredentialTokenStorage

NS = "connector:notion"


@pytest.fixture(autouse=True)
def _isolate_master_key(monkeypatch, tmp_path):
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(tmp_path))

    def _unavailable(*_a, **_k):
        raise secrets._KeychainUnavailable("forced-unavailable (test)")

    monkeypatch.setattr(secrets, "_run_security", _unavailable)
    secrets.reset_master_key_cache()
    yield
    secrets.reset_master_key_cache()


@pytest.fixture()
def store(tmp_path) -> AgentConfigStore:
    return AgentConfigStore(str(tmp_path / "agent_config.db"))


@pytest.fixture()
def storage(store) -> CredentialTokenStorage:
    return CredentialTokenStorage(NS, store=store)


# ── 缺口 2：AnyUrl 序列化 ─────────────────────────────────────────────────────────


def test_client_info_anyurl_roundtrip(storage):
    """redirect_uris 是 list[AnyUrl] —— 裸 json.dumps 会 TypeError；round-trip 必须原样回来。"""
    info = OAuthClientInformationFull(
        client_id="cid-123",
        redirect_uris=[AnyUrl("http://127.0.0.1:8200/api/connector/oauth/callback")],
        token_endpoint_auth_method="none",
        client_name="MailAgent",
    )

    async def _():
        await storage.set_client_info(info)
        return await storage.get_client_info()

    got = asyncio.run(_())
    assert got is not None
    assert got.client_id == "cid-123"
    assert [str(u) for u in got.redirect_uris] == [str(u) for u in info.redirect_uris]
    assert got.token_endpoint_auth_method == "none"


def test_client_info_absent_and_malformed(storage, store):
    async def _get():
        return await storage.get_client_info()

    assert asyncio.run(_get()) is None
    # 形状对不上（SDK 漂移 / 库回滚）→ 视同缺失（重新 DCR），不炸。
    credentials.set_credential(NS, KEY_CLIENT_INFO, {"redirect_uris": 42}, store=store)
    assert asyncio.run(_get()) is None


# ── 缺口 3：expires_in 相对秒 ↔ 绝对 epoch ───────────────────────────────────────


def test_expires_in_to_absolute_epoch_and_back(storage, store, monkeypatch):
    t0 = 1_800_000_000
    monkeypatch.setattr(time, "time", lambda: float(t0))
    tokens = OAuthToken(
        access_token="at-1", token_type="Bearer", expires_in=3600, refresh_token="rt-1"
    )

    asyncio.run(storage.set_tokens(tokens))

    # 3500s 后读回：expires_in 必须是**剩余** 100s，不是当年的 3600。
    monkeypatch.setattr(time, "time", lambda: float(t0 + 3500))
    got, access_expires_at = asyncio.run(storage.get_tokens_with_expiry())
    assert got is not None
    assert access_expires_at == t0 + 3600
    assert got.expires_in == 100
    assert got.access_token == "at-1"
    assert got.refresh_token == "rt-1"

    # 过期后：clamp 到 0（说真话），token 本体仍返回（refresh 路径要用 refresh_token）。
    monkeypatch.setattr(time, "time", lambda: float(t0 + 9999))
    got2, _ = asyncio.run(storage.get_tokens_with_expiry())
    assert got2 is not None
    assert got2.expires_in == 0


def test_get_tokens_absent(storage):
    async def _():
        return await storage.get_tokens_with_expiry()

    assert asyncio.run(_()) == (None, None)


# ── 缺口 4：刷新时 metadata 保全 ─────────────────────────────────────────────────


def test_refresh_preserves_metadata_scope(storage, store):
    first = OAuthToken(
        access_token="at-1",
        token_type="Bearer",
        expires_in=3600,
        refresh_token="rt-1",
        scope="read write",
    )
    asyncio.run(storage.set_tokens(first))
    meta1 = credentials.peek_credential(NS, KEY_TOKENS, store=store)
    assert meta1 is not None and meta1.metadata.get("scope") == "read write"

    # 刷新响应通常不带 scope —— set_credential 是整行替换，不保全就会抹掉展示位。
    refreshed = OAuthToken(
        access_token="at-2", token_type="Bearer", expires_in=3600, refresh_token="rt-2"
    )
    asyncio.run(storage.set_tokens(refreshed))
    meta2 = credentials.peek_credential(NS, KEY_TOKENS, store=store)
    assert meta2 is not None
    assert meta2.metadata.get("scope") == "read write"  # 保全
    got = asyncio.run(storage.get_tokens())
    assert got is not None and got.access_token == "at-2"  # payload 确实换新


# ── 风险 4：明文列 expires_at = 连接活性（refresh token）语义 ─────────────────────


def test_column_expires_at_semantics(storage, store, monkeypatch):
    t0 = 1_800_000_000
    monkeypatch.setattr(time, "time", lambda: float(t0))

    # 有 refresh_token → 明文列 NULL（refresh 寿命服务端不下发，NULL=未知/不过期）。
    asyncio.run(
        storage.set_tokens(
            OAuthToken(
                access_token="at", token_type="Bearer", expires_in=3600, refresh_token="rt"
            )
        )
    )
    meta = credentials.peek_credential(NS, KEY_TOKENS, store=store)
    assert meta is not None and meta.expires_at is None

    # 无 refresh_token → access token 就是连接寿命 → 列 = 绝对 epoch。
    asyncio.run(
        storage.set_tokens(OAuthToken(access_token="at2", token_type="Bearer", expires_in=3600))
    )
    meta2 = credentials.peek_credential(NS, KEY_TOKENS, store=store)
    assert meta2 is not None and meta2.expires_at == t0 + 3600


# ── 缺口 1：async protocol（线程池包同步 sqlite）＋ SDK 内部形状 canary ────────────


def test_methods_are_awaitable_from_event_loop(storage):
    """四方法都能在 event loop 里 await（run_in_threadpool 包同步 sqlite —— 不炸即约定成立）。"""

    async def _():
        assert await storage.get_tokens() is None
        assert await storage.get_client_info() is None
        await storage.set_tokens(
            OAuthToken(access_token="a", token_type="Bearer", expires_in=60)
        )
        assert (await storage.get_tokens()).access_token == "a"

    asyncio.run(_())


def test_sdk_context_shape_canary():
    """``ConnectorClient._prime`` 依赖的 SDK 内部形状（OAuthContext 公开 dataclass 字段）。

    SDK 升级把这些字段改名/删掉时本测试先红 —— 别让 prime 静默变 no-op（那会退化成
    「重启后过期 token 直接送出 → 401 → 交互式重授权」的原始缺陷）。
    """
    from mcp.client.auth.oauth2 import OAuthContext

    fields = {f.name for f in __import__("dataclasses").fields(OAuthContext)}
    assert {"current_tokens", "token_expiry_time", "client_info"} <= fields
    # is_token_valid 必须消费 token_expiry_time（prime 的生效通道）。
    ctx = OAuthContext.__new__(OAuthContext)
    ctx.current_tokens = OAuthToken(access_token="x", token_type="Bearer")
    ctx.token_expiry_time = time.time() - 10
    assert ctx.is_token_valid() is False
    ctx.token_expiry_time = time.time() + 1000
    assert ctx.is_token_valid() is True
