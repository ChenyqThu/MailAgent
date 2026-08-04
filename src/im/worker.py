"""飞书对话 bot 的常驻 worker（08-01 阶段 2 PR-2）。

挂在 ``serve``（= ``main.py`` / pm2 ``mail-sync``）进程里，经
``src/service.py::_spawn_supervised(..., "im_feishu")`` 起 —— 形态照 CalendarSyncWorker
（flag gate + try/except 不阻断主链路），免费拿到退避重启 + 飞书告警 +
``worker.im_feishu.*`` 落 sync_state 供 ``admin health`` 直读。

**为什么挂 serve 不挂 serve-api**（dossier Q1）：serve 是打包态**唯一恒 spawn** 的
service（serve-api 由 ``MAILAGENT_REMOTE_ACCESS_ENABLED`` 门控），且它已有 supervise
宿主 + ``sync_store`` + ``alerter`` + ``AlertEpisodeTracker`` 全在手。

## 本 worker 的循环

    while 未停:
        ① pm2 多实例检测   —— 命中 → 不建连 + 落 conflict 状态 + 进告警观测, 5min 后重判
        ② 取凭证           —— 缺失 → 落 error 状态, 1min 后重判（spawn gate 已查过，
                              走到这里说明行被删/损坏）
        ③ 建连 + 监控      —— 直到连接线程死亡或停机
        ④ 退避 1min 重来

普通断线不走 ④ —— SDK 自带 ``auto_reconnect``；走到 ④ 说明线程 fatal 退出
（凭证错 / 非自建应用 / lark loop 被别人抢了）。

## 3 秒 ACK 的分工

lark handler（``ImEventRouter.on_message``）跑在 SDK 的 WS 线程上，只做内存操作；
真正的活（读绑定、发消息、将来的 agent run）在 ``DaemonExecutor`` 的 daemon 线程上。
本 worker 的协程只负责**监控 + 状态落盘 + 告警**，不碰任何飞书 IO。
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, Optional, Tuple

from loguru import logger

from src.im import state as im_state
from src.im.connection import FeishuConnection
from src.im.credentials import (
    FeishuAppCredentials,
    ensure_credentials,
    record_bot_identity,
)
from src.im.delivery import FeishuDelivery
from src.im.executor import DaemonExecutor
from src.im.handler import ImEventRouter
from src.im.lark_api import fetch_bot_identity
from src.im.logfmt import describe_error
from src.im.preflight import detect_pm2_conflict
from src.im.state import ImFeishuState

# 监控 tick（秒）—— 连接状态跃迁的探测粒度。纯内存判断，1s 很便宜。
MONITOR_POLL_SEC = 1.0
# 告警判定节拍（秒）—— episode 的 evaluate 要读 sync_state，不跟监控 tick 同频。
ALERT_TICK_SEC = 30.0
# 多实例冲突后的重判间隔（秒）：owner 停掉 pm2 后 5 分钟内自愈。
CONFLICT_RECHECK_SEC = 300.0
# 凭证缺失后的重判间隔（秒）。
CREDENTIAL_RECHECK_SEC = 60.0
# 连接线程 fatal 退出后的退避（秒）。
RECONNECT_RETRY_SEC = 60.0

# 连续不可用多久算「该告警了」（秒）。5min：短暂重连（SDK 自愈）不该惊动人。
UNAVAILABLE_ALERT_SEC = 300.0
# 严重度 marker 门槛（秒）。30min 还没回来 = 大概率要人工介入。
UNAVAILABLE_CRITICAL_SEC = 1800.0

# 不可用原因（只影响告警措辞，不影响 episode 生命周期）
REASON_DISCONNECTED = "disconnected"
REASON_CONFLICT = "conflict"
REASON_NO_CREDENTIALS = "no_credentials"
REASON_FATAL = "fatal"

_REASON_TEXT = {
    REASON_DISCONNECTED: "长连接断开且未能重连",
    REASON_CONFLICT: "检测到另一个实例（pm2 mail-sync）在跑，本进程有意不建连",
    REASON_NO_CREDENTIALS: "飞书应用凭证缺失或不可解密",
    REASON_FATAL: "长连接线程异常退出",
}


class _LazySender:
    """``MessageSender`` 代理 —— 真 sender 要等连接线程装好才有。

    路由/投递器必须在 ``FeishuConnection`` **构造前**就存在（handler 是构造参数），
    所以这里做一层晚绑定。未就绪时投递失败并明说，不静默吞。
    """

    def __init__(self) -> None:
        self._conn: Any = None

    def bind(self, conn: Any) -> None:
        self._conn = conn

    def create_message(
        self, receive_id: str, msg_type: str, content: Dict[str, Any]
    ) -> Optional[str]:
        sender = getattr(self._conn, "sender", None) if self._conn else None
        if sender is None:
            logger.error("[im-feishu] 投递失败：连接尚未就绪（sender 还没装好）")
            return None
        return sender.create_message(receive_id, msg_type, content)


def feishu_im_ready(cfg: Any, *, store: Any = None) -> Tuple[bool, str]:
    """spawn 前的同步 gate：flag + 凭证（顺带完成 env → 行的首次 seed）。

    🔴 **凭证检查必须在 spawn 之前**：``supervise`` 把「shutdown 未置位时的正常返回」
    当作 worker 死亡并进退避重启循环，所以 worker 自己不能靠 ``return`` 表达
    「没配置」。返回 ``(ready, reason)``，reason 是给日志用的人话。
    """
    if not bool(getattr(cfg, "im_feishu_enabled", False)):
        return False, "MAILAGENT_IM_FEISHU=false"
    creds = ensure_credentials(cfg, store=store)
    if creds is None:
        return False, (
            "未配置飞书对话 bot 凭证 —— 在 .env 里设 FEISHU_IM_APP_ID / "
            "FEISHU_IM_APP_SECRET 后重启（首次启动会 seed 进 agent_config.db，"
            "之后行权威）"
        )
    return True, f"app_id={creds.app_id[:8]}…"


class FeishuImWorker:
    """常驻 worker。``run()`` 交给 supervise，``stop()`` 供服务停机路径先手调用。"""

    def __init__(
        self,
        *,
        cfg: Any,
        sync_store: Any,
        alerter: Any = None,
        episodes: Any = None,
        debug: bool = False,
    ) -> None:
        self.cfg = cfg
        self.state = ImFeishuState(sync_store)
        self.alerter = alerter
        self.episodes = episodes
        self._debug = debug

        self._stopping = False
        self._conn: Optional[FeishuConnection] = None
        self._executor: Optional[DaemonExecutor] = None
        self._unavailable_since: Optional[float] = None
        self._unavailable_reason: str = REASON_DISCONNECTED
        self._last_alert_tick: float = 0.0
        self._conflict_announced = False

    # ── 生命周期 ──────────────────────────────────────────────────────────
    def stop(self) -> None:
        """请求停机（幂等）。服务停机时先调它，再 cancel task。"""
        self._stopping = True
        self._teardown()

    async def run(self) -> None:
        self._stopping = False
        self.state.set_status(im_state.STATUS_CONNECTING)
        try:
            while not self._stopping:
                if await self._handle_conflict_gate():
                    continue
                if self._stopping:
                    break

                creds = await asyncio.to_thread(ensure_credentials, self.cfg)
                if creds is None:
                    self.state.set_status(im_state.STATUS_ERROR)
                    self.state.set_last_error("飞书应用凭证缺失或不可解密")
                    logger.error(
                        "[im-feishu] 凭证不可用（行被删或 master key 变了）——"
                        f" {CREDENTIAL_RECHECK_SEC:.0f}s 后重试"
                    )
                    self._mark_unavailable(REASON_NO_CREDENTIALS)
                    await self._alert_tick()
                    if await self._sleep_or_stop(CREDENTIAL_RECHECK_SEC):
                        break
                    continue

                await self._serve_connection(creds)
                if self._stopping:
                    break
                if await self._sleep_or_stop(RECONNECT_RETRY_SEC):
                    break
        finally:
            self._teardown()
            self.state.set_status(im_state.STATUS_STOPPED)
            logger.info("[im-feishu] worker 已停止")

    # ── ① 多实例闸 ────────────────────────────────────────────────────────
    async def _handle_conflict_gate(self) -> bool:
        """有冲突 → 落状态 + 告警观测 + 退避，返回 True（外层 continue）。"""
        reason = await asyncio.to_thread(detect_pm2_conflict)
        if not reason:
            if self._conflict_announced:
                logger.info("[im-feishu] 多实例冲突已解除，继续建立长连接")
                self._conflict_announced = False
            self.state.clear_conflict()
            return False

        if not self._conflict_announced:
            logger.error(f"[im-feishu] 🔴 不建立长连接：{reason}")
            self._conflict_announced = True
        self.state.mark_conflict(reason)
        self._mark_unavailable(REASON_CONFLICT)
        await self._alert_tick()
        await self._sleep_or_stop(CONFLICT_RECHECK_SEC)
        return True

    # ── ③ 建连 + 监控 ─────────────────────────────────────────────────────
    async def _serve_connection(self, creds: FeishuAppCredentials) -> None:
        executor = DaemonExecutor().start()
        sender_proxy = _LazySender()
        delivery = FeishuDelivery(sender_proxy)
        router = ImEventRouter(
            state=self.state, delivery=delivery, submit=executor.submit
        )
        conn = FeishuConnection(
            creds.app_id,
            creds.app_secret,
            message_handler=router.on_message,
            # card_action_handler 留给 PR-3（审批卡按钮回调）
            debug=self._debug,
        )
        sender_proxy.bind(conn)
        self._executor = executor
        self._conn = conn

        self.state.set_status(im_state.STATUS_CONNECTING)
        if not await asyncio.to_thread(conn.start):
            detail = conn.fatal_error or "连接线程未能就绪"
            self.state.set_status(im_state.STATUS_ERROR)
            self.state.set_last_error(detail)
            self._mark_unavailable(REASON_FATAL)
            await self._alert_tick()
            self._teardown()
            return

        was_connected = False
        identity_scheduled = False
        last_event_written: Optional[str] = None
        try:
            while not self._stopping and conn.is_alive():
                connected = conn.is_connected()

                if connected and not was_connected:
                    self.state.mark_connected()
                    self._clear_unavailable()
                    logger.info(
                        "[im-feishu] 🟢 长连接已建立"
                        + ("" if identity_scheduled else "（正在读取 bot 身份…）")
                    )
                    if not identity_scheduled:
                        identity_scheduled = True
                        executor.submit(self._record_identity, conn, creds.app_id)
                elif was_connected and not connected:
                    self.state.set_status(im_state.STATUS_DISCONNECTED)
                    logger.warning("[im-feishu] 🔴 长连接已断开（SDK 自动重连中）")
                was_connected = connected

                if not connected:
                    self._mark_unavailable(REASON_DISCONNECTED)

                # handler 只更新内存（3 秒预算不许碰 sqlite），落盘在这里做
                if router.last_event_wall and router.last_event_wall != last_event_written:
                    last_event_written = router.last_event_wall
                    self.state.mark_last_event(last_event_written)

                await self._alert_tick()
                await asyncio.sleep(MONITOR_POLL_SEC)
        finally:
            if not self._stopping and conn.fatal_error:
                self.state.set_status(im_state.STATUS_ERROR)
                self.state.set_last_error(conn.fatal_error)
                self._mark_unavailable(REASON_FATAL)
            self._teardown()

    def _record_identity(self, conn: FeishuConnection, app_id: str) -> None:
        """首次连上后读 bot 身份 → 落 sync_state + 凭证行的明文 metadata。

        破**同名陷阱**：owner 环境里对话 app 与通知 app 都叫「MailAgent」。
        跑在 executor 线程（要发 HTTP）。失败只 warning。
        """
        bot = fetch_bot_identity(conn.api_client)
        if not bot:
            return
        app_name = str(bot.get("app_name") or "")
        bot_open_id = str(bot.get("open_id") or "")
        self.state.set_bot_identity(app_name=app_name, open_id=bot_open_id)
        record_bot_identity(
            app_id=app_id, app_name=app_name, bot_open_id=bot_open_id
        )
        logger.info(
            f"[im-feishu] 本连接背后的 bot：app_name={app_name!r} "
            f"open_id={bot_open_id} app_id={app_id[:8]}… "
            "（现有通知 bot 是另一个 app，可能同名 —— 私聊前请用它核对）"
        )

    # ── 告警（episode 语义）────────────────────────────────────────────────
    def _mark_unavailable(self, reason: str) -> None:
        if self._unavailable_since is None:
            self._unavailable_since = time.monotonic()
        self._unavailable_reason = reason

    def _clear_unavailable(self) -> None:
        self._unavailable_since = None

    async def _alert_tick(self, *, force: bool = False) -> None:
        """按 ``ALERT_TICK_SEC`` 节拍判定并投递失联告警。

        🔴 建模照抄 ``davmail_watchdog._check_and_alert`` 的 token 段：**一个 episode
        （``im_feishu_disconnected``）+ 一个 severity marker（``…_critical``）**，
        不是两个平级 episode —— 平级会在值从 critical 区间回落到 warning 区间时误报
        「已恢复」。

        🔴 **两阶段提交**：``evaluate`` 只判定，**告警真的投递成功**（返回 True）才
        ``commit``。``send_alert`` 会因 level 门 / cooldown 门 / 网络失败静默返回
        False —— 判定时就落盘 = 永久标「已告警」却从未送达 = 永久漏告警。
        """
        now = time.monotonic()
        if not force and (now - self._last_alert_tick) < ALERT_TICK_SEC:
            return
        self._last_alert_tick = now
        if self.episodes is None or self.alerter is None:
            return

        seconds = 0.0 if self._unavailable_since is None else now - self._unavailable_since
        reason_text = _REASON_TEXT.get(self._unavailable_reason, self._unavailable_reason)
        minutes = seconds / 60.0

        crit = self.episodes.evaluate(
            im_state.EPISODE_UNAVAILABLE_CRITICAL, seconds, UNAVAILABLE_CRITICAL_SEC
        )
        warn = self.episodes.evaluate(
            im_state.EPISODE_UNAVAILABLE, seconds, UNAVAILABLE_ALERT_SEC
        )

        from src.notify import episode as episode_mod

        if crit in (episode_mod.ENTER, episode_mod.ESCALATE):
            if await self._send(
                "critical",
                f"飞书对话 bot 已失联 {minutes:.0f} 分钟",
                f"**原因**: {reason_text}\n\n飞书里已经指挥不动 MailAgent，需要人工介入。",
            ):
                self.episodes.commit(im_state.EPISODE_UNAVAILABLE_CRITICAL, crit, seconds)
                # 这条 critical 同时就是 episode 本体的告知 → 一并标记，
                # 否则本体永远 inactive，将来恢复了发不出恢复通知。
                if warn in (episode_mod.ENTER, episode_mod.ESCALATE):
                    self.episodes.commit(im_state.EPISODE_UNAVAILABLE, warn, seconds)
        elif warn in (episode_mod.ENTER, episode_mod.ESCALATE):
            if await self._send(
                "warning",
                f"飞书对话 bot 已失联 {minutes:.0f} 分钟",
                f"**原因**: {reason_text}",
            ):
                self.episodes.commit(im_state.EPISODE_UNAVAILABLE, warn, seconds)

        # 严重度回落：不是恢复，不发消息，只复位 marker（无投递 → 无需 gate）
        if crit == episode_mod.RECOVER:
            self.episodes.commit(im_state.EPISODE_UNAVAILABLE_CRITICAL, crit, seconds)
        if warn == episode_mod.RECOVER:
            # alert_recovery 是 warning 级 —— info 级会被 ALERT_LEVELS 门吞掉
            if await self._recovery("飞书对话长连接"):
                self.episodes.commit(im_state.EPISODE_UNAVAILABLE, warn, seconds)

    async def _send(self, level: str, title: str, content: str) -> bool:
        try:
            return bool(
                await self.alerter.send_alert(
                    level=level,
                    title=title,
                    content=content,
                    source="im_feishu",
                    alert_key=f"im_feishu_unavailable:{level}",
                )
            )
        except Exception as e:  # noqa: BLE001 — 告警失败绝不拖垮 worker
            logger.warning(f"[im-feishu] 告警投递异常: {describe_error(e)}")
            return False

    async def _recovery(self, component: str) -> bool:
        try:
            return bool(await self.alerter.alert_recovery(component))
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[im-feishu] 恢复通知投递异常: {describe_error(e)}")
            return False

    # ── 杂项 ──────────────────────────────────────────────────────────────
    async def _sleep_or_stop(self, seconds: float) -> bool:
        """睡一会儿；返回是否应当退出（停机请求）。"""
        slept = 0.0
        while slept < seconds:
            if self._stopping:
                return True
            step = min(MONITOR_POLL_SEC, seconds - slept)
            await asyncio.sleep(step)
            slept += step
        return self._stopping

    def _teardown(self) -> None:
        conn, self._conn = self._conn, None
        executor, self._executor = self._executor, None
        if conn is not None:
            try:
                conn.stop()
            except Exception as e:  # noqa: BLE001
                logger.warning(f"[im-feishu] 断开连接时出错: {describe_error(e)}")
        if executor is not None:
            executor.shutdown()
