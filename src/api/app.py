"""MailAgent V2 远程访问 FastAPI 实例 (mailagent-api).

bind 127.0.0.1:8200，经 cloudflared tunnel 暴露给 https://mail.chenge.ink。

本文件负责 **框架层**:
  - FastAPI() 实例 + 严格 CORS (仅 https://mail.chenge.ink，dev 额外放 localhost:5173)
  - 统一响应 envelope (status/schema_version/data/error/meta，含 duration_ms) helper
  - 全局异常处理器 (APIError / HTTPException / 未捕获 Exception → envelope error + 正确 HTTP)
  - 请求计时 middleware (request.state.t0 → meta.duration_ms)
  - 启动 loopback assertion (REMOTE-ACCESS §6.5: 必须 bind 127.0.0.1)
  - 挂载 routers: email / attachment / llm / admin / calendar / folder / ai / email_views

设计依据: REMOTE-ACCESS §3.4 (统一响应) / §6.3 (auth) / §6.4-6.5 (安全分层 + loopback)。
端点本身 (Phase 3) 由 Routers agent 填充；本层提供他们要用的 envelope helper + auth dep。
"""

from __future__ import annotations

import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from src.api.auth import verify_cf_access  # noqa: F401 — 供 routers `Depends(verify_cf_access)`

logger = logging.getLogger("mailagent.api")

# NOTE: routers 在文件**末尾**才 import + 挂载 (见底部 "挂载 routers")。
# 原因: 各 router 模块顶层 `from src.api.app import APIError, success_envelope`,
# 若在此处 (helper/异常定义之前) import routers 会触发循环导入 —— app 尚未定义
# APIError/success_envelope 时 router 已来取, ImportError。把 router import 下沉到
# 这两个 helper + APIError 定义之后即可打破环 (标准 FastAPI 布局)。

# 统一 envelope 的 schema_version，与 CLI (src/cli/output.py SCHEMA_VERSION) 保持一致，
# 让 FastAPI 响应能复用 cli-schema/*.schema.json + cli.gen.ts 校验。
SCHEMA_VERSION = 1

# --- dev 开关 (两个独立 SoT，不再耦合) -------------------------------------
# F4: 旧实现把 "放行 localhost CORS" 与 "跳过 JWT 鉴权" 都挂在
# MAILAGENT_API_AUTH_DISABLED 上 —— 想本地连真 CF Access、只放 vite origin 时无法只开
# 一半。拆成两个旗标:
#   - MAILAGENT_API_DEV_CORS:      仅控制是否把 localhost:5173 加进 CORS 白名单。
#   - MAILAGENT_API_AUTH_DISABLED: 仅控制是否跳过 CF Access JWT 校验 (见 auth.py)。
# 任一开启都会打 WARNING (生产误配可见)。
_DEV_CORS = os.environ.get("MAILAGENT_API_DEV_CORS", "").lower() == "true"
_AUTH_DISABLED = os.environ.get("MAILAGENT_API_AUTH_DISABLED", "").lower() == "true"

# CORS 白名单。生产仅放行远端 Web (Cloudflare Pages 域)。
ALLOWED_ORIGINS = ["https://mail.chenge.ink"]
# dev:web 本地 vite (localhost:5173-5174) — **只**由 MAILAGENT_API_DEV_CORS 控 (C2)。
# 旧实现额外让 AUTH_DISABLED 也 widen CORS，把"跳鉴权"与"放本地 origin"耦死: 想本地连
# 真 CF Access 只放 vite origin 时做不到，且 codex 标为 CORS 被 auth-disable 无意中放宽。
# 两个旗标彻底解耦 —— auth-disable 只管 JWT (见 auth.py)，CORS 只看 _DEV_CORS。
if _DEV_CORS:
    ALLOWED_ORIGINS = ALLOWED_ORIGINS + [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ]

if _DEV_CORS:
    logger.warning(
        "MAILAGENT_API_DEV_CORS=true — localhost:5173-5174 added to CORS allowlist "
        "(electron-vite dev 端口 5173 被占时 fallback 5174，两者都放). "
        "MUST be off in production (REMOTE-ACCESS §6.4)."
    )
if _AUTH_DISABLED:
    logger.warning(
        "MAILAGENT_API_AUTH_DISABLED=true — CF Access JWT verification is SKIPPED. "
        "MUST be off in production (REMOTE-ACCESS §6.3). Note: this flag NO LONGER "
        "widens CORS — set MAILAGENT_API_DEV_CORS=true separately for local vite (C2)."
    )


# ---------------------------------------------------------------------------
# 统一响应 envelope —— routers 经这两个 helper 构造响应 (REMOTE-ACCESS §3.4)
# ---------------------------------------------------------------------------


def _duration_ms(request: Optional[Request]) -> int:
    """从 request.state.t0 (middleware 写入) 算已用毫秒；无则 0。"""
    if request is not None:
        t0 = getattr(request.state, "t0", None)
        if t0 is not None:
            return int((time.perf_counter() - t0) * 1000)
    return 0


def success_envelope(
    data: Any,
    *,
    request: Optional[Request] = None,
    meta_extra: Optional[dict[str, Any]] = None,
    source: str = "sqlite",
    status_code: int = 200,
) -> JSONResponse:
    """构造成功 envelope 的 JSONResponse。

    routers 读端点直接 ``return success_envelope(data, request=request, ...)``。
    data 形状 = CLI 该命令 emit 的 ``data`` (复用 cli-schema)。
    meta_extra 追加到 meta (如 ``{"total": N, "limit": 50, "offset": 0, "count": k}``
    或 ``{"query": q, "total_hits": n, "total_indexed": m}``)。
    source: 'sqlite' (repo-backed 读) | 'cli' (subprocess 端点)。
    """
    meta: dict[str, Any] = {"duration_ms": _duration_ms(request), "source": source}
    if meta_extra:
        meta.update({k: v for k, v in meta_extra.items() if v is not None})
    return JSONResponse(
        status_code=status_code,
        content={
            "status": "success",
            "schema_version": SCHEMA_VERSION,
            "data": data,
            "error": None,  # §3.4 显式 error:null
            "meta": meta,
        },
    )


def error_envelope(
    code: str,
    message: str,
    *,
    http_status: int,
    hint: Optional[str] = None,
    request: Optional[Request] = None,
    source: str = "cli",
) -> JSONResponse:
    """构造错误 envelope 的 JSONResponse (data=null, error={code,message,hint})。

    code = error-codes.md 英文 enum (E_NOT_FOUND / E_INVALID_ARG / ...)；message/hint
    英文 (不做 i18n，前端按 code 翻译，§3.5)。http_status 由 caller 决定 (见
    ERROR_CODE_TO_HTTP)，或经 raise APIError(...) 让全局 handler 自动映射。
    """
    error_payload: dict[str, Any] = {"code": code, "message": message}
    if hint is not None:
        error_payload["hint"] = hint
    return JSONResponse(
        status_code=http_status,
        content={
            "status": "error",
            "schema_version": SCHEMA_VERSION,
            "data": None,
            "error": error_payload,
            "meta": {"duration_ms": _duration_ms(request), "source": source},
        },
    )


# error code → HTTP status (BACKEND-INTERFACES §1.3 exit-code map + error-codes.md)。
# in-process service 抛的 ServiceError 应优先用自报的 error.code，再用此表把 code 映成 HTTP。
#
# 命名历史 (E2-C 前 fork-CLI 转发年代留下的沿革, 现仍适用于 in-process service 的
# 同名 E_* code): 已退役的 CLI subprocess 转发层曾把子进程 exit code 拼成
# ``E_{name}`` (exit 1→E_GENERIC, 5→E_UPSTREAM, 6→E_PARTIAL)，旧表用的是
# wrapper-status 名 (E_PARTIAL_FAILURE)，导致 exit-fallback 的 E_PARTIAL /
# E_UPSTREAM / E_GENERIC 全部 miss → 一律默认 500，漂移。这里补齐三者:
#   - E_UPSTREAM: 上游 (SMTP / davmail / CalDAV) 失败 → 502 Bad Gateway。
#   - E_GENERIC : 未分类失败 → 500 (与默认同值，显式登记表达意图)。
#   - E_PARTIAL : 批量部分失败 → 207 Multi-Status (E_PARTIAL_FAILURE 别名保留)。
# 同源沿革还有两个当时漏登记的别名 (cli_runner.ts 的 exit map 曾把 exit 4 拼成
# E_AUTH、exit 9 拼成 E_PM2_CONFLICT；映射已改回 exceptions.py 真值，但历史客户端 /
# 缓存 web bundle 仍可能发老拼法，miss → 兜底 500 会把 403/409 伪装成服务端错误):
#   - E_AUTH        : E_AUTH_FAILED 别名 → 403。
#   - E_PM2_CONFLICT: E_PM2_RUNNING  别名 → 409。
ERROR_CODE_TO_HTTP: dict[str, int] = {
    "E_NOT_FOUND": 404,
    "E_INTERNAL": 500,
    "E_GENERIC": 500,  # 未分类失败 → E_GENERIC (= 默认 500，显式登记)
    "E_LLM_FAILED": 500,
    "E_INVALID_ARG": 400,
    "E_NOT_IMPLEMENTED": 400,
    "E_AUTH_FAILED": 403,  # auth-layer 缺 token → 401 在 auth.py 处理；服务自报 → 403
    "E_AUTH": 403,  # 别名: 老 cli_runner exit-4 拼法
    "E_RATE_LIMITED": 429,  # skill 配额闸（src/skills/rate_limit.py）
    "E_UPSTREAM": 502,  # 上游 SMTP/davmail/CalDAV 失败
    "E_SCHEMA_MISMATCH": 502,
    "E_PARTIAL": 207,  # 批量部分失败 (Multi-Status)
    "E_PARTIAL_FAILURE": 207,  # 别名: wrapper status == "partial_failure"
    "E_ABORTED": 499,
    "E_MAX_FAILURES": 503,
    "E_PM2_RUNNING": 409,
    "E_PM2_CONFLICT": 409,  # 别名: 老 cli_runner exit-9 拼法
    "E_DISABLED": 403,  # 功能 flag 关（如 MAILAGENT_USER_MD_COMPILE）→ 端点拒绝
    "E_MATTER_NOT_FOUND": 404,
    "E_CHILD_NOT_FOUND": 404,
    "E_VERSION_CONFLICT": 409,
    "E_IDEMPOTENCY_CONFLICT": 409,
    "E_INVALID_STATE": 409,
    "E_UPDATE_STALE": 409,
    "E_UPDATE_ALREADY_REVIEWED": 409,
    "E_RUN_ACTIVE": 409,
    "E_RESOURCE_IDENTITY_CONFLICT": 409,
    "E_DEPENDENCY_EXISTS": 409,
    "E_PROPOSAL_EXISTS": 409,  # Matters P4: 每 run 至多一个提案
    "E_MATTER_SCOPE": 403,  # Matters P4: email 读越出 matter 关联域（headless 守卫）
}


class APIError(Exception):
    """routers 可 raise 的统一业务异常 → 全局 handler 转 envelope error。

    用法 (routers):
        raise APIError("E_NOT_FOUND", f"email {id} not found")
        raise APIError("E_INVALID_ARG", "...", hint="...")
        raise APIError("E_SCHEMA_MISMATCH", "...", http_status=503)  # 显式覆盖

    http_status 缺省由 ERROR_CODE_TO_HTTP[code] 推导 (未知 code → 500)。
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        hint: Optional[str] = None,
        http_status: Optional[int] = None,
        source: str = "cli",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.http_status = http_status or ERROR_CODE_TO_HTTP.get(code, 500)
        self.source = source


# ---------------------------------------------------------------------------
# 启动 assertion — 必须 bind 127.0.0.1 (REMOTE-ACCESS §6.5 / §6.4 G2)
# ---------------------------------------------------------------------------


async def _assert_bind_loopback() -> None:
    """启动时校验仅监听 loopback；非 127.0.0.1/localhost 立即 raise 退出。

    F1: 旧实现读 ``os.environ['UVICORN_HOST']`` —— uvicorn **从不**设此 env，断言永远
    通过 (即便真 bind 0.0.0.0)，宣称的防御层是死代码。改读本进程自有变量
    ``MAILAGENT_API_HOST``: serve-api 子命令在 ``uvicorn.run`` 前显式
    ``os.environ['MAILAGENT_API_HOST']=host`` (硬绑 127.0.0.1)，本断言读同一变量做二次
    兜底。唯一对外通道是 cloudflared tunnel，公网不可直连 8200。

    C3: 旧实现用 ``assert`` —— ``python -O`` 下 assert 被整体 strip，这道防御层在优化
    运行时直接消失。改成显式 ``if ... raise RuntimeError``，任何启动方式 (含 -O) 都生效。

    A4 (fail-closed): ``MAILAGENT_API_HOST`` **未设/空** 时不再默认 127.0.0.1 放行 —— 那等于
    "没人显式声明 host 就当它安全"。serve-api 子命令进 uvicorn 前**总会**显式落该 env，所以
    合法路径恒带值；未设只可能是绕过 serve-api 的裸 uvicorn 启动 (无人为它硬绑 loopback)，
    视为不可信直接 raise。

    协程独立保留 (非内联进 lifespan): 测试直接 ``asyncio.run(_assert_bind_loopback())``
    校验它在坏 host / 未设 host 下 raise。
    """
    server_host = os.environ.get("MAILAGENT_API_HOST", "")
    if server_host not in ("127.0.0.1", "localhost"):
        raise RuntimeError(
            f"FastAPI MUST bind 127.0.0.1, got {server_host!r} "
            "(REMOTE-ACCESS §6.5 — 唯一对外通道是 cloudflared tunnel; "
            "未设 MAILAGENT_API_HOST 视为不可信，须经 `mailagent serve-api` 启动)"
        )


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """FastAPI lifespan (取代 deprecated ``@app.on_event('startup')``)。

    startup: 跑 loopback 断言 (bind 非 127.0.0.1 立即退出)。shutdown: 当前无副作用
    (EmailRepository 是 per-call 短命连接，无长命资源要关 —— deps.py gotcha #13)。
    """
    await _assert_bind_loopback()
    yield


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="MailAgent API",
    description="MailAgent V2 远程访问本地后端 (loopback-only，经 cloudflared tunnel 暴露)",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,  # CF Access cookie / JWT 走 credentials
    # PATCH: V2.1 阶段 3 3b-3 chat 持久化引入（streamContent/finalizeMessage/updateToolCall）—
    # 远程 browser 跑 HttpChatPlatform.persist 时 PATCH 触发 CORS preflight，须在白名单（3c transport 用）。
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _timing_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    """请求计时: 在 request.state.t0 记起点，供 envelope helper 算 meta.duration_ms。

    异常路径也已覆盖 —— 异常 handler 同样读 request.state.t0 (handler 在 middleware
    内层抛出/被捕获前 t0 已写入)。
    """
    request.state.t0 = time.perf_counter()
    response = await call_next(request)
    return response


# ---------------------------------------------------------------------------
# 全局异常处理器 —— 任何异常都转成统一 envelope error + 正确 HTTP 状态码
# ---------------------------------------------------------------------------


@app.exception_handler(APIError)
async def _handle_api_error(request: Request, exc: APIError) -> JSONResponse:
    return error_envelope(
        exc.code,
        exc.message,
        http_status=exc.http_status,
        hint=exc.hint,
        request=request,
        source=exc.source,
    )


@app.exception_handler(HTTPException)
async def _handle_http_exception(request: Request, exc: HTTPException) -> JSONResponse:
    """把 FastAPI/Starlette 的 HTTPException (含 auth.py 的 401/403) 转 envelope。

    按 HTTP status 反推一个语义 code，让前端拿到稳定 error.code:
      401 → E_AUTH_FAILED (缺 JWT)，403 → E_AUTH_FAILED (JWT 非法)，404 → E_NOT_FOUND，
      其余 4xx → E_INVALID_ARG，5xx → E_INTERNAL。
    """
    status = exc.status_code
    if status in (401, 403):
        code = "E_AUTH_FAILED"
    elif status == 404:
        code = "E_NOT_FOUND"
    elif 400 <= status < 500:
        code = "E_INVALID_ARG"
    else:
        code = "E_INTERNAL"
    message = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
    return error_envelope(code, message, http_status=status, request=request, source="cli")


@app.exception_handler(RequestValidationError)
async def _handle_validation_error(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """请求体/参数校验失败 (malformed JSON / 类型不符 / 缺必填) → 统一 envelope。

    默认 FastAPI 返回 422 + ``{detail:[...]}`` (非本 app envelope)，HttpApi.req() 解析不出
    error.code。映射成 E_INVALID_ARG envelope (保持 422 HTTP status，仅修 body 形状)，让所有
    端点 (reports/jobs/email ``body: Optional[dict]`` 收 malformed 时) 的客户端拿稳定 code。
    """
    errors = exc.errors()
    msg = "request validation failed"
    if errors:
        first = errors[0]
        loc = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        first_msg = str(first.get("msg", "invalid"))
        msg = f"{loc}: {first_msg}" if loc else first_msg
    return error_envelope("E_INVALID_ARG", msg, http_status=422, request=request, source="cli")


@app.exception_handler(Exception)
async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
    """兜底: 未捕获异常 → 500 E_INTERNAL envelope (不泄漏 traceback 给客户端)。"""
    return error_envelope(
        "E_INTERNAL",
        f"internal error: {exc.__class__.__name__}",
        http_status=500,
        request=request,
        source="cli",
    )


# ---------------------------------------------------------------------------
# 挂载 routers
# ---------------------------------------------------------------------------

# 末尾 import: 此刻 APIError / success_envelope / error_envelope 均已定义,
# router 模块顶层的 `from src.api.app import ...` 不再撞循环导入 (见文件顶部 NOTE)。
# calendar / folder / ai / email_views 为 Phase B 待填充骨架 (空 router，挂载即生效)。
from src.api.routers import (  # noqa: E402
    admin,
    agent,
    agent_runs,
    ai,
    ai_gateway_proxy,
    attachment,
    calendar,
    chat,
    connector,
    email,
    email_views,
    exec as exec_router,  # 'exec' 是内建名，别名避免遮蔽
    folder,
    im,
    island,
    jobs,
    kos,
    llm,
    llm_providers,
    matter_agent,
    matters,
    reports,
    settings,
    skills,
    web,
)

app.include_router(email.router)
app.include_router(attachment.router)
app.include_router(llm.router)
# task 07-12 P0 (LLM 多 provider 化) — /api/llm/providers* CRUD（key 掩码, verify_cf_access）
# + /snapshot（verify_local_token, 解密 key 仅供同机 embedded gateway）+ per-provider 模型
# 发现 / 连通性测试。seed 迁移惰性触发（表空时把 env 老配置落成 default provider 行）。
app.include_router(llm_providers.router)
# issue #59 (KOS 入库可靠性) — /api/kos/stats 读端点，远程 web 的知识库监控区数据出口
# （桌面走 `mailagent kos stats` IPC）。聚合逻辑与 CLI 单源 src/kos/stats.py。
app.include_router(kos.router)
app.include_router(admin.router)
app.include_router(calendar.router)
app.include_router(folder.router)
app.include_router(ai.router)
app.include_router(email_views.router)
app.include_router(jobs.router)
app.include_router(reports.router)
app.include_router(matters.router)
# Matters P4 (D6) — matter run 提案内部端点 /api/matters/{id}/runs/{rid}/proposal。
# verify_local_token（不接受 CF JWT，Remote Web 不可调）+ matters/matter_agent 双 flag 门；
# 唯一调用方 = embedded gateway 的 matter_update_propose 工具。
app.include_router(matter_agent.router)
app.include_router(chat.router)
app.include_router(settings.router)
app.include_router(skills.router)
app.include_router(agent.router)
# S1 R3 (agent openness wave1) — web 联网工具执行端点 /api/web/{fetch,search}。TS 薄壳→
# Python 执行（业务权威 + 远程 parity）；SSRF 防护 + 钉 IP 在 routers/web.py。gateway 侧
# 恒 edit-tier 人审，flag MAILAGENT_OPENNESS_WEB_TOOLS 默认 off（工具不注册即无从触达本端点）。
app.include_router(web.router)
# S2 W1 (agent openness) — exec 执行工具端点 /api/exec/{run,file_read,file_write}。TS 薄壳→Python
# 执行；固定 env 白名单不继承全局密钥 + inode 级 deny 地板。gateway 侧恒 edit-tier 人审、不进
# auto-approve，结构化白名单命中才免卡（/api/agent/policy/evaluate）。owner-only（verify_cf_access）。
app.include_router(exec_router.router)
# S4 W2 (custom agent 内核) — headless run 的 spec 面 + 审批终态回写
# /api/agent-runs/{id}/{spec,approval-state}。gateway 回拉权威 spec（pull 模型，请求体不携带
# 权威事实）+ 岛 resume 后回写 approval_state。owner-only（verify_local_token，不接受 CF JWT）；
# flag MAILAGENT_CUSTOM_AGENTS_ENABLED 默认 off → 端点 404。
app.include_router(agent_runs.router)
# ping-island 解耦 ack 通道 (契约 §6/§9-4): 按钮点击 fire-and-forget POST 回灌。
# 自认 ack_token 能力令牌 (不挂 verify_cf_access)，见 routers/island.py。
app.include_router(island.router)
# 08-01 阶段 1 PR1 (MCP connector) — /api/connector/* 连接/OAuth/工具清单同步。灰度开关
# MAILAGENT_MCP_CONNECTORS 默认 off (非 callback 端点 409)。oauth/callback 是本仓第三个
# 无 CF 门路由: 浏览器 302 带不了 header，state 即能力令牌 (单次消费+TTL，404 不泄因)，
# 见 routers/connector.py 模块 docstring 威胁模型。src.connectors / mcp SDK 全 lazy import。
app.include_router(connector.router)
# 08-01 阶段 2 PR4 (飞书对话「信任可见」) — /api/im/{status,pair,approvals}。
# status/approvals owner-only 读 (verify_cf_access, 远程 web 也该看得见)；🔴 pair 只认
# 本地 token (verify_local_token, 不接受 CF JWT —— 把飞书账号接进本机执行通道的动作,
# 远程浏览器不该发起)。status/approvals **有意不挂** MAILAGENT_IM_FEISHU 门:「未启用」
# 本身就是要如实呈现的状态, 整区 409 只会让设置页显示「加载失败」。src.im.* lazy import。
app.include_router(im.router)
# task A — 远程 web 切 AI SDK: 把 web 的 chat 请求 (/api/ai/{chat,title,approval/resolve,
# config}, /api/ai/agui/chat) + 裸 /health 代理到同机 loopback AI SDK Gateway。在 SPA catch-all
# mount (/app, 文件末尾) 之前注册，确保 /api/ai/* 与 /health 不被静态 SPA 遮蔽。/api/ai/* 子路径
# (chat/title/...) 与 ai.router 的 /api/ai/translation/* 不重叠，两者共存。本地 electron 不经此代理
# (renderer 直连 ?aiGatewayPort= loopback)，仅 web (base='' 同源) 命中。
app.include_router(ai_gateway_proxy.router)


@app.get("/api/health")
async def _liveness() -> dict[str, Any]:
    """无鉴权 liveness 探针 (cloudflared / pm2 healthcheck 用，非业务 admin.health)。"""
    return {"status": "ok", "schema_version": SCHEMA_VERSION}


# V2 上线: serve-api 同时服务前端 SPA (frontend/out/web, vite base=/app/) —— 单 origin
# (mail.chenge.ink/app → SPA, /api/* → 本 API), 单用户省去单独配 Cloudflare Pages。
# mount 放在所有 API route 之后声明 (StaticFiles 是 catch-all, 避免遮蔽 /api/*)。
#
# SPA dir 解析优先级:
#   1. env MAILAGENT_SPA_DIR — 打包态由 BackendLifecycleManager 注入绝对路径
#      (=<.app>/Contents/Resources/web)。打包后本文件位于只读 bundle 内
#      site-packages, __file__ 相对路径会指向 bundle 内不存在的 frontend/out/web。
#   2. fallback __file__ 相对 (worktree 内 frontend/out/web) — dev / dogfood 态,
#      不设该 env, 与历史行为逐字节一致。
import os as _os_spa  # noqa: E402

from fastapi.responses import RedirectResponse as _RedirectResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles as _StaticFiles  # noqa: E402

_SPA_DIR = _os_spa.environ.get("MAILAGENT_SPA_DIR") or _os_spa.path.join(
    _os_spa.path.dirname(_os_spa.path.dirname(_os_spa.path.dirname(_os_spa.path.abspath(__file__)))),
    "frontend",
    "out",
    "web",
)
if _os_spa.path.isdir(_SPA_DIR):

    @app.get("/")
    async def _root_to_app() -> _RedirectResponse:
        return _RedirectResponse(url="/app/")

    app.mount("/app", _StaticFiles(directory=_SPA_DIR, html=True), name="spa")
