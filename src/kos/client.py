"""KOS MCP client - OAuth 2.1 client_credentials + JSON-RPC over HTTP with SSE.

跟 2026-05-17 §6.28 cutover 后的 Jarvis KOS v2 MCP wire 协议对齐 (老
KOS-v1 REST `KOS_API_KEY` plaintext bearer 在那天退役, kos-compat-api.ts
进了 _archived/).

Flow:
    1. POST /token (form-urlencoded grant_type=client_credentials) → 1h
       access_token (无 refresh, 401 重换)
    2. POST /mcp Authorization: Bearer <token>, body JSON-RPC tools/call
    3. Response Content-Type: text/event-stream — 提取 'data: <json>' 行
       JSON.parse (server-sent events format, 不是 raw JSON)
    4. JSON-RPC result.content[0].text 通常是 JSON-encoded payload, 再
       JSON.parse 一次 → 得到 caller-friendly value (list/dict)

Token cache: in-memory + expires_at; 单 process 足够 (mail-sync /
mailagent CLI 都是单进程). 60s 安全缓冲防 race.

Rate limit: 50 req / 15min — client 不主动 throttle, server 429 由上层
caller decide (chat agent fallback 到本地 FTS5).

Endpoint 速查:
    GET /health (no auth) → {status, version, engine}
    POST /token (no auth, form-urlencoded) → {access_token, expires_in, ...}
    POST /mcp (Bearer) JSON-RPC tools/call (SSE response)
        - query (query, limit?, expand?) → list of retrieval hits
        - list_pages (limit, type?, tag?, updated_after?, sort?)
        - put_page (slug, content) — content 含 YAML frontmatter

完整 wire spec 见 mac mini 上 docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from loguru import logger


_DEFAULT_SCOPE = "read write"
_TOKEN_SAFETY_BUFFER_SEC = 60.0

#: 拿不到 config 时的兜底请求超时 (秒)。正常路径读 ``KOS_TIMEOUT_SECONDS``
#: (src/config.py ``kos_timeout_seconds``, 默认同为 30) —— issue #69 之前这里是
#: 硬编码 10.0 而那个 env 键无人读取。
_FALLBACK_TIMEOUT = 30.0

#: GET /health 探活的独立上限 (秒)。**有意不跟随** ``KOS_TIMEOUT_SECONDS``:
#: health 是免 auth 的存活探针 (正常 <100ms), 而 new_watcher 第 6c 步的
#: 「探活失败 → 整段跳过 + 冷却」语义要靠它**快速判死** —— 让 5s tick 挂在一个
#: 30s 的 health 上, 等于把查询超时的放宽代价转嫁给同步主循环。
#: 与请求超时取 min: 把总超时调到 <5s 的人不该在 health 上等更久。
_DEFAULT_HEALTH_TIMEOUT = 5.0


def _configured_timeout() -> float:
    """``KOS_TIMEOUT_SECONDS`` (pydantic) → 请求超时; 不可用/非正 → 兜底 30s.

    函数内 import: client 被 CLI / worker / serve-api 三种进程复用, 顶层 import
    config 会把 pydantic 的 .env 解析拖进每个 import 者的启动路径。
    """
    try:
        from src.config import config as settings

        value = float(settings.kos_timeout_seconds)
    except Exception:  # noqa: BLE001 — 配置不可用绝不能让 client 构造失败
        return _FALLBACK_TIMEOUT
    return value if value > 0 else _FALLBACK_TIMEOUT


def _timeout_note(elapsed: float, limit_desc: str) -> str:
    """超时分支的可诊断文案 (issue #69): 实际耗时 + 生效上限是多少、来自哪。

    没有它, ``E_KOS_NETWORK: ... ReadTimeout`` 里「服务挂了」和「查询太慢」长得
    一模一样 —— 模型选不出该 fallback 还是该重试, 用户也不知道该不该调大上限。
    """
    return f"timed out after {elapsed:.1f}s ({limit_desc})"


@dataclass
class KOSTokenCache:
    """In-memory OAuth access_token cache."""
    token: Optional[str] = None
    expires_at: float = 0.0

    def is_valid(self) -> bool:
        """token 存在且离过期还有 ≥ 60s."""
        return (
            self.token is not None
            and time.time() < self.expires_at - _TOKEN_SAFETY_BUFFER_SEC
        )


class KOSError(Exception):
    """KOS client 统一 error wrapper.

    code 是一个 stable string 让 caller 决定如何处理 (fallback 还是 raise):
        E_KOS_NOT_CONFIGURED - env var 缺失
        E_KOS_HEALTH         - GET /health 失败
        E_KOS_NETWORK        - HTTP 层异常 (connect / timeout / TLS)
        E_KOS_TOKEN_NETWORK  - /token 网络层错
        E_KOS_TOKEN_HTTP     - /token 返非 200
        E_KOS_TOKEN_INVALID  - /token 200 但 response 缺 access_token
        E_KOS_UNAUTHORIZED   - /mcp 401 (token 失效 / 权限不足)
        E_KOS_RATE_LIMIT     - /mcp 429 (50/15min)
        E_KOS_HTTP           - /mcp 其他 4xx/5xx
        E_KOS_PARSE          - SSE 提取失败 / JSON parse 失败
        E_KOS_RPC            - JSON-RPC envelope error 字段非空
    """

    def __init__(
        self,
        message: str,
        code: str = "E_KOS_UNKNOWN",
        status: Optional[int] = None,
    ):
        super().__init__(message)
        self.code = code
        self.status = status


class KOSClient:
    """KOS MCP client - OAuth 2.1 + JSON-RPC over HTTP with SSE response parsing.

    Lazy auth: 第一次调 tool 才 fetch token. 401 自动 refetch + retry 一次.
    Config 来源优先级: 构造参数 > env var.
    Env var: KOS_MCP_BASE / KOS_OAUTH_CLIENT_ID / KOS_OAUTH_CLIENT_SECRET.

    超时两档 (issue #69): ``timeout`` 罩 /token + /mcp, 默认读
    ``KOS_TIMEOUT_SECONDS`` (30s); ``health_timeout`` 罩 GET /health, 默认 5s 且
    不跟随前者 —— 理由见 ``_DEFAULT_HEALTH_TIMEOUT``。

    Usage:
        >>> client = KOSClient()  # env var 注入
        >>> client.health()
        {'status': 'ok', 'version': '0.38.2.0', 'engine': 'postgres'}
        >>> hits = client.query("redis timeout", limit=5)
        >>> client.put_page("sources/mailagent-abc", "---\\ntype: source\\n...---\\nbody")
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        *,
        timeout_seconds: Optional[float] = None,
        health_timeout_seconds: Optional[float] = None,
        scope: str = _DEFAULT_SCOPE,
        http_client: Optional[httpx.Client] = None,
    ):
        self.base_url = (base_url or os.getenv("KOS_MCP_BASE") or "").rstrip("/")
        self.client_id = client_id or os.getenv("KOS_OAUTH_CLIENT_ID") or ""
        self.client_secret = client_secret or os.getenv("KOS_OAUTH_CLIENT_SECRET") or ""
        # None = 读 KOS_TIMEOUT_SECONDS; 显式值仍然优先 (单测 / 特殊调用方)。
        self.timeout = (
            timeout_seconds if timeout_seconds is not None else _configured_timeout()
        )
        self.health_timeout = (
            health_timeout_seconds
            if health_timeout_seconds is not None
            else min(_DEFAULT_HEALTH_TIMEOUT, self.timeout)
        )
        self.scope = scope
        self._token = KOSTokenCache()
        # http_client 注入是为单测 mock (httpx MockTransport); 生产用默认 None
        self._http = http_client

    @property
    def configured(self) -> bool:
        """3 个 env 都有值才 configured."""
        return bool(self.base_url and self.client_id and self.client_secret)

    # ============================================================
    # Public API
    # ============================================================

    def health(self) -> dict[str, Any]:
        """GET /health (免 auth). 返 {'status':'ok','version':...,'engine':...}.

        用 ``health_timeout`` (默认 5s) 而非请求超时 —— 见 _DEFAULT_HEALTH_TIMEOUT。
        """
        if not self.base_url:
            raise KOSError(
                "KOS_MCP_BASE not configured", code="E_KOS_NOT_CONFIGURED"
            )
        started = time.monotonic()
        try:
            r = self._client().get(
                f"{self.base_url}/health", timeout=self.health_timeout
            )
            r.raise_for_status()
            return r.json()
        except httpx.HTTPStatusError as e:
            raise KOSError(
                f"health HTTP {e.response.status_code}",
                code="E_KOS_HEALTH",
                status=e.response.status_code,
            ) from e
        except httpx.TimeoutException as e:
            note = _timeout_note(
                time.monotonic() - started,
                f"health probe limit {self.health_timeout:g}s, "
                f"independent of KOS_TIMEOUT_SECONDS",
            )
            raise KOSError(f"health probe {note}", code="E_KOS_HEALTH") from e
        except httpx.HTTPError as e:
            raise KOSError(f"health request failed: {e}", code="E_KOS_HEALTH") from e

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        """JSON-RPC tools/call wrapper. 返 caller-friendly parsed value.

        result.content[0].text 通常是 JSON-encoded array/dict, 自动解一层
        JSON.parse 后返 list/dict; 若不是 JSON 就原样返 string.

        401 → token expired → 自动 refetch + retry 一次 (无限重试避免死循环).
        """
        if not self.configured:
            raise KOSError(
                "KOS client not fully configured "
                "(need KOS_MCP_BASE + KOS_OAUTH_CLIENT_ID + KOS_OAUTH_CLIENT_SECRET)",
                code="E_KOS_NOT_CONFIGURED",
            )

        body = self._build_rpc_body(name, arguments)
        try:
            return self._post_mcp(body)
        except KOSError as e:
            if e.code == "E_KOS_UNAUTHORIZED":
                logger.debug("KOS 401, refreshing token + retry once")
                self._token = KOSTokenCache()
                return self._post_mcp(body)
            raise

    def query(
        self,
        query: str,
        *,
        limit: int = 10,
        expand: bool = False,
    ) -> list[dict[str, Any]]:
        """tools/call name='query' 便捷.

        返 retrieval hit array — 每条含 slug / title / type / page_id /
        chunk_text / score / modality / effective_date 等 (跟 KOS-v1 老
        /query 不同: 不再 LLM-synthesize, 直接 retrieval).
        """
        result = self.call_tool(
            "query",
            {"query": query, "limit": limit, "expand": expand},
        )
        if isinstance(result, list):
            return result
        # 防御: 老协议 / 异常情况 result 不是 list
        return []

    def list_pages(
        self,
        *,
        limit: int = 50,
        type: Optional[str] = None,
        tag: Optional[str] = None,
        updated_after: Optional[str] = None,
        sort: Optional[str] = None,
    ) -> Any:
        """tools/call name='list_pages' 便捷. limit cap 100."""
        args: dict[str, Any] = {"limit": min(limit, 100)}
        if type is not None:
            args["type"] = type
        if tag is not None:
            args["tag"] = tag
        if updated_after is not None:
            args["updated_after"] = updated_after
        if sort is not None:
            args["sort"] = sort
        return self.call_tool("list_pages", args)

    def put_page(self, slug: str, content: str) -> dict[str, Any]:
        """tools/call name='put_page' 便捷.

        Args:
            slug: 'sources/mailagent-{message_id_normalized}' 风格的 page slug
            content: 含 YAML frontmatter 的整篇 markdown (见 wire spec §7.1)

        Returns:
            {slug, status: 'created_or_updated' | 'skipped',
             chunks: N, facts_backstop: {queued: bool}, writer_lint: {...}}
        """
        result = self.call_tool("put_page", {"slug": slug, "content": content})
        if isinstance(result, dict):
            return result
        return {"raw": result}

    # ============================================================
    # Internal
    # ============================================================

    def _client(self) -> httpx.Client:
        """Lazy http_client. 单测可注入 mock; 生产默认 None → on-demand fresh client."""
        if self._http is not None:
            return self._http
        return httpx.Client()

    @staticmethod
    def _build_rpc_body(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": str(int(time.time() * 1000)),
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }

    def _get_token(self) -> str:
        if self._token.is_valid():
            assert self._token.token is not None
            return self._token.token
        return self._refresh_token()

    def _refresh_token(self) -> str:
        """POST /token client_credentials grant → 1h access_token."""
        started = time.monotonic()
        try:
            r = self._client().post(
                f"{self.base_url}/token",
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "scope": self.scope,
                },
                timeout=self.timeout,
            )
        except httpx.TimeoutException as e:
            note = _timeout_note(
                time.monotonic() - started,
                f"KOS_TIMEOUT_SECONDS={self.timeout:g}",
            )
            raise KOSError(
                f"token request {note}", code="E_KOS_TOKEN_NETWORK"
            ) from e
        except httpx.HTTPError as e:
            raise KOSError(
                f"token request network error: {e}", code="E_KOS_TOKEN_NETWORK"
            ) from e

        if r.status_code != 200:
            raise KOSError(
                f"token request HTTP {r.status_code}: {r.text[:200]}",
                code="E_KOS_TOKEN_HTTP",
                status=r.status_code,
            )
        try:
            data = r.json()
        except ValueError as e:
            raise KOSError(
                f"/token response not JSON: {e}", code="E_KOS_TOKEN_INVALID"
            ) from e

        token = data.get("access_token")
        expires_in = float(data.get("expires_in", 3600))
        if not token:
            raise KOSError(
                "/token response missing access_token",
                code="E_KOS_TOKEN_INVALID",
            )
        self._token = KOSTokenCache(
            token=token, expires_at=time.time() + expires_in
        )
        logger.debug(f"KOS token refreshed, expires in {int(expires_in)}s")
        return token

    def _post_mcp(self, body: dict[str, Any]) -> Any:
        """POST /mcp + parse SSE / JSON response + JSON-RPC envelope check."""
        token = self._get_token()
        started = time.monotonic()
        try:
            r = self._client().post(
                f"{self.base_url}/mcp",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                },
                json=body,
                timeout=self.timeout,
            )
        except httpx.TimeoutException as e:
            # 超时 ≠ 不可达: KOS 在, 只是这次检索没跑完 (大库 + 向量检索)。文案要
            # 让 caller 分得清 —— 否则模型对着 "request failed" 只能猜要不要 fallback。
            note = _timeout_note(
                time.monotonic() - started,
                f"KOS_TIMEOUT_SECONDS={self.timeout:g}",
            )
            raise KOSError(
                f"MCP request {note}; KOS reachable but the query did not finish "
                "— narrow the query or raise KOS_TIMEOUT_SECONDS",
                code="E_KOS_NETWORK",
            ) from e
        except httpx.HTTPError as e:
            raise KOSError(f"MCP request failed: {e}", code="E_KOS_NETWORK") from e

        if r.status_code == 401:
            raise KOSError(
                "MCP 401 unauthorized (token expired or scope mismatch)",
                code="E_KOS_UNAUTHORIZED",
                status=401,
            )
        if r.status_code == 429:
            raise KOSError(
                "MCP rate limited (50 req / 15min)",
                code="E_KOS_RATE_LIMIT",
                status=429,
            )
        if r.status_code >= 400:
            raise KOSError(
                f"MCP HTTP {r.status_code}: {r.text[:200]}",
                code="E_KOS_HTTP",
                status=r.status_code,
            )

        content_type = (r.headers.get("content-type") or "").lower()
        if "text/event-stream" in content_type:
            envelope = self._extract_sse_envelope(r.text)
        else:
            try:
                envelope = r.json()
            except ValueError as e:
                raise KOSError(
                    f"MCP response not JSON: {e}", code="E_KOS_PARSE"
                ) from e

        # JSON-RPC envelope: {jsonrpc, id, result|error}
        if isinstance(envelope, dict) and envelope.get("error"):
            err = envelope["error"]
            msg = err.get("message", str(err)) if isinstance(err, dict) else str(err)
            code = (
                err.get("code") if isinstance(err, dict) else None
            )
            raise KOSError(
                f"MCP JSON-RPC error: {msg}",
                code="E_KOS_RPC",
                status=code,
            )

        result = (
            envelope.get("result", envelope) if isinstance(envelope, dict) else envelope
        )
        # Tool-level error: MCP result {content:[...], isError: true} — 例如 KOS
        # embedding 失败 (Gemini key leaked / spending cap) 或 content-sanity reject。
        # JSON-RPC envelope 此时无 error (传输层 OK), 上面的 envelope.error 检测漏掉它。
        # 必须在这里 raise, 否则 caller (bulk_ingest / push_email_to_kos) 会把 error
        # JSON 当成功 (status=None) 误记 pushed, 实际 page 没入 (page_not_found)。
        if isinstance(result, dict) and result.get("isError"):
            unwrapped = self._unwrap_tool_result(result)
            msg = (
                (unwrapped.get("message") or unwrapped.get("error") or str(unwrapped))
                if isinstance(unwrapped, dict)
                else str(unwrapped)
            )
            raise KOSError(f"MCP tool error: {msg}", code="E_KOS_TOOL_ERROR")
        return self._unwrap_tool_result(result)

    @staticmethod
    def _extract_sse_envelope(body: str) -> dict[str, Any]:
        """SSE 'data: <json>\\n\\n' parsing. 取第一个 data: 行 JSON.parse.

        SSE message format (RFC):
            event: <name>
            data: <json>
            (blank line)

        我们忽略 event: 字段, 只取 data: payload. 如果 multi-line data:
        要 concatenate, 这里假设 KOS 单行 data 足够 (实测 100KB+ JSON 也是
        单行).
        """
        for line in body.splitlines():
            if line.startswith("data: "):
                raw = line[len("data: ") :].strip()
                if raw and raw != "[DONE]":
                    try:
                        return json.loads(raw)
                    except json.JSONDecodeError as e:
                        raise KOSError(
                            f"SSE data: line not JSON: {e}", code="E_KOS_PARSE"
                        ) from e
        raise KOSError(
            "SSE response missing 'data:' line", code="E_KOS_PARSE"
        )

    @staticmethod
    def _unwrap_tool_result(result: Any) -> Any:
        """MCP tools/call 的 result 通常长这样:
            {"content": [{"type": "text", "text": "<JSON-encoded payload>"}]}

        把内嵌 text 再 JSON.parse 一次, 返 caller-friendly value. 不是
        JSON 就原样返 string.
        """
        if not isinstance(result, dict):
            return result
        content = result.get("content", [])
        if not (isinstance(content, list) and content):
            return result
        first = content[0]
        if not isinstance(first, dict):
            return result
        if first.get("type") != "text":
            return result
        text = first.get("text", "")
        if not text:
            return result
        try:
            return json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return text
