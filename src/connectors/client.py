"""ConnectorClient —— MCP SDK v2 的三层装配 + 超时 + 串行闸 + 稳定 error code 表。

结构照抄 ``src/kos/client.py``（issue #69 后的形状：配置读超时 / 报错带耗时 / 稳定 code 表），
把手搓 JSON-RPC 换成 SDK ``Client``。装配（排雷报告 §二实签）：

    OAuthClientProvider（httpx2.Auth 子类；PKCE + DCR + 刷新全内建）
      → httpx2.AsyncClient(auth=provider, follow_redirects=True, timeout=…)
          🔴 **超时唯一落点**（风险 6）：v1 provider 的 timeout= 参数从未生效且 v2 已删，
          写错层 = 看起来配了实际不生效（#69 复刻）。
      → streamable_http_client(url, http_client=…)   ← 无 auth= 参数，全走 http_client
      → Client(transport)                            ← async CM，list_tools / call_tool

🔴 anyio cancel scope 单 task 纪律（风险 7）：``session()`` 的整个 ``async with`` 链
（httpx2 client → transport → Client）必须活在**同一个 asyncio task** 里 —— 授权后台流
（``run_connect_flow``）整体作为一个 task 被 schedule（``_schedule_bg`` 形状），callback
端点只做「code 塞 rendezvous 唤醒」，绝不跨 task 收尾传输层。

跨重启懒刷新（``_prime``）：SDK ``_initialize`` 从 storage 读回 token 后**不设**
``token_expiry_time``（源码核实）→ 重启后过期 access token 会被当有效直接送出 → 401 →
掉进**交互式**全流程重授权。修法 = 会话开始前用 storage 里的绝对 epoch 预置
``provider.context.token_expiry_time``（提前量 60s，PRD「懒刷新」参考值），让 SDK 自己的
「无效且可刷新 → 先刷新」分支跨重启也成立。只碰 ``OAuthContext`` 的公开 dataclass 字段，
有 canary 单测钉 SDK 内部形状漂移。
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable, Optional
from urllib.parse import parse_qs, urlparse

import httpx2
from loguru import logger

from mcp import Client
from mcp.client.auth import (
    OAuthClientProvider,
    OAuthFlowError,
    OAuthRegistrationError,
    OAuthTokenError,
)
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.auth import AuthorizationCodeResult, OAuthClientMetadata
from mcp.shared.exceptions import MCPError

from src.connectors.gate import ConnectorBusy, connector_gate
from src.connectors.oauth_flow import (
    ConnectorFlowState,
    OAuthCallbackDenied,
    oauth_rendezvous,
)
from src.connectors.registry import (
    ConnectorDef,
    get_connector_def,
    namespace_for,
    resolve_redirect_uri,
)
from src.connectors.token_storage import CredentialTokenStorage

#: 拿不到 config 时的兜底请求超时（秒）。正常路径读 ``CONNECTOR_TIMEOUT_SECONDS``
#: （src/config.py ``connector_timeout_seconds``，默认同为 30）—— 镜像 kos/client.py。
_FALLBACK_TIMEOUT = 30.0

#: 交互式授权里等浏览器回调的上限（秒）——用户要登录 + 点同意，与请求超时不同量级，
#: 独立常量不跟随 CONNECTOR_TIMEOUT_SECONDS。
OAUTH_CALLBACK_TIMEOUT_SECONDS = 300.0

#: 懒刷新提前量（秒）：access token 剩余寿命低于此值即视为过期、走刷新（PRD 参考 60s）。
TOKEN_REFRESH_EARLY_SECONDS = 60.0

#: 非交互 API 请求（sync 等）抢 namespace 闸的等待上限——别被一个挂着等浏览器的授权流吊死。
GATE_WAIT_TIMEOUT_SECONDS = 30.0

#: 工具清单分页拉取的页数上限（防远端游标永动）。
_LIST_TOOLS_MAX_PAGES = 20

#: call_tool 归一结果的字符上限（镜像 routers/web.py ``_DEFAULT_MAX_CHARS`` 截断先例）——
#: 一个 Notion 数据库可以是几万行，无界 payload 是 issue #66 那类病根；截断如实置 truncated。
CALL_RESULT_MAX_CHARS = 50_000


def _configured_timeout() -> float:
    """``CONNECTOR_TIMEOUT_SECONDS``（pydantic）→ 请求超时；不可用/非正 → 兜底 30s。

    函数内 import：顶层 import config 会把 pydantic 的 .env 解析拖进每个 import 者的启动路径
    （kos/client.py 同款理由）。
    """
    try:
        from src.config import config as settings

        value = float(settings.connector_timeout_seconds)
    except Exception:  # noqa: BLE001 — 配置不可用绝不能让 client 构造失败
        return _FALLBACK_TIMEOUT
    return value if value > 0 else _FALLBACK_TIMEOUT


class ConnectorError(Exception):
    """connector 统一 error wrapper（stable code 让 caller / router 决定处置）：

        E_CONNECTOR_UNKNOWN        - 未知 connector id（不在 registry）
        E_CONNECTOR_NOT_CONNECTED  - 无可用授权且当前会话不允许交互（先走 oauth/start）
        E_CONNECTOR_BUSY           - namespace 闸被占（多半是授权流挂着等浏览器）
        E_CONNECTOR_TIMEOUT        - 请求/回调等待超时（message 带实际耗时 + 生效上限，#69 纪律）
        E_CONNECTOR_OAUTH          - OAuth 流失败（注册被拒 / 刷新失败 / 用户拒绝授权）
        E_CONNECTOR_NETWORK        - httpx2 传输层错误（connect / TLS / 断流）
        E_CONNECTOR_PROTOCOL       - MCP 协议层错误（JSON-RPC error / 形状不对）
    """

    def __init__(self, message: str, code: str = "E_CONNECTOR_UNKNOWN_ERROR") -> None:
        super().__init__(message)
        self.code = code


def _sole_leaf(eg: BaseException) -> Optional[BaseException]:
    """（可嵌套的）ExceptionGroup 只裹着**一个**异常时拆到叶子；多子异常 → None。

    只拆「一个」是有意的：并发多错时挑哪个当代表都是猜，原样抛出让上层看到全貌。

    （``BaseExceptionGroup`` 是 3.11 内建；ruff 按 pyproject 的 ``requires-python=">=3.9"``
    判它未定义 —— 本模块硬依赖 mcp SDK[≥3.10] + 只跑在本机 3.11，故 noqa 而不是改全局。）
    """
    cur: BaseException = eg
    while isinstance(cur, BaseExceptionGroup):  # noqa: F821 — 3.11 内建，见 docstring
        if len(cur.exceptions) != 1:
            return None
        cur = cur.exceptions[0]
    return cur


def _timeout_note(elapsed: float, limit_desc: str) -> str:
    """超时分支的可诊断文案（issue #69）：实际耗时 + 生效上限是多少、来自哪。"""
    return f"timed out after {elapsed:.1f}s ({limit_desc})"


def derive_crud_type(tool: Any) -> str:
    """MCP 工具 annotations → crud_type（PRD：接上 manifest 就有的语义位，零额外建模）。

    映射（annotations 三个 hint 都是三态 ``bool | None``，None = 服务器未声明）：
      - ``read_only_hint`` 显式 True         → ``read``
      - ``idempotent_hint`` 显式 True        → ``update``
      - 其余（含 destructive、完全未注解）    → ``write``

    🔴 裁决①（spike 2026-08-03 实测证伪原映射）：``destructive_hint=True`` **不再**映射
    ``delete`` —— MCP annotations **没有 delete 语义位**，spec 里 destructiveHint 的语义是
    「可能执行破坏性**更新**」（覆盖式写入的超集，不专指删除）。Notion 把最核心的
    ``notion-update-page`` 标了 destructive，按旧映射推成 delete 会让它结构性不可用
    （delete 恒不可启用、不注册），而 Notion 清单里根本没有真删除工具。destructive 语义位
    单独落列（``derive_destructive``），供审批卡显示红色「破坏性操作」警告——位不丢，
    只是不再当档位。``delete`` 档位机制保留（值域 / 恒 False 分支不动），当前推导不产出；
    未来若有 manifest 以名字/描述明示真删除，再议启发式。
    未注解的写类工具**不**按 MCP spec 的 destructive 缺省值收紧 —— 保守面靠 write 类默认关
    + manual 恒审批。
    """
    ann = getattr(tool, "annotations", None)
    if ann is not None:
        if getattr(ann, "read_only_hint", None) is True:
            return "read"
        if getattr(ann, "idempotent_hint", None) is True:
            return "update"
    return "write"


def derive_destructive(tool: Any) -> bool:
    """``destructive_hint is True`` → 独立 destructive 标记（裁决①：语义位单独落列）。

    只认显式 True（三态 hint 的 None/False 都算否）——审批卡红警告只对服务器明示的
    破坏性更新亮起，不猜。
    """
    ann = getattr(tool, "annotations", None)
    return ann is not None and getattr(ann, "destructive_hint", None) is True


async def _no_interactive_redirect(_url: str) -> None:
    raise ConnectorError(
        "connector is not authorized (or the access token can no longer be refreshed) — "
        "run POST /api/connector/{id}/oauth/start to (re)authorize",
        code="E_CONNECTOR_NOT_CONNECTED",
    )


async def _no_interactive_callback() -> AuthorizationCodeResult:
    raise ConnectorError(
        "connector is not authorized — run POST /api/connector/{id}/oauth/start",
        code="E_CONNECTOR_NOT_CONNECTED",
    )


class ConnectorClient:
    """一个 connector 的会话工厂（每次操作新开会话；跨调用无长命连接）。

    ``interactive=False``（默认，sync / 未来 tool-call 用）：storage 里没有可用授权时
    **立刻**报 E_CONNECTOR_NOT_CONNECTED，绝不把 API 请求挂在浏览器授权上。
    ``interactive=True`` 配 ``redirect_handler`` / ``callback_handler``（授权后台流用）。
    """

    def __init__(
        self,
        connector_id: str,
        *,
        interactive: bool = False,
        redirect_handler: Optional[Callable[[str], Awaitable[None]]] = None,
        callback_handler: Optional[Callable[[], Awaitable[AuthorizationCodeResult]]] = None,
        timeout_seconds: Optional[float] = None,
        storage: Any = None,
    ) -> None:
        try:
            self.definition: ConnectorDef = get_connector_def(connector_id)
        except KeyError as e:
            raise ConnectorError(str(e), code="E_CONNECTOR_UNKNOWN") from None
        self.connector_id = connector_id
        self.namespace = namespace_for(connector_id)
        self.interactive = interactive
        self._redirect_handler = redirect_handler
        self._callback_handler = callback_handler
        # None = 读 CONNECTOR_TIMEOUT_SECONDS；显式值优先（单测 / 特殊调用方）。
        self.timeout = (
            timeout_seconds if timeout_seconds is not None else _configured_timeout()
        )
        self.storage = storage if storage is not None else CredentialTokenStorage(self.namespace)

    # ── provider 装配 ────────────────────────────────────────────────────────

    def _client_metadata(self) -> OAuthClientMetadata:
        return OAuthClientMetadata(
            client_name=self.definition.client_name,
            redirect_uris=[resolve_redirect_uri()],  # pydantic 会 coerce 成 AnyUrl
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            # 两家 .well-known 均支持 "none"（public client，PKCE 保护）——不请求 client_secret。
            token_endpoint_auth_method="none",
        )

    def _build_provider(self) -> OAuthClientProvider:
        if self.interactive:
            redirect, callback = self._redirect_handler, self._callback_handler
            if redirect is None or callback is None:
                raise ConnectorError(
                    "interactive session requires redirect_handler + callback_handler",
                    code="E_CONNECTOR_OAUTH",
                )
        else:
            redirect, callback = _no_interactive_redirect, _no_interactive_callback
        return OAuthClientProvider(
            server_url=self.definition.server_url,
            client_metadata=self._client_metadata(),
            storage=self.storage,
            redirect_handler=redirect,
            callback_handler=callback,
        )

    async def _prime(self, provider: OAuthClientProvider) -> None:
        """跨重启懒刷新（模块 docstring）：用 storage 的绝对 epoch 预置 context 到期时间。"""
        getter = getattr(self.storage, "get_tokens_with_expiry", None)
        if getter is None:
            return  # 注入的第三方 storage（如 dry-run in-memory）没有绝对 epoch —— 跳过
        tokens, access_expires_at = await getter()
        if tokens is not None and access_expires_at is not None:
            provider.context.token_expiry_time = (
                float(access_expires_at) - TOKEN_REFRESH_EARLY_SECONDS
            )

    # ── 会话 ─────────────────────────────────────────────────────────────────

    @asynccontextmanager
    async def session(self, *, http_transport: Any = None) -> AsyncIterator[Client]:
        """打开一个 MCP 会话（namespace 闸内；错误统一转 ConnectorError 且带耗时）。

        ``http_transport`` 仅供单测 / dry-run 注入 ``httpx2.MockTransport``。
        """
        gate_timeout = None if self.interactive else GATE_WAIT_TIMEOUT_SECONDS
        started = time.monotonic()
        try:
            try:
                async with connector_gate.hold(self.namespace, timeout=gate_timeout):
                    provider = self._build_provider()
                    await self._prime(provider)
                    async with httpx2.AsyncClient(
                        auth=provider,
                        follow_redirects=True,
                        timeout=httpx2.Timeout(self.timeout),
                        transport=http_transport,
                    ) as http:
                        transport = streamable_http_client(
                            self.definition.server_url, http_client=http
                        )
                        async with Client(transport) as client:
                            yield client
            except BaseExceptionGroup as eg:  # noqa: F821 — 3.11 内建，见 _sole_leaf
                # 🔴 会话内部是 anyio TaskGroup（streamable_http），它把**单个**异常也裹成
                # ExceptionGroup —— 下面那串 `except ConnectorError / httpx / MCPError` 一条
                # 都匹配不上，异常会以 ExceptionGroup 形态原样逃出去。后果不是「日志难看」：
                # invoke/sync 侧靠 `except ConnectorError` + code 判定落 needs_reauth，裹一层
                # 就永不触发 —— 刷新失败（授权被撤销）这条**最主要**的失效路径正好在
                # TaskGroup 里（provider 的 redirect_handler 抛 E_CONNECTOR_NOT_CONNECTED）。
                # 故先拆包：只裹一个异常时拆到叶子重抛，让下面同一套映射照常认领；真·多子
                # 异常（并发多错）拆不动，原样抛出不猜。
                leaf = _sole_leaf(eg)
                if leaf is None:
                    raise
                raise leaf from eg
        except (ConnectorError, ConnectorBusy):
            raise
        except httpx2.TimeoutException as e:
            note = _timeout_note(
                time.monotonic() - started,
                f"CONNECTOR_TIMEOUT_SECONDS={self.timeout:g}",
            )
            raise ConnectorError(
                f"connector {self.connector_id} request {note}; the remote MCP server is "
                "reachable-but-slow or hung — retry, or raise CONNECTOR_TIMEOUT_SECONDS",
                code="E_CONNECTOR_TIMEOUT",
            ) from e
        except OAuthCallbackDenied as e:
            raise ConnectorError(
                f"connector {self.connector_id}: {e}", code="E_CONNECTOR_OAUTH"
            ) from e
        except (OAuthFlowError, OAuthRegistrationError, OAuthTokenError) as e:
            raise ConnectorError(
                f"connector {self.connector_id} OAuth flow failed after "
                f"{time.monotonic() - started:.1f}s: {e}",
                code="E_CONNECTOR_OAUTH",
            ) from e
        except httpx2.HTTPError as e:
            raise ConnectorError(
                f"connector {self.connector_id} network error after "
                f"{time.monotonic() - started:.1f}s: {e}",
                code="E_CONNECTOR_NETWORK",
            ) from e
        except MCPError as e:
            raise ConnectorError(
                f"connector {self.connector_id} MCP protocol error: {e}",
                code="E_CONNECTOR_PROTOCOL",
            ) from e

    async def list_tools_manifest(self, *, http_transport: Any = None) -> list[dict[str, Any]]:
        """拉全量工具清单 → 归一成入库形状（name/description/schema×2/crud_type）。

        🔴 delete 类**照常入库**（Q16=A：清单完整，界面恒灰、AI 不注册）——本函数不过滤。
        """
        tools: list[dict[str, Any]] = []
        async with self.session(http_transport=http_transport) as client:
            cursor: Optional[str] = None
            for _ in range(_LIST_TOOLS_MAX_PAGES):
                result = await client.list_tools(cursor=cursor)
                for t in result.tools:
                    tools.append(
                        {
                            "name": t.name,
                            "description": t.description or "",
                            "input_schema": t.input_schema,
                            "output_schema": t.output_schema,
                            "crud_type": derive_crud_type(t),
                            "destructive": derive_destructive(t),
                        }
                    )
                cursor = result.next_cursor
                if not cursor:
                    break
        return tools

    async def call_tool(
        self,
        tool_name: str,
        arguments: Optional[dict[str, Any]] = None,
        *,
        http_transport: Any = None,
    ) -> dict[str, Any]:
        """调一个远端工具 → 归一成有界结果（PR2 invoke 端点的执行面）。

        归一（payload 无界是 issue #66 那类病根，出 client 前就截）：
          - ``content``：文本 content block 拼接；无文本块但有 ``structured_content`` 时
            JSON 序列化它（模型仍能读到结构化结果）。
          - 截断上限 ``CALL_RESULT_MAX_CHARS``（镜像 web_fetch ``_DEFAULT_MAX_CHARS`` 先例），
            截断时 ``truncated=True`` 如实告知。
          - ``is_error``：远端 tool-error 位原样透传（caller/模型自行读文案自纠）。
        围栏（UNTRUSTED_MCP_TOOL）在 TS gateway 侧套 —— 本层只管界。
        """
        async with self.session(http_transport=http_transport) as client:
            result = await client.call_tool(tool_name, arguments or {})
        parts: list[str] = []
        for block in getattr(result, "content", None) or []:
            text = getattr(block, "text", None)
            if isinstance(text, str) and text:
                parts.append(text)
        content = "\n".join(parts)
        structured = getattr(result, "structured_content", None)
        if not content and structured is not None:
            try:
                import json as _json

                content = _json.dumps(structured, ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                content = str(structured)
        truncated = len(content) > CALL_RESULT_MAX_CHARS
        if truncated:
            content = content[:CALL_RESULT_MAX_CHARS]
        return {
            "content": content,
            "is_error": bool(getattr(result, "is_error", False)),
            "truncated": truncated,
        }


# ---------------------------------------------------------------------------
# 授权后台流（start 端点 schedule 的那个「单 task 全生命周期」协程）
# ---------------------------------------------------------------------------


def _extract_state(authorization_url: str) -> Optional[str]:
    qs = parse_qs(urlparse(authorization_url).query)
    values = qs.get("state") or []
    return values[0] if values else None


async def run_connect_flow(flow: ConnectorFlowState, *, client: Optional[ConnectorClient] = None) -> None:
    """整条授权流：起会话（触发 OAuth）→ 列工具 → 双表落库 → 状态回写。

    🔴 整个协程作为**一个** asyncio task 被 schedule（router ``_schedule_bg``）——
    transport / Client 的 anyio cancel scope 全程同 task（风险 7）。
    异常不外抛：终态落 ``flow`` + connector 行（后台 task 没有 caller 可收）。
    """
    from starlette.concurrency import run_in_threadpool

    from src.agent_config.store import get_agent_config_store

    connector_id = flow.connector_id
    store = get_agent_config_store()

    async def redirect_handler(url: str) -> None:
        state = _extract_state(url)
        if not state:
            raise ConnectorError(
                "authorization URL carries no state parameter", code="E_CONNECTOR_OAUTH"
            )
        oauth_rendezvous.register(state)
        flow.state_param = state
        flow.auth_url = url
        flow.status = "authorizing"
        flow.auth_url_ready.set()

    async def callback_handler() -> AuthorizationCodeResult:
        assert flow.state_param is not None
        try:
            return await oauth_rendezvous.wait(
                flow.state_param, timeout=OAUTH_CALLBACK_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            raise ConnectorError(
                _timeout_note(
                    OAUTH_CALLBACK_TIMEOUT_SECONDS,
                    "browser authorization was never completed",
                ),
                code="E_CONNECTOR_TIMEOUT",
            ) from None

    cc = client or ConnectorClient(
        connector_id,
        interactive=True,
        redirect_handler=redirect_handler,
        callback_handler=callback_handler,
    )

    try:
        definition = cc.definition
        await run_in_threadpool(
            store.upsert_connector,
            connector_id,
            server_url=definition.server_url,
            display_name=definition.display_name,
            transport=definition.transport,
        )
        await run_in_threadpool(store.update_connector_state, connector_id, status="authorizing")

        tools = await cc.list_tools_manifest()
        stats = await run_in_threadpool(store.sync_connector_tools, connector_id, tools)

        scopes = await _granted_scopes(cc)
        await run_in_threadpool(
            store.update_connector_state,
            connector_id,
            status="connected",
            last_error=None,
            scopes=scopes,
            last_synced_at=int(time.time()),
        )
        flow.tool_count = len(tools)
        flow.status = "connected"
        logger.info(
            "[connector] {} connected: {} tools synced ({})", connector_id, len(tools), stats
        )
    except BaseException as e:
        # CancelledError（被新流替换）也走这里收尾状态，然后 re-raise 让取消语义完整。
        message = f"{type(e).__name__}: {e}"[:500]
        flow.status = "error"
        flow.error = message
        try:
            await run_in_threadpool(
                store.update_connector_state, connector_id, status="error", last_error=message
            )
        except Exception:  # noqa: BLE001 — 状态回写失败不掩盖原始异常
            logger.warning("[connector] failed to persist error state for {}", connector_id)
        if not isinstance(e, Exception):
            raise  # CancelledError / SystemExit —— 状态已落，取消语义原样传播
        logger.warning("[connector] {} connect flow failed: {}", connector_id, message)
    finally:
        # 失败在 URL 产出之前 → 让 start 端点的等待立刻返回（携 error）。
        flow.auth_url_ready.set()
        oauth_rendezvous.discard(flow.state_param)


async def _granted_scopes(cc: ConnectorClient) -> Optional[list[str]]:
    """连接后从 tokens 行的明文 metadata 读授权 scope（坑 1.5：授权范围透明展示）。"""
    try:
        from src.agent_config.credentials import peek_credential
        from src.connectors.token_storage import KEY_TOKENS

        from starlette.concurrency import run_in_threadpool

        meta = await run_in_threadpool(peek_credential, cc.namespace, KEY_TOKENS)
        if meta is None:
            return None
        scope = meta.metadata.get("scope")
        if isinstance(scope, str) and scope:
            return scope.split()
    except Exception:  # noqa: BLE001 — scope 展示是 best-effort，不阻断连接
        logger.debug("[connector] scope readback failed for {}", cc.namespace)
    return None
