"""MCP connector 路由（08-01 阶段 1 PR1）—— 连接 / OAuth / 工具清单同步的执行权威面。

鉴权分层：
  - list / oauth-start / status / sync / tools / disconnect → ``Depends(verify_cf_access)``
    （owner-only，本地 token 腿 + 远程 CF JWT）。
  - 🔴 ``GET /api/connector/oauth/callback`` **无鉴权依赖** —— 浏览器 302 顶层跳转带不了
    自定义 header（挂 CF 门必 401）。鉴权 = ``state`` 能力令牌（SDK ``token_urlsafe(32)``
    生成、单次消费、短 TTL），对不上一律 404 **不泄露原因**（照 ``routers/island.py`` ack
    先例 + auth.py codex Fix 5 教训）。

灰度开关 ``MAILAGENT_MCP_CONNECTORS``（pydantic ``mcp_connectors_enabled``，默认 off）：
off 时除 callback 外全部 409（callback 永远只认 state —— off 时不会有活 rendezvous，
自然 404，无需再挂 flag 门）。选 pydantic 而非 notion_agent 式 .env 热读的理由：
① env-only 直读有 ratchet 闸（tests/config/test_env_only_reads.py 禁新增）；② 本 flag 在
PR1 没有 Node gateway 侧消费者、无跨端同值刚需（notion_agent 热读正是为镜像 envBool）；
③ island 先例（ship off → dogfood → cutover）就是 pydantic 载体。代价 = 翻开关要重启
serve-api，对灰度开关可接受。

🔴 src.connectors / mcp SDK 一律 **lazy import**（handler 内）：让 ``import src.api.app``
在没装 mcp 的裸 worktree 也不炸（镜像 island.py 的 lazy import 纪律），flag off 时
serve-api 启动零新副作用。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from src.api.auth import verify_cf_access
from src.api.routers.connector_browser import router as _browser_router
from src.api.routers.connector_common import (
    _connector_def,
    _credential_view,
    _flow_view,
    _is_custom_row,
    _managed_summary_fields,
    _raise_from_connector_error,
    _require_enabled,
    _require_managed_local_enabled,
    _serialize_connector_summary,
    _store,
)
from src.api.routers.connector_composio import get_composio_entry
from src.api.routers.connector_composio import router as _composio_router
from src.api.routers.connector_crud import list_connectors
from src.api.routers.connector_crud import router as _crud_router

router = APIRouter(prefix="/api/connector", tags=["connector"])
router.add_api_route(
    "",
    list_connectors,
    methods=["GET"],
    dependencies=[Depends(verify_cf_access)],
)
router.include_router(_browser_router)
router.include_router(_composio_router)
router.include_router(_crud_router)

__all__ = [
    "router",
    "get_composio_entry",
    "_require_enabled",
    "_require_managed_local_enabled",
    "_connector_def",
    "_store",
    "_raise_from_connector_error",
    "_flow_view",
    "_credential_view",
    "_is_custom_row",
    "_managed_summary_fields",
    "_serialize_connector_summary",
]
