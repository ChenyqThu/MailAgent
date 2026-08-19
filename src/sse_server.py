"""Sprint 16 — mail-sync 进程内的 SSE 推送端点 (Server-Sent Events).

定位:
- 前端 Electron main 直连 127.0.0.1:9200/api/events/stream, 0 RTT
- 远端 V2 web 后续走 cloudflared tunnel 映射 9200 → 公网域名
- webhook-server 8100 的 SSE endpoint 保留 (远端管理用 / 反向兜底)

技术选型:
- aiohttp.web — 已有依赖 (requirements.txt), 不引入 FastAPI/uvicorn 重型栈
- redis.asyncio.Redis.pubsub() — 已有依赖, 订阅 `mailagent:events:v1`
- 协议: `event: mailagent\ndata: <json>\n\n`, 15s heartbeat `event: ping\ndata: \n\n`

启动 / 关闭由 main.py 控制 (asyncio.create_task + cleanup), 见 main.py
`_sse_server_loop`. env `MAILAGENT_SSE_ENABLED=false` 时整个 server 不起.

事件协议 / 已发布事件类型见 docs/reference/integrations/sse-events.md + src/events/publisher.py.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import time
from typing import Any, Dict, Optional

import aiohttp.web_protocol as _aiohttp_web_protocol
from aiohttp import web
from loguru import logger

from src.config import config
from src.events.publisher import DEFAULT_CHANNEL as _DEFAULT_CHANNEL


# aiohttp 3.9.1 tcp_keepalive 兼容 patch (macOS):
# RequestHandler.connection_made 无条件调 tcp_keepalive(transport) → setsockopt(
# SOL_SOCKET, SO_KEEPALIVE); macOS 上对某些 SSE 连接的 socket 状态报 OSError [Errno 22]
# Invalid argument, 每个连接刷一条 error log (被 asyncio callback 吞, 不影响 SSE 功能)。
# aiohttp 3.9.1 的 web.Server 无 tcp_keepalive 开关, 故 monkeypatch 成失败静默版。
# 本地 SSE (127.0.0.1) 不依赖 TCP keepalive; 只影响 server 端 (alert/feishu 的
# ClientSession 是 client, 不走 connection_made, 不受影响)。
# 必须 patch web_protocol 命名空间: connection_made 经 `from .tcp_helpers import
# tcp_keepalive` 绑定了同一对象, patch tcp_helpers 不改 web_protocol 已绑定的引用。
if not getattr(_aiohttp_web_protocol.tcp_keepalive, "_mailagent_safe", False):
    _orig_tcp_keepalive = _aiohttp_web_protocol.tcp_keepalive

    def _safe_tcp_keepalive(transport) -> None:
        try:
            _orig_tcp_keepalive(transport)
        except OSError:
            pass  # macOS setsockopt(SO_KEEPALIVE) Errno 22 — 无害忽略

    _safe_tcp_keepalive._mailagent_safe = True  # type: ignore[attr-defined]
    _aiohttp_web_protocol.tcp_keepalive = _safe_tcp_keepalive


# 🔴 channel 名单源自 publish 端 (issue #68)。Redis pub/sub 对「订阅的 channel 与
# publish 的 channel 不匹配」**不报错, 只是零投递** —— 漂一个字符 = 整条事件桥静默哑掉,
# 且两端日志都正常。故订阅端一律 import 发布端的常量, 不许再手抄字面量。
# webhook-server/app.py 另有一份 (远程 VPS 独立部署, import 不到 src/) —— 那份由
# tests/events/test_sse_constants_parity.py 建闸对撞。
SSE_CHANNEL = _DEFAULT_CHANNEL
SSE_HEARTBEAT_SEC = 15

# C2 — SSE 9200 本地 token 门 (补鉴权)。9200 仅 loopback, 但同机任意进程都能读这条流 →
# 泄漏 internal_id + 操作时序。配了 token 时要求 X-MailAgent-Local-Token header 匹配; 未配
# (dev / pm2 serve 无注入) → 门关 (向后兼容)。当前 9200 未经 cloudflared 暴露 (仅本地 Electron
# main 连), 故只做本地 token 校验; 若将来 tunnel 暴露远程, 由 CF Access 在隧道层覆盖 9200。
LOCAL_TOKEN_HEADER = "X-MailAgent-Local-Token"  # 🔴 必须与 src/api/auth.py + local_token.ts 一致
_LOCAL_API_TOKEN = os.environ.get("MAILAGENT_LOCAL_API_TOKEN", "").strip()


def _local_token_ok(request: web.Request) -> bool:
    """SSE 本地 token 鉴权: 未配 token → 放行 (门关); 配了 → header 必须 compare_digest 匹配。"""
    if not _LOCAL_API_TOKEN:
        return True
    provided = request.headers.get(LOCAL_TOKEN_HEADER, "")
    return bool(provided) and hmac.compare_digest(provided, _LOCAL_API_TOKEN)

# Module-level 状态, 给 /api/events/health 用
_state: Dict[str, Any] = {
    "subscriber_count": 0,
    "last_event_ts": None,  # 最近一次 publish 到 client 的 epoch
    "last_error": None,
    "started_at": None,
}


def _get_redis_url() -> Optional[str]:
    """从 config 取 redis url + db.  redis_url 空时返 None (SSE noop)."""
    url = (config.redis_url or "").strip()
    if not url:
        return None
    return f"{url}/{config.redis_db}"


async def _stream_events(request: web.Request) -> web.StreamResponse:
    """SSE long-lived response: 订阅 redis pubsub 转发给客户端.

    心跳: 每 SSE_HEARTBEAT_SEC 秒发 `event: ping` 防代理空闲断连
          (cloudflare 默认 100s, 内网代理通常 30-60s).
    断连: client close → asyncio.CancelledError; redis 失联 → 500 + log.
    鉴权 (C2): 配了 MAILAGENT_LOCAL_API_TOKEN 时要求 X-MailAgent-Local-Token header 匹配
          (同机非 Electron 进程读不到流); 未配 → 门关 (向后兼容)。绑定 127.0.0.1 不暴露公网。
    """
    # C2 本地 token 门: 未配 token 放行; 配了则 header 必须匹配。早返回 401, 不触 redis/streaming。
    if not _local_token_ok(request):
        return web.json_response({"error": "unauthorized"}, status=401)

    redis_url = _get_redis_url()
    if not redis_url:
        # 无 Redis (一体化 app): 订阅进程内总线, 不再 503 (Y, task #11)
        return await _stream_events_inprocess(request)

    resp = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # nginx / cloudflare 提示不要 buffer SSE
            "X-Accel-Buffering": "no",
        },
    )
    await resp.prepare(request)

    # Lazy import 防 redis 未安装时 module 整个崩
    from redis.asyncio import from_url as redis_from_url

    client = redis_from_url(
        redis_url,
        socket_timeout=5.0,
        socket_connect_timeout=5.0,
    )
    pubsub = client.pubsub(ignore_subscribe_messages=True)

    _state["subscriber_count"] += 1
    peer = request.remote or "?"
    logger.info(f"[sse] client connected from {peer} (total={_state['subscriber_count']})")

    try:
        await pubsub.subscribe(SSE_CHANNEL)

        while not request.transport or not request.transport.is_closing():
            try:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=SSE_HEARTBEAT_SEC,
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"[sse] pubsub get_message failed: {e}")
                _state["last_error"] = str(e)[:200]
                # 短暂等待避免热循环
                await asyncio.sleep(1.0)
                continue

            if msg and msg.get("type") == "message":
                data = msg.get("data")
                if isinstance(data, bytes):
                    data = data.decode("utf-8", errors="replace")
                # SSE 帧: event + data + 空行
                frame = f"event: mailagent\ndata: {data}\n\n"
                try:
                    await resp.write(frame.encode("utf-8"))
                    _state["last_event_ts"] = time.time()
                except (ConnectionResetError, asyncio.CancelledError):
                    break
            else:
                # timeout → heartbeat
                try:
                    await resp.write(b"event: ping\ndata: \n\n")
                except (ConnectionResetError, asyncio.CancelledError):
                    break

        return resp
    except asyncio.CancelledError:
        # graceful server shutdown / client disconnect
        raise
    finally:
        _state["subscriber_count"] = max(0, _state["subscriber_count"] - 1)
        logger.info(
            f"[sse] client disconnected from {peer} (remaining={_state['subscriber_count']})"
        )
        try:
            await pubsub.unsubscribe(SSE_CHANNEL)
        except Exception:
            pass
        try:
            await pubsub.close()
        except Exception:
            pass
        try:
            await client.aclose()
        except Exception:
            pass


async def _stream_events_inprocess(request: web.Request) -> web.StreamResponse:
    """无 Redis (一体化 app): 订阅进程内总线 InProcessEventBus, 复用 redis 分支同款
    SSE 帧 (event: mailagent / event: ping) + heartbeat + 断连清理。

    Redis 分支字节级不变 —— 仅 token gate 后、redis_url 缺席时改走这里 (取代旧 503)。
    data 行内容 = safe_publish 投递的已序列化 JSON frame (与 redis pubsub 的 data 同形)。
    """
    from src.events.inprocess_bus import get_inprocess_bus

    resp = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
    await resp.prepare(request)

    bus = get_inprocess_bus()
    queue = bus.subscribe()
    _state["subscriber_count"] += 1
    peer = request.remote or "?"
    logger.info(
        f"[sse] client connected from {peer} "
        f"(in-process, total={_state['subscriber_count']})"
    )

    try:
        while not request.transport or not request.transport.is_closing():
            try:
                data = await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_SEC)
            except asyncio.TimeoutError:
                # timeout → heartbeat (防代理空闲断连)
                try:
                    await resp.write(b"event: ping\ndata: \n\n")
                except (ConnectionResetError, asyncio.CancelledError):
                    break
                continue
            except asyncio.CancelledError:
                raise
            # SSE 帧: event + data + 空行 (与 redis 分支逐字一致)
            frame = f"event: mailagent\ndata: {data}\n\n"
            try:
                await resp.write(frame.encode("utf-8"))
                _state["last_event_ts"] = time.time()
            except (ConnectionResetError, asyncio.CancelledError):
                break
        return resp
    except asyncio.CancelledError:
        raise
    finally:
        bus.unsubscribe(queue)
        _state["subscriber_count"] = max(0, _state["subscriber_count"] - 1)
        logger.info(
            f"[sse] client disconnected from {peer} "
            f"(in-process, remaining={_state['subscriber_count']})"
        )


async def _health(request: web.Request) -> web.Response:
    """SSE server 健康检查 (无鉴权).

    返回:
        {ok: bool, redis_url_configured: bool, subscriber_count: int,
         last_event_ts: float|null, last_error: str|null, started_at: float|null}
    """
    return web.json_response(
        {
            "ok": True,
            "redis_url_configured": _get_redis_url() is not None,
            "subscriber_count": _state["subscriber_count"],
            "last_event_ts": _state["last_event_ts"],
            "last_error": _state["last_error"],
            "started_at": _state["started_at"],
        }
    )


async def _publish_event(request: web.Request) -> web.Response:
    """内部 publish 端点 (S1): 让**没有 sse_server 的进程**把事件送进本进程的总线。

    背景: 前端 SSE 连的是 serve 进程 (本文件), 而所有 REST 写落在 serve-api 进程 ——
    那里的 ``safe_publish`` 落到未绑 loop 的进程内总线上等于 no-op。serve-api 的
    ``src/events/loopback.py`` POST 到这里, 由本端点在 serve 进程里重新 publish。

    鉴权: 与 SSE 流同一道 ``_local_token_ok`` (未配 token → 门关, 向后兼容);
    server 本身 bind 127.0.0.1, 不暴露公网。不新造第二套鉴权。

    🔴 走 ``safe_publish`` 而不是直接 ``bus.publish``: 万一在配了 Redis 的部署里被调到,
    它会正确地 publish 到 Redis 而不是投进一个没人订阅的 bus。少一个分歧点。
    """
    if not _local_token_ok(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "invalid json"}, status=400)
    event_type = str(body.get("event_type") or "").strip()
    if not event_type:
        return web.json_response({"error": "event_type required"}, status=400)

    from src.events.publisher import safe_publish

    internal_id = body.get("internal_id")
    data = body.get("data")
    safe_publish(
        event_type,
        internal_id=internal_id if isinstance(internal_id, int) else None,
        data=data if isinstance(data, dict) else None,
        source=str(body.get("source") or "loopback"),
    )
    return web.json_response({"ok": True})


def make_app() -> web.Application:
    """构造 aiohttp Application.  独立函数方便单测."""
    app = web.Application()
    app.router.add_get("/api/events/stream", _stream_events)
    app.router.add_get("/api/events/health", _health)
    app.router.add_post("/api/events/publish", _publish_event)
    return app


async def start_sse_server(
    host: str = "127.0.0.1",
    port: int = 9200,
) -> web.AppRunner:
    """启动 SSE server, 返回 AppRunner 给 caller 在 shutdown 时 cleanup.

    用法 (main.py):
        runner = await start_sse_server()
        # ... main loop
        await runner.cleanup()
    """
    app = make_app()
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    # 把进程内总线绑到当前 (serve) loop, 让 safe_publish 的无-Redis 投递能 call_soon
    # 调度过来。redis 在场时无害 (无人 subscribe bus, publish 早返回)。
    from src.events.inprocess_bus import get_inprocess_bus

    get_inprocess_bus().bind_loop(asyncio.get_running_loop())
    site = web.TCPSite(runner, host=host, port=port, reuse_address=True)
    await site.start()
    _state["started_at"] = time.time()
    logger.info(f"[sse] server listening on http://{host}:{port}")
    return runner


# ============================================================
# 测试 hook
# ============================================================

def _reset_state_for_tests() -> None:
    """单测前重置 module state."""
    _state["subscriber_count"] = 0
    _state["last_event_ts"] = None
    _state["last_error"] = None
    _state["started_at"] = None
