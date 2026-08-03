"""MCP SDK ``TokenStorage`` protocol → ``src/agent_config/credentials.py`` 的适配器。

四个方法（get/set × tokens/client_info）落 ``external_credential`` 表：
``namespace = connector:<id>``，槽位 ``tokens`` / ``client_info``（阶段 0a 既定键）。
client_info（DCR 注册结果）必须持久化 —— 否则每次连接都重新注册一个新 client（PRD 硬要求）。

🔴 四个已排雷的缺口（排雷报告 §五，逐个在此处置，各有单测钉死）：
  1. **同步 SQLite → async protocol**：credentials 层是同步 sqlite（busy_timeout 30s），四方法
     全部 ``run_in_threadpool`` 包住 —— 别的进程持写锁时不能冻住 serve-api event loop
     （镜像 ``routers/island.py`` 的 resolve 线程池纪律）。
  2. **AnyUrl 序列化**：``OAuthClientInformationFull.redirect_uris: list[AnyUrl]`` 裸
     ``json.dumps`` 直接 TypeError → 统一 ``model_dump(mode="json")``（首跑即炸类缺口）。
  3. **expires_in 相对秒 → 绝对 epoch**：SDK 的 token response 只有相对秒；存绝对
     ``access_token_expires_at`` 进 payload，读回时重算剩余秒（过期 → 0），返回的
     ``OAuthToken`` 永远说真话。SDK 重启后不重算 expiry（``_initialize`` 不设
     ``token_expiry_time``），跨重启的懒刷新由 ``client.ConnectorClient._prime`` 用这里存的
     绝对值补上。
  4. **刷新时 metadata 保全**：``set_credential`` 是整行替换（不传 metadata 即清空）——
     token 刷新会把 Settings 的 scope 展示凭空抹掉。故 set_tokens 先 peek 旧 metadata 再
     整行回传（刷新响应缺 scope 时沿用旧值）。

🔴 明文列 ``expires_at`` 的语义 = **refresh token / 连接活性**（风险 4）：
  - 有 refresh_token → 写 NULL（refresh token 的绝对寿命服务端不下发：Notion 是 180 天 /
    30 天不活跃，无法可靠预知）——「NULL = 不过期/未知」正是该列的既定语义；
  - 无 refresh_token → access token 就是连接寿命，写它的绝对 epoch。
  access token 的到期时间**恒进加密 payload**（``access_token_expires_at``），不占明文列 ——
  否则 Settings 会天天「即将过期」谎报健康度。
"""

from __future__ import annotations

import time
from typing import Any, Optional

from loguru import logger
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from mcp.shared.auth import OAuthClientInformationFull, OAuthToken

from src.agent_config import credentials

KEY_TOKENS = "tokens"
KEY_CLIENT_INFO = "client_info"


class CredentialTokenStorage:
    """``mcp.client.auth.TokenStorage`` 的 Fernet+Keychain 后端（每 connector 一实例）。

    ``store`` 注入仅供单测（透传给 credentials 层）；生产走 env 单例 agent_config.db。
    """

    def __init__(self, namespace: str, *, store: Any = None) -> None:
        self.namespace = namespace
        self._store = store

    # ── tokens ───────────────────────────────────────────────────────────────

    async def get_tokens(self) -> Optional[OAuthToken]:
        token, _ = await self.get_tokens_with_expiry()
        return token

    async def get_tokens_with_expiry(self) -> tuple[Optional[OAuthToken], Optional[int]]:
        """token + access token 绝对到期 epoch（无/未知 → None）。

        非 protocol 方法 —— ``ConnectorClient._prime`` 用绝对 epoch 恢复 SDK 的跨重启懒刷新
        （缺口 3 的另一半）。返回的 ``OAuthToken.expires_in`` 已重算为**剩余**秒（过期 → 0）。
        """
        payload = await run_in_threadpool(
            credentials.get_credential, self.namespace, KEY_TOKENS, store=self._store
        )
        if payload is None:
            return None, None
        raw = payload.get("token")
        if not isinstance(raw, dict):
            logger.warning(
                "connector token payload malformed (namespace={}) — treating as absent",
                self.namespace,
            )
            return None, None
        expires_at = payload.get("access_token_expires_at")
        if not isinstance(expires_at, int) or isinstance(expires_at, bool):
            expires_at = None
        data = dict(raw)
        if expires_at is not None:
            data["expires_in"] = max(0, expires_at - int(time.time()))
        try:
            token = OAuthToken.model_validate(data)
        except ValidationError:
            logger.warning(
                "connector token payload failed validation (namespace={}) — treating as absent",
                self.namespace,
            )
            return None, None
        return token, expires_at

    async def set_tokens(self, tokens: OAuthToken) -> None:
        now = int(time.time())
        access_expires_at: Optional[int] = None
        if tokens.expires_in is not None:
            access_expires_at = now + int(tokens.expires_in)
        payload = {
            # mode="json"：OAuthToken 当前全是标量，但与 client_info 同纪律（缺口 2）。
            "token": tokens.model_dump(mode="json"),
            "access_token_expires_at": access_expires_at,
        }
        # 缺口 4：整行替换语义下先 peek 旧 metadata 再回传，刷新不抹 scope 展示。
        prev = await run_in_threadpool(
            credentials.peek_credential, self.namespace, KEY_TOKENS, store=self._store
        )
        metadata: dict[str, Any] = dict(prev.metadata) if prev is not None else {}
        if tokens.scope:
            metadata["scope"] = tokens.scope
        # 风险 4：明文列存「连接活性」——有 refresh_token 时 NULL（寿命未知），否则 access 到期。
        column_expires = None if tokens.refresh_token else access_expires_at
        await run_in_threadpool(
            credentials.set_credential,
            self.namespace,
            KEY_TOKENS,
            payload,
            expires_at=column_expires,
            metadata=metadata or None,
            store=self._store,
        )

    # ── client_info（DCR 注册结果）─────────────────────────────────────────────

    async def get_client_info(self) -> Optional[OAuthClientInformationFull]:
        payload = await run_in_threadpool(
            credentials.get_credential, self.namespace, KEY_CLIENT_INFO, store=self._store
        )
        if payload is None:
            return None
        try:
            return OAuthClientInformationFull.model_validate(payload)
        except ValidationError:
            # 形状对不上（SDK 升级 / 密文库回滚）→ 视同缺失 → 走一次全新 DCR，不炸连接。
            logger.warning(
                "connector client_info payload failed validation (namespace={}) — "
                "treating as absent (will re-register)",
                self.namespace,
            )
            return None

    async def set_client_info(self, client_info: OAuthClientInformationFull) -> None:
        # 缺口 2：redirect_uris 是 list[AnyUrl] —— 必须 mode="json" 才可 json.dumps。
        payload = client_info.model_dump(mode="json")
        await run_in_threadpool(
            credentials.set_credential,
            self.namespace,
            KEY_CLIENT_INFO,
            payload,
            store=self._store,
        )
