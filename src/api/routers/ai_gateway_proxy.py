"""ai-gateway-proxy 路由 — serve-api 把远程 web 的 chat 请求代理到同机 loopback AI SDK Gateway。

拓扑（task A — 远程 Web 切 AI SDK）
----------------------------------
远程 web (``mail.chenge.ink/app``) 的 chat 引擎跑在浏览器（UI 进程），经 serve-api 取后端
原语。serve-api 与嵌入式 AI SDK Gateway（Node，electron main，loopback 默认 8300）**同机**
（都在本地 .app，cloudflared 只暴露 serve-api 的 8200）。远程浏览器够不到 loopback gateway，
所以 serve-api 代理它：renderer 在 web+ai-sdk 时把 base 解析成 ''（同源）→ ``/api/ai/chat`` /
``/health`` 打到本代理 → 转发到 ``127.0.0.1:<MAILAGENT_AI_GATEWAY_PORT>``（缺省 8300，与
gateway ``frontend/src/ai-gateway/config.ts resolveAiGatewayPort`` 同源）。

🔴 本地 electron 路径**不经代理**：renderer 仍用 ``?aiGatewayPort=`` 直连 loopback gateway
（resolveAiGatewayBaseUrl 返回 ``http://127.0.0.1:N``）。代理只服务 web。业务权威仍在
gateway 的 chatRun.ts/streamText（经代理透传），不在 Python 重写引擎。

代理端点（method/path → gateway 真源 ``frontend/src/ai-gateway/server.ts``）
  - POST /api/ai/chat              流式（UIMessage 流，AI SDK pipeUIMessageStreamToResponse）
  - POST /api/ai/agui/chat         流式（AG-UI mirror；gateway 仅 MAILAGENT_AG_UI_MIRROR 开时
                                   注册，否则 404 —— 代理透传其 404）
  - POST /api/ai/title             非流式 JSON
  - POST /api/ai/approval/resolve  非流式 JSON
  - GET  /api/ai/approval/pending  非流式 JSON（S6 W1：记录内审批的 pending 真值查询；远程
                                   web 打开 agent 执行记录时 live 查 stash → 命中富化 / miss 404）
  - POST /api/ai/approval/decide   非流式 JSON（S6 W1：记录内审批决策 → 服务端 resume；与岛
                                   共用同一 gateway decide 通道，远程 web parity）
  - GET  /api/ai/run/active        非流式 JSON（07-15 lane A B1：detached run 真值探针，
                                   ?sessionId= 随 query 透传；miss/未启用 → gateway 404 透传）
  - POST /api/ai/run/stop          非流式 JSON（07-15 lane A B1：显式停止通道 —— detached 模式
                                   下 client abort 不再中止上游，composer 停止按钮经此）
  - GET/POST /api/ai/queued-input  非流式 JSON（P5 queued-input CRUD/confirm；GET query 透传）
  - GET  /api/ai/config            非流式 JSON
  - GET  /health                   **裸路径**（非 /api/ai）：renderer 健康探针打
                                   ``${base}/health`` → 代理到 gateway /health。鉴权豁免（纯
                                   存活探针；与 serve-api 自己的 /api/health liveness 区分）。

⚠️ 与 ``src/api/routers/ai.py`` 的关系：ai.py 是 serve-api **自有**的 /api/ai/translation
（email_translation 读/删，本地 SQLite）。本文件是 /api/ai/{chat,title,...} **代理**到 gateway。
两者 path 前缀同为 /api/ai 但子路径不重叠（translation/* vs chat/title/...），各自挂载。

abort 传播
----------
远程 client（浏览器）断开 → Starlette 取消 StreamingResponse 的迭代 → 透传生成器在 ``yield``
处被抛 GeneratorExit/CancelledError → ``finally`` 跑 ``aclose()`` 关掉到 gateway 的连接 →
gateway 的 ``req.on('close')`` 触发 → LLM abortSignal cancel 上游调用。这是 llm_proxy
（chat.py）已验证的同款机制。

hop-by-hop header
-----------------
转发时**剔除** hop-by-hop（Content-Length / Transfer-Encoding / Connection / Host / TE /
Trailer / Upgrade / Keep-Alive / Proxy-Authenticate / Proxy-Authorization），否则会和 httpx /
Starlette 自算的 framing 撞车把流式弄坏。请求侧：透传 content-type（gateway readJsonBody 需要）+
其余安全 header（剔 hop-by-hop），body 用原始 bytes（不重解码）。响应侧：只回传 content-type
（+ 安全允许集），framing 交给 Starlette。

鉴权
----
代理端点挂 ``Depends(verify_cf_access)``（``src/api/auth.py``，本地 token + CF JWT 双腿都支持，
与 ai.py / chat.py 一致）。裸 /health **不挂鉴权**（纯存活探针，gateway 自身 /health 也无鉴权）。
"""

from __future__ import annotations

import logging
import os
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from src.api.auth import verify_cf_access

logger = logging.getLogger("mailagent.api.ai_gateway_proxy")

# 无 prefix：本路由同时承载 /api/ai/* 代理端点与裸 /health，故用全路径声明。
router = APIRouter(tags=["ai-gateway-proxy"])

# gateway loopback 端口默认值（与 frontend/src/ai-gateway/config.ts AI_GATEWAY_DEFAULT_PORT 一致）。
_DEFAULT_AI_GATEWAY_PORT = 8300

# 流式 LLM 转发：connect/write/pool 给短超时，read=None（不限）—— LLM 流式响应可能长时间无字节
# （首 token 前的思考、长生成），read timeout 会误杀长回答。abort 由 client 断开 → aclose 传播，
# 不靠 read timeout 兜底。
_PROXY_TIMEOUT = httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)

# 转发时必须剔除的 hop-by-hop header（小写比对）。否则上游/下游各自算的 framing 撞车坏流。
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
        "host",
    }
)


def _resolve_gateway_port() -> int:
    """gateway loopback 端口（env MAILAGENT_AI_GATEWAY_PORT，缺省/非法 → 8300）。

    与 gateway resolveAiGatewayPort 同源：backend_lifecycle spawn serve-api 时注入同一 resolve 值，
    让代理与 gateway 永远指向同一端口。"""
    raw = os.environ.get("MAILAGENT_AI_GATEWAY_PORT")
    if raw is None:
        return _DEFAULT_AI_GATEWAY_PORT
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return _DEFAULT_AI_GATEWAY_PORT
    return n if n > 0 else _DEFAULT_AI_GATEWAY_PORT


def _gateway_base() -> str:
    """loopback gateway 基址 ``http://127.0.0.1:<port>``（恒 loopback，同机）。"""
    return f"http://127.0.0.1:{_resolve_gateway_port()}"


def _forward_request_headers(request: Request) -> dict[str, str]:
    """构造转发到 gateway 的请求 header：剔 hop-by-hop，保 content-type 等业务 header。

    不透传 Host（hop-by-hop 集已含），httpx 会按目标 URL 自设 Host=127.0.0.1:<port>。
    CF/cloudflared 注入的鉴权 header（Cf-Access-Jwt-Assertion / X-MailAgent-Local-Token）透传无害
    （gateway loopback 不校验它们，但保留也不破坏）。"""
    return {
        k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP
    }


def _passthrough_response_headers(upstream: httpx.Response) -> dict[str, str]:
    """从 gateway 响应里挑安全 header 回传：剔 hop-by-hop（framing 交给 Starlette 自算）。

    content-type 必传（流式 = text/event-stream-ish / AI SDK UIMessage；非流式 = application/json）。
    其余非 hop-by-hop header 一并透传（如 cache-control）。"""
    return {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP
    }


async def _proxy_streaming(request: Request, target_path: str) -> Response:
    """流式代理（/api/ai/chat、/api/ai/agui/chat）：转发 → 透传上游 SSE/UIMessage 流字节。

    镜像 chat.py llm_proxy：build_request + send(stream=True) + ``aiter_bytes`` 生成器 +
    ``finally aclose()``。client 断开 → Starlette 取消迭代 → GeneratorExit 进 finally → aclose →
    gateway req.on('close') → LLM abort。非 2xx 也照常透传（含 gateway 的 404 mirror-off / 400 /
    413 / 503）—— body 可能是 JSON 错误体，照流式透传即可（前端按 status 分类）。"""
    url = f"{_gateway_base()}{target_path}"
    body = await request.body()
    headers = _forward_request_headers(request)

    client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT)
    try:
        upstream_req = client.build_request(
            request.method, url, content=body, headers=headers
        )
        upstream_resp = await client.send(upstream_req, stream=True)
    except Exception as exc:  # noqa: BLE001 — 连接 gateway 失败（未起/端口错）→ 502 + aclose
        await client.aclose()
        logger.warning("ai-gateway proxy connect failed for %s: %s", target_path, exc)
        # 502 空体：gateway 不可达（loopback 同机理应在；起不来 = 降级信号给前端 health 探针）。
        return Response(status_code=502)

    async def passthrough() -> AsyncIterator[bytes]:
        # aiter_raw（非 aiter_bytes）：gateway 的 AI SDK / SSE 流已是明文 UTF-8，无 content-encoding，
        # 用 raw 避免任何解码层；finally 必 aclose 上游 + client（client 断开经此路径传播 abort）。
        try:
            async for chunk in upstream_resp.aiter_raw():
                yield chunk
        finally:
            await upstream_resp.aclose()
            await client.aclose()

    return StreamingResponse(
        passthrough(),
        status_code=upstream_resp.status_code,
        headers=_passthrough_response_headers(upstream_resp),
    )


async def _proxy_buffered(request: Request, target_path: str) -> Response:
    """非流式代理（/api/ai/{title,approval/resolve,config}）：转发 → 整体回传 JSON。

    一次性读完上游 body 回传（非流式端点 body 小）。status + content-type 透传；非 2xx（gateway 的
    501/503/400/404/410/502）原样回传，前端按 status + error code 处理。"""
    url = f"{_gateway_base()}{target_path}"
    body = await request.body()
    headers = _forward_request_headers(request)

    try:
        async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT) as client:
            upstream_resp = await client.request(
                request.method, url, content=body, headers=headers
            )
    except Exception as exc:  # noqa: BLE001 — gateway 不可达 → 502 空体（health 探针会先暴露）
        logger.warning("ai-gateway proxy (buffered) failed for %s: %s", target_path, exc)
        return Response(status_code=502)

    return Response(
        content=upstream_resp.content,
        status_code=upstream_resp.status_code,
        headers=_passthrough_response_headers(upstream_resp),
    )


# ============================================================
# 流式端点（UIMessage / AG-UI 流）
# ============================================================
@router.post("/api/ai/chat")
async def proxy_chat(request: Request, _: None = Depends(verify_cf_access)) -> Response:
    """代理 POST /api/ai/chat → gateway（流式 UIMessage）。abort 经 aclose 传播。"""
    return await _proxy_streaming(request, "/api/ai/chat")


@router.post("/api/ai/agui/chat")
async def proxy_agui_chat(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    """代理 POST /api/ai/agui/chat → gateway（流式 AG-UI mirror）。

    gateway 仅 MAILAGENT_AG_UI_MIRROR 开时注册此路由；关时 gateway 返 404 —— 代理透传 404 即可。"""
    return await _proxy_streaming(request, "/api/ai/agui/chat")


# ============================================================
# 非流式端点（JSON）
# ============================================================
@router.post("/api/ai/title")
async def proxy_title(request: Request, _: None = Depends(verify_cf_access)) -> Response:
    """代理 POST /api/ai/title → gateway（非流式 JSON，幂等 LLM 自动标题）。"""
    return await _proxy_buffered(request, "/api/ai/title")


@router.post("/api/ai/compact")
async def proxy_compact(request: Request, _: None = Depends(verify_cf_access)) -> Response:
    return await _proxy_buffered(request, "/api/ai/compact")


@router.post("/api/ai/compact/stop")
async def proxy_compact_stop(request: Request, _: None = Depends(verify_cf_access)) -> Response:
    return await _proxy_buffered(request, "/api/ai/compact/stop")


@router.post("/api/ai/approval/resolve")
async def proxy_approval_resolve(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    """代理 POST /api/ai/approval/resolve → gateway（非流式 JSON，edit-tier 审批侧信道）。"""
    return await _proxy_buffered(request, "/api/ai/approval/resolve")


@router.get("/api/ai/approval/pending")
async def proxy_approval_pending(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    """代理 GET /api/ai/approval/pending → gateway（S6 W1，远程 web parity）。

    记录内审批 UI 打开 agent 执行记录时 live 查 stash 求 pending 真值：命中 200 富化体 /
    miss 404（gateway 的 fail-closed 语义，透传 status + JSON body）。查询串（?sessionId=）
    随 request.url 透传给 gateway。island agent off / stash 未接线 → gateway 恒 404，代理透传。"""
    target = request.url.path
    if request.url.query:
        target = f"{target}?{request.url.query}"
    return await _proxy_buffered(request, target)


@router.post("/api/ai/approval/decide")
async def proxy_approval_decide(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    """代理 POST /api/ai/approval/decide → gateway（S6 W1，远程 web parity）。

    记录内审批决策 → gateway 服务端 resume（与岛 ack 共用同一 decide 通道，无第二套审批面）。
    两种 body 形状原样透传（S6 W2 P9）：岛 {toolCallId, decision, resumeToken}（凭能力令牌 claim）
    或记录内 {approvalId, decision}（gateway 按 approvalId 内部解析 toolCallId+resumeToken，令牌不出
    gateway）。非 2xx（404 未接线 / 400 缺参 / 500 resume 失败）原样透传。gateway 门控（approvalStash
    在场，S6 W2 P8 起 = island OR custom-agents flag）off → 404，代理透传。"""
    return await _proxy_buffered(request, "/api/ai/approval/decide")


@router.get("/api/ai/run/active")
async def proxy_run_active(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    """代理 GET /api/ai/run/active → gateway（07-15 lane A B1，远程 web parity）。

    detached chat run 真值探针：面板切回会话时查「AI 是否仍在后台输出」→ 命中 200 {active:true,
    ageMs} / miss 404 {active:false}（fail-closed 真值，MAILAGENT_CHAT_DETACHED_RUNS off 时 gateway
    恒 404，代理透传）。查询串（?sessionId=）随 request.url 透传。"""
    target = request.url.path
    if request.url.query:
        target = f"{target}?{request.url.query}"
    return await _proxy_buffered(request, target)


@router.post("/api/ai/run/stop")
async def proxy_run_stop(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    """代理 POST /api/ai/run/stop → gateway（07-15 lane A B1，远程 web parity）。

    detached 模式下 client fetch-abort 不再中止上游 LLM 调用；composer 停止按钮的显式停止通道
    经此打到 gateway（abort 该 session 的 active run → 不落库）。off → gateway 404 透传。"""
    return await _proxy_buffered(request, "/api/ai/run/stop")


@router.get("/api/ai/queued-input")
async def proxy_queued_input_list(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    target = request.url.path
    if request.url.query:
        target = f"{target}?{request.url.query}"
    return await _proxy_buffered(request, target)


@router.post("/api/ai/queued-input")
async def proxy_queued_input_enqueue(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    return await _proxy_buffered(request, "/api/ai/queued-input")


@router.post("/api/ai/queued-input/update")
async def proxy_queued_input_update(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    return await _proxy_buffered(request, "/api/ai/queued-input/update")


@router.post("/api/ai/queued-input/cancel")
async def proxy_queued_input_cancel(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    return await _proxy_buffered(request, "/api/ai/queued-input/cancel")


@router.post("/api/ai/queued-input/send")
async def proxy_queued_input_send(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    return await _proxy_buffered(request, "/api/ai/queued-input/send")


@router.get("/api/ai/config")
async def proxy_config(
    request: Request, _: None = Depends(verify_cf_access)
) -> Response:
    """代理 GET /api/ai/config → gateway（非流式 JSON，runtime 配置）。"""
    return await _proxy_buffered(request, "/api/ai/config")


# ============================================================
# 裸 /health（无鉴权，纯存活探针）
# ============================================================
@router.get("/health")
async def proxy_health(request: Request) -> Response:
    """代理 GET /health → gateway /health（**无鉴权**，renderer 健康探针）。

    与 serve-api 自有的 /api/health liveness 区分：这条裸 /health 专给 web renderer 探嵌入式
    gateway 是否可达（health 失败 → 前端降级 legacy）。纯存活探针，故豁免 verify_cf_access
    （gateway 自身 /health 也无鉴权）。gateway 不可达 → 502 → 前端 healthQ.isError → gatewayDegraded。

    🔴 最小披露（code-reviewer LOW）：裸 /health 无鉴权，故**不透传** gateway /health 的
    baseUrl(LLM 上游 URL)/model/hasKey 等基础设施元数据 —— 只回 liveness 必需的
    {status, service, version}。renderer 健康探针只读 body.status（AgentConversation healthQ），
    裁剪零影响；若 8200 被误暴露公网，匿名者也读不到 LLM 基础设施信息。"""
    url = f"{_gateway_base()}/health"
    # 解析在 async with 内（client 未关）—— body 在此读妥，规避 after-close 访问的 httpx 异常。
    try:
        async with httpx.AsyncClient(timeout=_PROXY_TIMEOUT) as client:
            upstream_resp = await client.get(url)
            status_code = upstream_resp.status_code
            try:
                full: Any = upstream_resp.json()
            except Exception:  # noqa: BLE001 — 上游非 JSON / 读取异常 → 兜底 liveness（不算不可达）
                full = None
    except Exception as exc:  # noqa: BLE001 — gateway 不可达 → 502（前端探针据此降级 legacy）
        logger.warning("ai-gateway proxy /health failed: %s", exc)
        return Response(status_code=502)
    safe: dict[str, Any] = {}
    if isinstance(full, dict):
        for key in ("status", "service", "version"):
            if key in full:
                safe[key] = full[key]
    if "status" not in safe:
        safe["status"] = "ok" if 200 <= status_code < 300 else "error"
    return JSONResponse(safe, status_code=status_code)
