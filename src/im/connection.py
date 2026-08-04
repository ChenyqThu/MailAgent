"""飞书长连接的线程宿主（08-01 阶段 2 PR-2）。

## 🔴 为什么必须自己起一个线程（不是「顺手」，是硬约束）

``lark_oapi/ws/client.py`` 在 **import 期**就执行：

    try:    loop = asyncio.get_event_loop()
    except RuntimeError:
            loop = asyncio.new_event_loop(); asyncio.set_event_loop(loop)

这个 ``loop`` 是**模块级全局**，之后 ``ws.Client.start()`` 走
``loop.run_until_complete(...)``。而我们挂在 ``serve`` 进程里 —— 那里有一个正在跑的
asyncio 主循环。**如果 lark 的第一次 import 发生在主循环线程上**，
``get_event_loop()`` 会返回**服务主 loop**，于是 ``start()`` 当场
``RuntimeError: This event loop is already running``，而且是把整个 IM 功能钉死的那种。

⇒ 两条纪律，本文件与 ``src/im/lark_api.py`` 共同遵守：
  1. **任何 lark import 都不写在模块顶层**，只写在函数体里；
  2. 连接线程启动后**第一件事**是 ``asyncio.set_event_loop(asyncio.new_event_loop())``，
     **然后**才 import lark —— 保证那个全局 ``loop`` 是我们这个线程自己的。
  另加一道 fail-closed 断言：import 完检查该 loop 没在 running（万一别人先 import 过），
  是的话直接判 fatal 而不是让 ``start()`` 去炸。

## 停机

SDK **没有** public 的 stop：``start()`` 末尾是 ``loop.run_until_complete(_select())``，
而 ``_select()`` 是 ``while True: await asyncio.sleep(3600)``。所以优雅停机 =
① 跨线程调 ``ws._disconnect()`` 真正关掉 WebSocket（SLF001：这是唯一入口）→
② ``loop.call_soon_threadsafe(loop.stop)`` 让 ``run_until_complete`` 抛出并退出线程。
两步都有超时，线程是 daemon —— 最坏情况也不会拦住进程退出。

## 连接状态

SDK 只在自己的 ``[Lark]`` logger 里打连接日志，没有 public 的 ``is_connected``。
判据用 ``ws._conn is not None``（同 C6 spike）；另把 ``on_reconnecting`` /
``on_reconnected`` 两个 public 钩子接上，让重连在我们自己的日志里也留痕。
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any, Callable, Optional

from loguru import logger

from src.im.lark_api import LarkMessageSender, build_api_client
from src.im.logfmt import describe_error

# 停机各步骤的超时（秒）。都很短 —— 停机路径上多等一秒都是在拖 SIGTERM。
DISCONNECT_TIMEOUT_SEC = 3.0
THREAD_JOIN_TIMEOUT_SEC = 5.0


class FeishuConnection:
    """一条 lark WS 长连接 + 它的线程。**非线程安全，只由 worker 单线程驱动。**"""

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        *,
        message_handler: Callable[[Any], None],
        card_action_handler: Optional[Callable[[Any], Any]] = None,
        debug: bool = False,
    ) -> None:
        """
        Args:
            message_handler: ``im.message.receive_v1`` 处理器（3 秒内必须返回）。
            card_action_handler: ``card.action.trigger`` 处理器（审批卡按钮回调）。
                PR-3 起生产路径由 ``worker._serve_connection`` 传
                ``wrap_card_action_handler(bridge.on_card_action)``；None = 不注册
                （离线测试 / PR-2 形态）。🔴 飞书后台里「事件订阅」与「回调订阅」是两个
                并列 tab、各配各的（C6 两次卡壳的同一根因）—— 代码接上了后台漏配，
                点按钮会直接提示「该应用尚未配置卡片回调」，请求根本不到本地。
            debug: 打开 SDK DEBUG —— ⚠️ 会把**每一帧原始 payload（含消息正文全文）**
                写进日志，只用于诊断。
        """
        self._app_id = app_id
        self._app_secret = app_secret
        self._message_handler = message_handler
        self._card_action_handler = card_action_handler
        self._debug = debug

        self._thread: Optional[threading.Thread] = None
        self._ws: Any = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._sender: Optional[LarkMessageSender] = None
        self._api: Any = None
        self._ready = threading.Event()      # 线程已把 _ws/_sender 装好（或已 fatal）
        self._stopping = False
        self._fatal: Optional[str] = None

    # ── 生命周期 ──────────────────────────────────────────────────────────
    def start(self, *, ready_timeout_sec: float = 30.0) -> bool:
        """起线程并等它把 client 装好。返回是否成功装好（不代表已握手）。

        🔴 **返回 False ≠ 线程已死**（2026-08-04 真机事故）：packaged 首启的 lark
        冷 import 可达**分钟级**（新进包依赖首次编译 .pyc + 可能与大库备份抢磁盘
        I/O），ready 窗口内没就绪只说明**慢**。调用方必须用 ``fatal_error`` /
        ``is_alive()`` 区分死活；活着 ⇒ 只能用 ``is_ready()`` 继续等 —— 弃置一个
        活线程再新建，弃置线程醒来会抢下 lark 的模块级全局 loop，把之后所有新
        线程钉死在 fail-closed 检查上。
        """
        if self._thread is not None:
            raise RuntimeError("FeishuConnection 已经启动过（一个实例只用一次）")
        self._thread = threading.Thread(
            target=self._run, name="im-feishu-ws", daemon=True
        )
        self._thread.start()
        self._ready.wait(timeout=ready_timeout_sec)
        return self.is_ready()

    def is_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def is_ready(self) -> bool:
        """线程是否已把 client 装好（不代表已握手）。

        ``start()`` ready 超时后 worker 用它继续守望（慢启动路径）。
        """
        return self._fatal is None and self._ws is not None

    def is_connected(self) -> bool:
        """WS 是否在线。SDK 无 public 探针 → 读 ``_conn``（同 C6 spike）。"""
        ws = self._ws
        if ws is None:
            return False
        try:
            return getattr(ws, "_conn", None) is not None  # noqa: SLF001
        except Exception:  # noqa: BLE001
            return False

    @property
    def fatal_error(self) -> Optional[str]:
        return self._fatal

    @property
    def sender(self) -> Optional[LarkMessageSender]:
        return self._sender

    @property
    def api_client(self) -> Any:
        return self._api

    def stop(self) -> None:
        """优雅断开 + 停 loop + join 线程。幂等，可在任何状态下调。

        🔴 **线程已死时不再调度 ``_disconnect``**：``ws.start()`` 抛出后（凭证错 / 非自建
        应用 / 握手失败）线程退出，那个 loop 就**不再转**了 —— 此时
        ``run_coroutine_threadsafe`` 的 future 永远不会完成，``fut.result(3s)`` 变成 3 秒
        **同步阻塞**。而 ``stop()`` 常常是从 serve 的 **event loop 线程**调的
        （``_serve_connection`` 的 finally / 服务停机路径），那就是每轮 fatal 重连都把整个
        服务主循环冻 3 秒（镜像 CLAUDE.md 对「锁等待发生在 event loop 线程上」的红线）。
        线程已死 = WS 早已随它一起没了，本来也无可断。
        """
        self._stopping = True
        ws, loop = self._ws, self._loop

        if ws is not None and loop is not None and not loop.is_closed() and self.is_alive():
            try:
                fut = asyncio.run_coroutine_threadsafe(
                    ws._disconnect(), loop  # noqa: SLF001 — SDK 没有 public stop
                )
                fut.result(timeout=DISCONNECT_TIMEOUT_SEC)
                logger.info("[im-feishu] 长连接已主动断开")
            except Exception as e:  # noqa: BLE001 — 停机路径上一切从宽
                logger.debug(f"[im-feishu] 主动断开未完成（继续停 loop）: {describe_error(e)}")
            try:
                loop.call_soon_threadsafe(loop.stop)
            except Exception as e:  # noqa: BLE001
                logger.debug(f"[im-feishu] 停 loop 失败: {describe_error(e)}")

        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=THREAD_JOIN_TIMEOUT_SEC)
            if self._thread.is_alive():
                logger.warning(
                    "[im-feishu] 连接线程未在 "
                    f"{THREAD_JOIN_TIMEOUT_SEC}s 内退出（daemon 线程，不阻塞进程退出）"
                )

    # ── 线程主体 ──────────────────────────────────────────────────────────
    def _run(self) -> None:
        try:
            if self._stopping:
                logger.info("[im-feishu] 连接线程还没开工停机请求就到了，直接退出")
                return
            ws = self._prepare()
            if ws is None:
                return  # 停机中止，_prepare 已打日志

            # 🔴 弃置线程自杀线（2026-08-04 真机事故）：等 ready 的那一方可能已经
            # 放弃本线程（stop() 置位了 _stopping）。此后**绝不能**再碰 lark 的
            # 模块级全局 loop —— 弃置线程抢跑 ws.start() 会把 loop 永久占死，
            # 之后每一条新连接线程都撞 fail-closed 检查，永久踢皮球。
            #
            # 🔴 顺序不可调换：自杀线必须在**发布 self._ws 之前**。``stop()`` 的优雅
            # 断开以「``_ws`` 非 None + 线程活着」为判据，把 ``ws._disconnect()``
            # 调度到**本线程的 loop** 上再 ``fut.result(3s)`` 等它 —— 而那个 loop
            # 只有 ``ws.start()`` 才会转。先发布再自杀 = 留下「``_ws`` 已公布但 loop
            # 永不转」的窗口，撞上就是 3 秒同步冻结在 serve 的 event loop 线程上
            # （``test_connection_stop.py`` 盯的正是这个形态）。发布放在自杀线之后
            # ⇒ **``_ws`` 非 None ⟹ 本线程必然进 ``ws.start()``**，窗口结构上不存在。
            if self._stopping:
                logger.info(
                    "[im-feishu] 停机请求已到，连接线程不启动 ws（不碰全局 loop）直接退出"
                )
                return
            self._ws = ws
            self._ready.set()
            logger.info("[im-feishu] 正在建立飞书长连接…")
            ws.start()  # 阻塞：内部自带重连；stop() 会让它抛出退出
        except Exception as e:  # noqa: BLE001 — 线程里逃逸的异常没人接得住
            if self._stopping:
                logger.info("[im-feishu] 连接线程随停机退出")
            else:
                self._fatal = describe_error(e)
                logger.error(f"[im-feishu] 长连接线程异常退出: {self._fatal}")
                logger.error(
                    "[im-feishu] 排查方向：① app_id/app_secret 是否属于**企业自建应用**"
                    "（商店应用不支持长连接）；② 后台是否已开启机器人能力；"
                    "③ 后台「事件与回调」下**事件订阅**与**回调订阅**是两个并列 tab，"
                    "各自都要选长连接并添加条目（漏事件订阅 = 私聊零日志）；"
                    "④ 网络：WS 段强制直连不读代理环境变量。"
                )
        finally:
            self._ready.set()  # 失败路径也要放行 start() 的等待

    def _prepare(self) -> Any:
        """import lark + 装配 ws client。返回装好的 ws；停机请求已到 → ``None``。

        🔴 packaged 首启的 lark 冷 import 可达**分钟级**（2026-08-04 真机实测
        2min17s：新进包依赖首次编译 .pyc + db_safety 备份大库抢磁盘 I/O）——
        期间 ``stop()`` 可能早已被调过。各步骤之间尽早响应 ``_stopping``，
        绝不把一个注定被弃的 client 推进 ``ws.start()``。
        单独成方法同时是离线测试的打桩 seam（tests/im 不许 import lark）。

        🔴 **不在这里写 ``self._ws``** —— 发布权归 ``_run``，且必须在自杀线**之后**
        （见那里的注释：``stop()`` 拿 ``_ws`` 当「这条 loop 会转」的判据）。
        """
        # 🔴 顺序不能反：先给本线程一个自己的 loop，再 import lark（见模块 docstring）
        asyncio.set_event_loop(asyncio.new_event_loop())

        import lark_oapi as lark
        from lark_oapi.ws import client as lark_ws_client

        # fail-closed：防真正的 import 顺序 bug（lark 被别的线程先 import 过）。
        # 🔴 保留勿删 —— 它也是「弃置活线程 + 新线程」并存时的最后一道闸。
        loop = lark_ws_client.loop
        if loop.is_running() or loop.is_closed():
            raise RuntimeError(
                "lark_oapi.ws.client 的全局 event loop 不可用"
                f"(running={loop.is_running()} closed={loop.is_closed()}) —— "
                "说明 lark 被别的线程先 import 过（很可能是在服务主循环上）。"
                "任何 lark import 都必须发生在本连接线程内。"
            )
        self._loop = loop

        if self._stopping:
            logger.info("[im-feishu] import 完成时停机请求已到，连接线程直接退出")
            return None

        log_level = lark.LogLevel.DEBUG if self._debug else lark.LogLevel.INFO
        self._api = build_api_client(self._app_id, self._app_secret, debug=self._debug)
        self._sender = LarkMessageSender(self._api)

        # 长连接下 encrypt_key / verification_token 传空串（C6 实证）
        builder = lark.EventDispatcherHandler.builder("", "")
        builder = builder.register_p2_im_message_receive_v1(self._message_handler)
        if self._card_action_handler is not None:
            # PR-3：审批卡按钮回调。后台要在**回调订阅** tab 单独配 card.action.trigger
            builder = builder.register_p2_card_action_trigger(self._card_action_handler)
        handler = builder.build()

        ws = lark.ws.Client(
            self._app_id,
            self._app_secret,
            event_handler=handler,
            log_level=log_level,
            auto_reconnect=True,
        )
        ws.on_reconnecting = lambda: logger.warning(
            "[im-feishu] 长连接断开，SDK 开始重连…"
        )
        ws.on_reconnected = lambda: logger.info("[im-feishu] 长连接**已重连**")

        # ws.Client 与 Client.builder 都会 setLevel 同一个全局 "Lark" logger，
        # 这里最后再钉一次，免得构造顺序把 DEBUG 覆盖回 INFO。
        from lark_oapi.core.log import logger as lark_logger

        lark_logger.setLevel(int(log_level.value))

        if self._stopping:
            logger.info("[im-feishu] client 构造完成时停机请求已到，连接线程直接退出")
            return None

        return ws
