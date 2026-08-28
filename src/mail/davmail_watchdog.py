"""DavMail backend 健康监控 watchdog (roadmap §4.5.1 + §4.5.2 + §4.5.3).

60 秒一轮的后台任务，对 davmail-poc 做三类探测，把结果写进 sync_state
让 frontend / dashboard 直接读，并在状态跃迁时触发飞书告警（去重靠 alerter
内部的 cooldown）。

探测项：
  1. TCP probe 127.0.0.1:1143 (IMAP) + 1025 (SMTP) — 连续 ≥3 次失败 critical
  2. davmail-poc/token/token.dat mtime — age ≥80d warning / ≥87d critical
  3. davmail-poc/logs/davmail.log 末尾 50KB regex 扫:
     - BadPaddingException / refresh_token expired/invalid / InvalidGrant
       / AADSTS5017x / AADSTS7000x → OAuth failure critical
     - EWSThrottlingException 5min 内 ≥3 → warning + 自动暂停
       uid-mapper backfill (写 sync_state['davmail_uid_backfill_paused']='true')
  4. IMAP LOGIN 探测 (L2a, fork 31a50011 上游化) — TCP 可达时真实 LOGIN 一次,
     抓「端口活 / SMTP 正常但 IMAP LOGIN 持续失败」的 token 劣化形态
     (2026-06-12 事故 / AADSTS700003, 纯 TCP probe 抓不到)。连续 ≥阈值 →
     critical + 飞书告警。需注入 cfg (user_email + cipher key), 留 None 跳过。
     L2b: 达阈值后可选自动恢复 — 经注入的 restart_callback (默认 None = 仅告警;
     pm2 形态实现见 src/mail/davmail_restart.py), 冷却 + 24h 滚动窗口上限防风暴。

sync_state key 约定 (frontend 通过 better-sqlite3 直读)：
  davmail.last_probe_at           ISO 时间戳
  davmail.imap_reachable          '0' / '1'
  davmail.smtp_reachable          '0' / '1'
  davmail.imap_login_ok           '1' / '0' / '' (TCP 不可达/未注入 cfg/开关关 → 跳过)
  davmail.consecutive_login_failures  连续 LOGIN 失败计数
  davmail.login_fail_threshold    生效的 login 失败阈值 (F5, 传播到 admin/electron 防漂移)
  davmail.last_auto_restart_at    最近一次自动重启 ISO 时间戳 (L2b, 从未重启则无此键)
  davmail.auto_restart_times      JSON epoch 数组: 24h 窗口内重启时间戳 (F4, 跨进程重启存活)
  davmail.token_age_days          浮点字符串，token.dat 不存在为 '-1'
  davmail.token_mtime_iso         ISO 时间戳
  davmail.consecutive_imap_failures   连续失败计数
  davmail.consecutive_smtp_failures   连续失败计数
  davmail.throttle_events_5min    最近 5min EWS throttle 计数
  davmail.last_oauth_error        最近一次 OAuth 错误日志行（最多 240 字符）
  davmail.last_oauth_error_at     首次检测到时间
  davmail_uid_backfill_paused     'true' / 'false'  (跟 uid-mapper 共享)
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, Optional

from loguru import logger

from src.mail.throttle_pause import PAUSE_AT_KEY, PAUSE_KEY
from src.notify import episode
from src.notify.episode import AlertEpisodeTracker

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.sync_store import SyncStore
    from src.notify.alert import FeishuAlertNotifier
    from src.notify.center import NotifyCenter


_OAUTH_FAIL_RE = re.compile(
    r"BadPaddingException"
    # refresh_token / refresh token / "refresh token is expired" / "no longer"
    r"|refresh[_\s]token\s+(?:is\s+)?(?:expired|invalid|no\s+longer)"
    r"|InvalidGrant|invalid_grant"
    r"|AADSTS5017\d|AADSTS7000\d|AADSTS70043"
    r"|TokenExpiredException",
    re.IGNORECASE,
)
_EWS_THROTTLE_RE = re.compile(
    r"EWSThrottlingException|server cannot service this request",
    re.IGNORECASE,
)
# DavMail log4j default: 2026-05-22 17:23:45,123 LEVEL ...
_LOG_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})")

_LOG_TAIL_BYTES = 50 * 1024
_THROTTLE_WINDOW_SECS = 5 * 60
# OAuth 失败行同样只认窗口内的 —— 去重靠内存态 `_prev`, 进程一重启就清空,
# 而尾部 50KB 里可能还躺着几小时前、已经重走过 OAuth 的历史错误行 (davmail
# 日志安静时能赖很久)。不卡时间窗则每次 app 重启都对同一批陈旧错误重报一次
# critical (2026-08-27 实测: 重认证已成功、token 正常刷新, 仍收到假告警)。
# 真失效时 davmail 每次连接都会写新行, 窗口内必有新证据, 不会漏报。
_OAUTH_ERROR_WINDOW_SECS = 5 * 60
_PROCESS_DOWN_THRESHOLD = 3  # 连续失败次数
# 🔴 token 老化门槛的**唯一真源** (issue #68)。level 在本 watchdog 内 live 计算不落盘,
# 故 admin router (web 面重算) 与 CLI (`mailagent admin health` 提示行) 都要这两个值 ——
# 二者一律 `from src.mail.davmail_watchdog import TOKEN_WARN_DAYS, TOKEN_CRITICAL_DAYS`,
# **不许再就地复刻**。历史上三处各写一份, CLI 那份漏了 critical 档, 于是同一个 87 天
# token 在 web 面报 critical、`mailagent admin health` 只报 warning (issue #68 病根)。
# 旧注释称「不共享 import 因为 watchdog import 期会拉 SyncStore/alert 重依赖」——
# 已证伪: 本模块的 SyncStore/Config/FeishuAlertNotifier 全在 TYPE_CHECKING 下,
# 运行期只拉 loguru + 两个轻量 src 模块。
TOKEN_WARN_DAYS = 80.0
TOKEN_CRITICAL_DAYS = 87.0
# IMAP LOGIN 健康探测 (L2a) 默认值 — 可经 config 覆盖 (DAVMAIL_LOGIN_*)。
# F5 起生效值经 sync_state davmail.login_fail_threshold 传播给各读面; 这里是
# **键缺失时的 fallback 默认**, 同样单源 (admin router import 本名, 勿再复刻)。
LOGIN_FAIL_THRESHOLD = 3
_LOGIN_PROBE_TIMEOUT_SECS = 15
# 自动恢复 (L2b) 默认值 — 可经 config 覆盖 (DAVMAIL_AUTO_RESTART_*)。
# 冷却防 flap (成败都进冷却) + 24h 滚动窗口上限防重启风暴 (根因未解须人工)。
_AUTO_RESTART_COOLDOWN_SECS = 600
_AUTO_RESTART_MAX_PER_DAY = 6
_RESTART_WINDOW_SECS = 24 * 3600


class DavMailWatchdog:
    """davmail-poc 健康巡检循环."""

    def __init__(
        self,
        *,
        sync_store: "SyncStore",
        alerter: Optional["FeishuAlertNotifier"],
        davmail_root: Path,
        imap_host: str = "127.0.0.1",
        imap_port: int = 1143,
        smtp_port: int = 1025,
        poll_interval: int = 60,
        probe_timeout: float = 3.0,
        cfg: Optional["Config"] = None,
        login_probe_enabled: bool = True,
        login_probe_timeout: int = _LOGIN_PROBE_TIMEOUT_SECS,
        login_fail_threshold: int = LOGIN_FAIL_THRESHOLD,
        restart_callback: Optional[Callable[[], Awaitable[tuple[bool, str]]]] = None,
        auto_restart_cooldown: int = _AUTO_RESTART_COOLDOWN_SECS,
        auto_restart_max_per_day: int = _AUTO_RESTART_MAX_PER_DAY,
        episodes: Optional[AlertEpisodeTracker] = None,
        notify_center: Optional[NotifyCenter] = None,
    ) -> None:
        self.sync_store = sync_store
        # task 07-14: token 门槛告警的 episode 判定器 (由 service.py 注入, 带
        # MAILAGENT_ALERT_EPISODE flag)。未注入 (老调用方 / 单测) → disabled
        # tracker = 判据成立就告 = 老行为, 零行为变化。
        self.episodes = episodes or AlertEpisodeTracker(sync_store, enabled=False)
        # task 08-20-notification-center §7/§8.b: critical 组同时写通知中心 (由
        # service.py 注入; 未注入 = 老调用方 / 单测 → None = 只发飞书, 零行为变化)。
        # token 门槛是**唯一 episode 化**的一项 → 通知中心侧要自己的水位 (`nc.`
        # 前缀), 否则飞书没配 / 投递失败时 self.episodes 永不 commit → 每轮 60s
        # 重发一次 publish; 其余四项 (imap/smtp/login/oauth) 是 `_announced_*`
        # 内存态 announce-once, 与投递结果无关, 并列写入即可。
        self.notify_center = notify_center
        self._nc_episodes = AlertEpisodeTracker(
            sync_store, enabled=self.episodes.enabled
        )
        self.alerter = alerter
        self.davmail_root = Path(davmail_root)
        self.token_path = self.davmail_root / "token" / "token.dat"
        self.log_path = self.davmail_root / "logs" / "davmail.log"
        self.imap_host = imap_host
        self.imap_port = imap_port
        self.smtp_port = smtp_port
        self.poll_interval = poll_interval
        self.probe_timeout = probe_timeout
        # IMAP LOGIN 探测 (L2a) 需要 cfg (user_email + cipher key)；留 None 跳过
        # (老调用方零行为变化)。
        self.cfg = cfg
        self.login_probe_enabled = login_probe_enabled
        self.login_probe_timeout = login_probe_timeout
        self.login_fail_threshold = login_fail_threshold
        # L2b: 恢复策略 — 可注入 callback (默认 None = 仅告警不重启)。
        # 不硬编码 pm2: pm2 形态的实现见 src/mail/davmail_restart.py。
        self.restart_callback = restart_callback
        self.auto_restart_cooldown = auto_restart_cooldown
        self.auto_restart_max_per_day = auto_restart_max_per_day

        self._stop = False
        # 用于跃迁检测：上一轮状态
        self._prev: Dict[str, Any] = {}
        self._consecutive_imap_fails = 0
        self._consecutive_smtp_fails = 0
        self._consecutive_login_fails = 0
        # 已告警的"门槛"标记，避免每轮重发（alerter 自己也有 cooldown 兜底）
        self._announced_process_down_imap = False
        self._announced_process_down_smtp = False
        # blocker 修复 (pr-43 review): 从持久 flag 回种内存态。否则进程重启后若
        # throttle 已消退, set 分支 (要 in_burst) 与复位分支 (要内存 True) 都进不去,
        # 持久 flag 永久卡 'true' → 两个消费者 (uid-mapper backfill / watcher poll)
        # 永久停摆, 需人工 set_state 解锁。回种后 throttle 消退的干净一轮走复位分支
        # 把 flag 写回 'false' 自愈。
        self._announced_throttle_burst = (
            self.sync_store.get_state(PAUSE_KEY) == "true"
        )
        self._announced_login_degraded = False
        # L2b: 自动重启风暴防护状态 (F4: 从 sync_state 回种, 跨 MailAgent 进程重启
        # 存活 —— 否则风暴停止后重启进程即清零内存计数, 声明的 24h max_per_day 上限被
        # 绕过, 又能再重启一整轮)。
        last_ts, restart_times = self._load_restart_state()
        self._last_auto_restart_ts = last_ts
        self._restart_times: list[float] = restart_times  # 24h 滚动窗口内的重启时间戳
        self._announced_restart_storm = False
        # 累计指标 (stats_reporter 用)
        self._counters = {
            "probe_cycles": 0,
            "imap_probe_failures_total": 0,
            "smtp_probe_failures_total": 0,
            "imap_login_failures_total": 0,
            "auto_restarts_total": 0,
            "oauth_failures_detected_total": 0,
            "throttle_events_detected_total": 0,
        }
        # 最近一次完整快照 (get_snapshot 优先返回内存，避免 SQLite 读)
        self._snapshot: Dict[str, Any] = {}

    # ── lifecycle ──────────────────────────────────────────────────────

    async def run(self) -> None:
        logger.info(
            f"[davmail-watchdog] start | imap={self.imap_host}:{self.imap_port} "
            f"smtp=:{self.smtp_port} interval={self.poll_interval}s "
            f"token={self.token_path}"
        )
        while not self._stop:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — watchdog 不能挂
                logger.error(f"[davmail-watchdog] tick failed: {e}")
            try:
                await asyncio.sleep(self.poll_interval)
            except asyncio.CancelledError:
                raise

    def stop(self) -> None:
        self._stop = True

    # ── public API ─────────────────────────────────────────────────────

    def get_snapshot(self) -> Dict[str, Any]:
        """stats_reporter 的 collector hook。返回内存里最近一份快照。"""
        return dict(self._snapshot)

    # ── tick ──────────────────────────────────────────────────────────

    async def _tick(self) -> None:
        now = time.time()
        self._counters["probe_cycles"] += 1

        imap_ok = await self._probe_tcp(self.imap_host, self.imap_port)
        smtp_ok = await self._probe_tcp(self.imap_host, self.smtp_port)

        if imap_ok:
            self._consecutive_imap_fails = 0
        else:
            self._consecutive_imap_fails += 1
            self._counters["imap_probe_failures_total"] += 1
        if smtp_ok:
            self._consecutive_smtp_fails = 0
        else:
            self._consecutive_smtp_fails += 1
            self._counters["smtp_probe_failures_total"] += 1

        # IMAP LOGIN 探测 (L2a): 只在 TCP 可达 + 注入 cfg + 开关开时跑
        # (进程死亡是另一条告警路径, 不混入 token 劣化判定)。
        login_ok: Optional[bool] = None
        if imap_ok and self.cfg is not None and self.login_probe_enabled:
            login_ok = await asyncio.to_thread(self._probe_imap_login)
            if login_ok:
                self._consecutive_login_fails = 0
            else:
                self._consecutive_login_fails += 1
                self._counters["imap_login_failures_total"] += 1

        token_age_days, token_mtime = self._compute_token_age()
        oauth_error, throttle_count = self._scan_log_tail()
        if oauth_error and oauth_error != self._prev.get("oauth_error"):
            self._counters["oauth_failures_detected_total"] += 1
        if throttle_count:
            # 每轮 throttle 看到的事件数都计入 total（精度足够，不去重）
            self._counters["throttle_events_detected_total"] += throttle_count

        # 计算等级（snapshot 用）
        level = self._compute_overall_level(
            imap_ok=imap_ok,
            smtp_ok=smtp_ok,
            token_age_days=token_age_days,
            oauth_error_active=bool(oauth_error),
            throttle_burst=throttle_count >= 3,
            login_degraded=self._consecutive_login_fails >= self.login_fail_threshold,
        )

        # ── 落盘 sync_state ───────────────────────────────────────────
        now_iso = datetime.fromtimestamp(now).isoformat(timespec="seconds")
        self._write_state(
            now_iso=now_iso,
            imap_ok=imap_ok,
            smtp_ok=smtp_ok,
            login_ok=login_ok,
            token_age_days=token_age_days,
            token_mtime=token_mtime,
            oauth_error=oauth_error,
            throttle_count=throttle_count,
        )

        # ── snapshot dict（in-mem + stats collector）─────────────────
        self._snapshot = {
            "level": level,  # ok / warning / critical
            "last_probe_at": now_iso,
            "imap_reachable": imap_ok,
            "smtp_reachable": smtp_ok,
            "token_age_days": token_age_days,
            "token_mtime_iso": (
                datetime.fromtimestamp(token_mtime).isoformat(timespec="seconds")
                if token_mtime
                else None
            ),
            "consecutive_imap_failures": self._consecutive_imap_fails,
            "consecutive_smtp_failures": self._consecutive_smtp_fails,
            "imap_login_ok": login_ok,
            "consecutive_login_failures": self._consecutive_login_fails,
            "last_auto_restart_at": (
                datetime.fromtimestamp(self._last_auto_restart_ts).isoformat(
                    timespec="seconds"
                )
                if self._last_auto_restart_ts
                else None
            ),
            "throttle_events_5min": throttle_count,
            "last_oauth_error": oauth_error,
            "uid_backfill_paused": self._announced_throttle_burst,
            **self._counters,
        }

        # ── EWS throttle → uid-backfill pause flag (置位/心跳/复位) ──
        # 🔴 独立于 _evaluate_alerts 调用: 后者在 alerter is None (ALERT_ENABLED=false,
        # 生产默认!) 时**早退**, 若把 pause 管理留在里面, 默认配置下整个退避机制形同
        # 虚设 (PR #43 白装)。pause 是 backend 保护, 不该依赖告警是否开启。
        # 🔴 且排在 _evaluate_alerts **之前** (finding-2): 后者的告警走网络 I/O
        # (webhook 单次超时 10s), 保护面 pause 落盘不能被其它告警的网络阻塞推迟。两者
        # 操作互不相交的状态 (pause 只碰 _announced_throttle_burst + PAUSE_* sync_state;
        # _prev 在 _tick 末尾统一写, 两个调用都读上一轮的 _prev), 换序安全。
        await self._update_throttle_pause(throttle_count)

        # ── 告警跃迁 ──────────────────────────────────────────────────
        await self._evaluate_alerts(
            imap_ok=imap_ok,
            smtp_ok=smtp_ok,
            login_ok=login_ok,
            token_age_days=token_age_days,
            oauth_error=oauth_error,
        )

        # ── L2b: token 劣化自动恢复 (degraded 告警之后跑, 保证告警先出) ──
        await self._maybe_auto_restart(now)

        self._prev = {
            "imap_ok": imap_ok,
            "smtp_ok": smtp_ok,
            "oauth_error": oauth_error,
            "throttle_burst": throttle_count >= 3,
        }

    # ── helpers ────────────────────────────────────────────────────────

    async def _probe_tcp(self, host: str, port: int) -> bool:
        """打开 TCP 连接立刻关，能握上手就算活。"""
        try:
            fut = asyncio.open_connection(host, port)
            reader, writer = await asyncio.wait_for(fut, timeout=self.probe_timeout)
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
            return True
        except (asyncio.TimeoutError, ConnectionRefusedError, OSError):
            return False

    def _probe_imap_login(self) -> bool:
        """真实 IMAP LOGIN 一次 (asyncio.to_thread 里跑, imaplib 是阻塞库)。

        TCP 可达但 LOGIN 失败 = davmail 内部 token 状态劣化 (SMTP 可能仍正常,
        「能发不能收」), 纯 TCP probe 抓不到。复用 imap_client 连接工厂 —— 每次
        全新短命 session (DavMailBackend 每 op 也各自建连), 不干扰主同步。
        """
        # 局部 import: 避免 watchdog 模块 import 期拉 imap_client 重依赖
        from src.mail.backend.imap_client import DavMailConnectionError, imap_connect

        try:
            imap = imap_connect(self.cfg, timeout=self.login_probe_timeout)
        except DavMailConnectionError as e:
            logger.warning(f"[davmail-watchdog] IMAP login probe failed: {e}")
            return False
        except Exception as e:  # noqa: BLE001 — 探测不能挂 watchdog
            logger.warning(
                f"[davmail-watchdog] IMAP login probe error: {type(e).__name__}: {e}"
            )
            return False
        try:
            imap.logout()
        except Exception:
            pass
        return True

    def _load_restart_state(self) -> tuple[float, list[float]]:
        """F4: 从 sync_state 回种自动重启风暴防护状态 (跨进程重启存活)。

        - ``davmail.last_auto_restart_at`` (ISO) → 冷却基准时间戳。
        - ``davmail.auto_restart_times`` (JSON epoch 数组) → 24h 滚动窗口计数,
          load 时顺手 prune 掉窗口外的时间戳。
        坏数据 (JSON 解析失败 / 键缺失 / 类型错) 一律 fail-open 按空/0, 不挂 watchdog。
        """
        now = time.time()
        last_ts = 0.0
        raw_last = self.sync_store.get_state("davmail.last_auto_restart_at")
        if raw_last:
            try:
                last_ts = datetime.fromisoformat(raw_last).timestamp()
            except (ValueError, OSError):
                last_ts = 0.0
        restart_times: list[float] = []
        raw_times = self.sync_store.get_state("davmail.auto_restart_times")
        if raw_times:
            try:
                parsed = json.loads(raw_times)
                if isinstance(parsed, list):
                    restart_times = [
                        float(t)
                        for t in parsed
                        if isinstance(t, (int, float))
                        and now - float(t) < _RESTART_WINDOW_SECS
                    ]
            except (ValueError, TypeError):
                restart_times = []
        return last_ts, restart_times

    async def _maybe_auto_restart(self, now: float) -> None:
        """L2b: LOGIN 连续失败达阈值 → 调注入的 restart_callback (带风暴防护)。

        - callback 未注入 (默认) → no-op, 仅靠 _evaluate_alerts 的 degraded 告警。
        - 冷却: 两次重启间隔 ≥auto_restart_cooldown, 成败都进冷却 (防 flap)。
        - 风暴防护: 24h 滚动窗口内重启 ≥auto_restart_max_per_day → 停自动重启 +
          critical 告警一次 (镜像 supervise crashloop_stopped 语义), 窗口滚出后
          自动恢复。
        - 重启成功 → 计数清零 (下一轮真实探测重新说话); 失败 → 计数保留。
        """
        if self.restart_callback is None:
            return
        if self._consecutive_login_fails < self.login_fail_threshold:
            return
        if now - self._last_auto_restart_ts < self.auto_restart_cooldown:
            return

        self._restart_times = [
            t for t in self._restart_times if now - t < _RESTART_WINDOW_SECS
        ]
        if len(self._restart_times) >= self.auto_restart_max_per_day:
            if not self._announced_restart_storm:
                logger.error(
                    f"[davmail-watchdog] 自动重启风暴: 24h 内已重启 "
                    f"{len(self._restart_times)} 次 (上限 "
                    f"{self.auto_restart_max_per_day}) — 停自动重启, 需人工排查"
                )
                if self.alerter is not None:
                    await self.alerter.alert_davmail_restart_storm(
                        len(self._restart_times), self.auto_restart_max_per_day
                    )
                # task 08-20-notification-center M2-B2: 与 crash-loop 同构的
                # 「自动恢复已放弃, 需人工」—— 默认安装 (无飞书) 此前完全不可见。
                await self._notify_davmail_alert(
                    "restart_storm",
                    title="DavMail 自动重启已停止",
                    body=(
                        f"24h 内已自动重启 {len(self._restart_times)} 次 (上限 "
                        f"{self.auto_restart_max_per_day}), 停止自动重启, "
                        "需人工排查 (多半是 token 失效要重走 OAuth)。"
                    ),
                )
                self._announced_restart_storm = True
            return
        if self._announced_restart_storm:
            # 24h 窗口滚出 → 自动重启重新可用 = 明确的恢复信号, 收掉条目。
            await self._notify_davmail_resolve("restart_storm")
        self._announced_restart_storm = False

        # 成败都进冷却: callback 失败时避免每轮 (60s) 刷重启
        self._last_auto_restart_ts = now
        self._restart_times.append(now)
        self._counters["auto_restarts_total"] += 1
        fails = self._consecutive_login_fails
        logger.warning(
            f"[davmail-watchdog] IMAP LOGIN 连续 {fails} 次失败且 TCP 可达 — "
            f"判定 token 劣化, 执行自动恢复 callback"
        )
        try:
            ok, detail = await self.restart_callback()
        except Exception as e:  # noqa: BLE001 — 自愈动作失败不能挂 watchdog
            ok, detail = False, f"{type(e).__name__}: {e}"
        self.sync_store.set_state(
            "davmail.last_auto_restart_at",
            datetime.fromtimestamp(now).isoformat(timespec="seconds"),
        )
        # F4: 同步把 24h 窗口计数落盘, 跨进程重启存活 (max_per_day 上限不被绕过)
        self.sync_store.set_state(
            "davmail.auto_restart_times", json.dumps(self._restart_times)
        )
        if ok:
            self._consecutive_login_fails = 0
            logger.warning(
                f"[davmail-watchdog] 自动恢复成功 ({detail}) — 冷却 "
                f"{self.auto_restart_cooldown // 60} 分钟内不再触发"
            )
            # 上一次失败的条目在这里收掉 (重启成功 = 明确的恢复信号)。
            await self._notify_davmail_resolve("auto_restart_failed")
        else:
            logger.error(f"[davmail-watchdog] 自动恢复失败: {detail}")
            # 连续失败计次不刷屏 (dedupe_key 恒一条)。
            await self._notify_davmail_alert(
                "auto_restart_failed",
                title="DavMail 自动恢复失败",
                body=(
                    f"IMAP LOGIN 连续 {fails} 次失败后执行自动重启, 未成功: "
                    f"{detail}。冷却 {self.auto_restart_cooldown // 60} 分钟后重试。"
                ),
            )
        if self.alerter is not None:
            await self.alerter.alert_davmail_auto_restart(
                ok, detail, fails, self.auto_restart_cooldown // 60
            )

    def _compute_token_age(self) -> tuple[Optional[float], Optional[float]]:
        """返回 (age_days, mtime_epoch)；token.dat 不存在返回 (None, None)。"""
        try:
            st = self.token_path.stat()
        except FileNotFoundError:
            return None, None
        except OSError as e:
            logger.warning(f"[davmail-watchdog] token stat failed: {e}")
            return None, None
        mtime = st.st_mtime
        age_days = (time.time() - mtime) / 86400.0
        return age_days, mtime

    def _scan_log_tail(self) -> tuple[Optional[str], int]:
        """扫 davmail.log 末尾 50KB 找 5min 内的 OAuth 失败 + EWS throttle 计数。"""
        if not self.log_path.exists():
            return None, 0
        try:
            size = self.log_path.stat().st_size
            start = max(0, size - _LOG_TAIL_BYTES)
            with open(self.log_path, "rb") as f:
                f.seek(start)
                tail_bytes = f.read()
        except OSError as e:
            logger.debug(f"[davmail-watchdog] log read failed: {e}")
            return None, 0

        text = tail_bytes.decode("utf-8", errors="replace")
        lines = text.splitlines()
        oauth_error: Optional[str] = None
        throttle_count = 0
        now = time.time()
        throttle_cutoff = now - _THROTTLE_WINDOW_SECS
        oauth_cutoff = now - _OAUTH_ERROR_WINDOW_SECS
        last_ts: Optional[float] = None

        for line in lines:
            ts = self._extract_log_ts(line)
            if ts is not None:
                last_ts = ts
            if _OAUTH_FAIL_RE.search(line):
                # 取窗口内最后一条（最近）。BadPaddingException / TokenExpiredException
                # 恒落在异常堆栈续行上，本身没有 log4j timestamp —— 继承所属事件头行的
                # 时间戳，否则整类失败都会被时间窗吃掉。头行时间也拿不到才丢弃。
                event_ts = ts if ts is not None else last_ts
                if event_ts is not None and event_ts >= oauth_cutoff:
                    trimmed = line.strip()
                    if len(trimmed) > 240:
                        trimmed = trimmed[:240] + "…"
                    oauth_error = trimmed
            if _EWS_THROTTLE_RE.search(line):
                # 只对带 log4j 行首 timestamp 的"事件头"行计数；
                # stack trace 续行没 timestamp 会被忽略，避免单次事件多行被重复计数。
                if ts is not None and ts >= throttle_cutoff:
                    throttle_count += 1

        return oauth_error, throttle_count

    @staticmethod
    def _extract_log_ts(line: str) -> Optional[float]:
        m = _LOG_TS_RE.match(line)
        if not m:
            return None
        try:
            return datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").timestamp()
        except (ValueError, OSError):
            return None

    @staticmethod
    def _compute_overall_level(
        *,
        imap_ok: bool,
        smtp_ok: bool,
        token_age_days: Optional[float],
        oauth_error_active: bool,
        throttle_burst: bool,
        login_degraded: bool = False,
    ) -> str:
        if oauth_error_active:
            return "critical"
        if not imap_ok or not smtp_ok:
            return "critical"
        if login_degraded:
            # TCP 可达但 IMAP LOGIN 连续失败 = token 劣化 (能发不能收)
            return "critical"
        if token_age_days is not None and token_age_days >= TOKEN_CRITICAL_DAYS:
            return "critical"
        if token_age_days is not None and token_age_days >= TOKEN_WARN_DAYS:
            return "warning"
        if throttle_burst:
            return "warning"
        return "ok"

    def _write_state(
        self,
        *,
        now_iso: str,
        imap_ok: bool,
        smtp_ok: bool,
        login_ok: Optional[bool],
        token_age_days: Optional[float],
        token_mtime: Optional[float],
        oauth_error: Optional[str],
        throttle_count: int,
    ) -> None:
        ss = self.sync_store
        ss.set_state("davmail.last_probe_at", now_iso)
        ss.set_state("davmail.imap_reachable", "1" if imap_ok else "0")
        ss.set_state("davmail.smtp_reachable", "1" if smtp_ok else "0")
        ss.set_state(
            "davmail.imap_login_ok",
            "" if login_ok is None else ("1" if login_ok else "0"),
        )
        ss.set_state(
            "davmail.consecutive_login_failures", str(self._consecutive_login_fails)
        )
        # F5: 生效的 login 失败阈值传播到 admin router / electron 展示端,
        # 根治「四个健康读面各自硬编码 3, 设非默认值时判定漂移」。
        ss.set_state(
            "davmail.login_fail_threshold", str(self.login_fail_threshold)
        )
        ss.set_state(
            "davmail.consecutive_imap_failures", str(self._consecutive_imap_fails)
        )
        ss.set_state(
            "davmail.consecutive_smtp_failures", str(self._consecutive_smtp_fails)
        )
        if token_age_days is not None and token_mtime is not None:
            ss.set_state("davmail.token_age_days", f"{token_age_days:.2f}")
            ss.set_state(
                "davmail.token_mtime_iso",
                datetime.fromtimestamp(token_mtime).isoformat(timespec="seconds"),
            )
        else:
            ss.set_state("davmail.token_age_days", "-1")
            ss.set_state("davmail.token_mtime_iso", "")
        if oauth_error:
            ss.set_state("davmail.last_oauth_error", oauth_error)
            # 仅首次见到这条错误才更新时间戳
            if oauth_error != self._prev.get("oauth_error"):
                ss.set_state("davmail.last_oauth_error_at", now_iso)
        ss.set_state("davmail.throttle_events_5min", str(throttle_count))

    async def _evaluate_alerts(
        self,
        *,
        imap_ok: bool,
        smtp_ok: bool,
        login_ok: Optional[bool],
        token_age_days: Optional[float],
        oauth_error: Optional[str],
    ) -> None:
        # task 08-20-notification-center §8.b: 出口有两个 —— 飞书 alerter (默认
        # 安装是 None) 与通知中心。老 guard 会让默认安装连判定都不跑 (critical 组
        # 在铃铛里永远是空的) → 放宽为「至少一个出口在场」, 段内飞书调用逐点守卫。
        if self.alerter is None and self.notify_center is None:
            return

        # 1. 进程死亡（IMAP/SMTP 连续 ≥3 失败一次性告警，恢复后重置）
        if self._consecutive_imap_fails >= _PROCESS_DOWN_THRESHOLD:
            if not self._announced_process_down_imap:
                if self.alerter is not None:
                    await self.alerter.alert_davmail_process_down(
                        self._consecutive_imap_fails, self.imap_port, "IMAP"
                    )
                await self._notify_davmail_alert(
                    "imap_down",
                    title="DavMail IMAP 不可达",
                    body=(
                        f"IMAP :{self.imap_port} 连续 "
                        f"{self._consecutive_imap_fails} 次探测失败, "
                        "davmail 进程可能已死, 邮件同步已停摆。"
                    ),
                )
                self._announced_process_down_imap = True
        elif imap_ok and self._announced_process_down_imap:
            if self.alerter is not None:
                await self.alerter.alert_davmail_process_recovered("IMAP")
            await self._notify_davmail_resolve("imap_down")
            self._announced_process_down_imap = False

        if self._consecutive_smtp_fails >= _PROCESS_DOWN_THRESHOLD:
            if not self._announced_process_down_smtp:
                if self.alerter is not None:
                    await self.alerter.alert_davmail_process_down(
                        self._consecutive_smtp_fails, self.smtp_port, "SMTP"
                    )
                await self._notify_davmail_alert(
                    "smtp_down",
                    title="DavMail SMTP 不可达",
                    body=(
                        f"SMTP :{self.smtp_port} 连续 "
                        f"{self._consecutive_smtp_fails} 次探测失败, 发信不可用。"
                    ),
                )
                self._announced_process_down_smtp = True
        elif smtp_ok and self._announced_process_down_smtp:
            if self.alerter is not None:
                await self.alerter.alert_davmail_process_recovered("SMTP")
            await self._notify_davmail_resolve("smtp_down")
            self._announced_process_down_smtp = False

        # 1b. IMAP LOGIN 劣化 (L2a): 连续 ≥阈值失败一次性告警, 恢复后通知
        #     (announce-once-until-cleared, 镜像进程 down/recovered 模式)
        if self._consecutive_login_fails >= self.login_fail_threshold:
            if not self._announced_login_degraded:
                if self.alerter is not None:
                    await self.alerter.alert_davmail_login_degraded(
                        self._consecutive_login_fails, self.login_fail_threshold
                    )
                await self._notify_davmail_alert(
                    "login_degraded",
                    title="DavMail IMAP LOGIN 劣化",
                    body=(
                        f"端口可达但 LOGIN 连续失败 {self._consecutive_login_fails} "
                        f"次 (阈值 {self.login_fail_threshold}), token 可能已失效。"
                    ),
                )
                self._announced_login_degraded = True
        elif login_ok and self._announced_login_degraded:
            if self.alerter is not None:
                await self.alerter.alert_davmail_login_recovered()
            await self._notify_davmail_resolve("login_degraded")
            self._announced_login_degraded = False

        # 2. Token 过期门槛 — episode 化 (task 07-14): 原来每轮 (60s) 都告, 只靠
        #    alerter 的 300s 内存冷却 → age 一旦越 80d 就每 5min 一条刷到重新
        #    OAuth 为止 (且进程重启即复发)。
        #
        #    🔴 建模成**一个 episode + 一个 severity marker**, 不是两个平级 episode:
        #      - `davmail_token`          (门槛 80d) = episode 本体, 负责「告知一次」
        #                                  与「恢复一次」的生命周期。
        #      - `davmail_token_critical` (门槛 87d) = 严重度升级标记, 只决定这条
        #                                  消息用 critical 还是 warning 措辞。
        #    两个平级 episode 会打架: age 首次 89 时两边都 active, 之后 age 降到 82
        #    (仍在 warning 区间!) → critical episode 判 RECOVER → 误报「token 已恢复」。
        #    现在 82 只让 severity marker 复位 (无消息, 因为情况是变好且 token
        #    episode 仍 active 用户早已知情), 恢复通知**只在 age < 80 时**发。
        #
        #    投递成功才 commit (两阶段提交, 理由见 episode.py 模块 docstring)。
        if token_age_days is not None:
            crit = self.episodes.evaluate(
                "davmail_token_critical", token_age_days, TOKEN_CRITICAL_DAYS
            )
            warn = self.episodes.evaluate(
                "davmail_token", token_age_days, TOKEN_WARN_DAYS
            )
            if crit in (episode.ENTER, episode.ESCALATE):
                if self.alerter is not None and await self.alerter.alert_davmail_token_critical(
                    token_age_days
                ):
                    self.episodes.commit(
                        "davmail_token_critical", crit, token_age_days
                    )
                    # 这条 critical 消息**同时就是** token episode 的告知 (严重度
                    # 更高, 不再另发 expiring) → 一并标记 episode 已告知; 否则它
                    # 永远 inactive, 将来 age 归零就发不出恢复通知。
                    if warn in (episode.ENTER, episode.ESCALATE):
                        self.episodes.commit("davmail_token", warn, token_age_days)
            elif warn in (episode.ENTER, episode.ESCALATE):
                if self.alerter is not None and await self.alerter.alert_davmail_token_expiring(
                    token_age_days
                ):
                    self.episodes.commit("davmail_token", warn, token_age_days)

            # 严重度回落 (≥87 → [80,87)): 不是恢复, 不发消息, 只复位 marker 让它
            # 将来能重新升级告警。无投递 → 无需 gate。
            if crit == episode.RECOVER:
                self.episodes.commit("davmail_token_critical", crit, token_age_days)
            # 真·恢复: age < 80 (重走 OAuth 后 token.dat 刷新 → age 归零) 才发。
            if warn == episode.RECOVER:
                if self.alerter is not None and await self.alerter.alert_recovery(
                    "DavMail OAuth token"
                ):
                    self.episodes.commit("davmail_token", warn, token_age_days)

            # 通知中心: 两档 (80d warning / 87d critical) 共用**一条**条目
            # (dedupe_key `alert:davmail:token`), 结构与上面飞书那份 1:1 ——
            #   nc.davmail_token          (80d) = episode 本体, 决定条目的生死
            #                                     (ENTER 开条目, RECOVER 收条目)
            #   nc.davmail_token_critical (87d) = 严重度升级标记, 只决定这次 publish
            #                                     用 critical 还是 warn
            # 共用 key 让升档天然表达成「同一条目 severity 只升不降 + 未读化」
            # (NotifyCenter._bump), 而不是在铃铛里堆两条讲同一个 token 的条目。
            # 降档 (≥87 → [80,87)) 不收条目 —— warning 档判据仍成立, 只复位 marker,
            # 与飞书侧「不是恢复, 不发消息」同判据; 真恢复 (age<80, 重走 OAuth 后
            # token.dat 刷新) 才 resolve。水位独立 (`nc.` 前缀), 落库成功即 commit。
            nc_crit = self._nc_episodes.evaluate(
                "nc.davmail_token_critical", token_age_days, TOKEN_CRITICAL_DAYS
            )
            nc_warn = self._nc_episodes.evaluate(
                "nc.davmail_token", token_age_days, TOKEN_WARN_DAYS
            )
            nc_title = f"DavMail token 已 {token_age_days:.0f} 天未刷新"
            if nc_crit in (episode.ENTER, episode.ESCALATE):
                if await self._notify_davmail_alert(
                    "token",
                    title=nc_title,
                    body=(
                        f"token.dat age={token_age_days:.1f}d "
                        f"(critical 门槛 {TOKEN_CRITICAL_DAYS:.0f}d), 到期后收发信全停, "
                        "需重走 OAuth。"
                    ),
                ):
                    self._nc_episodes.commit(
                        "nc.davmail_token_critical", nc_crit, token_age_days
                    )
                    # 这条 critical 就是 token episode 的告知 → 一并标记, 否则
                    # warning 档永远 inactive, 将来 age 归零就发不出 resolve。
                    if nc_warn in (episode.ENTER, episode.ESCALATE):
                        self._nc_episodes.commit(
                            "nc.davmail_token", nc_warn, token_age_days
                        )
            elif nc_warn in (episode.ENTER, episode.ESCALATE):
                if await self._notify_davmail_alert(
                    "token",
                    title=nc_title,
                    body=(
                        f"token.dat age={token_age_days:.1f}d "
                        f"(warning 门槛 {TOKEN_WARN_DAYS:.0f}d), 建议尽快重走 OAuth; "
                        f"到 {TOKEN_CRITICAL_DAYS:.0f}d 后收发信将全停。"
                    ),
                    severity="warn",
                ):
                    self._nc_episodes.commit(
                        "nc.davmail_token", nc_warn, token_age_days
                    )
            if nc_crit == episode.RECOVER:
                self._nc_episodes.commit(
                    "nc.davmail_token_critical", nc_crit, token_age_days
                )
            if nc_warn == episode.RECOVER:
                if await self._notify_davmail_resolve("token"):
                    self._nc_episodes.commit(
                        "nc.davmail_token", nc_warn, token_age_days
                    )

        # 3. OAuth 失败：只在出现新错误时报（同一行不重复）
        if oauth_error and oauth_error != self._prev.get("oauth_error"):
            if self.alerter is not None:
                await self.alerter.alert_davmail_oauth_failure(oauth_error)
            # 无恢复信号 (日志里不会出现「OAuth 又好了」) → 只发不收; 用户读掉即
            # 清徽标, resolve 留给 M2 的单条动作。
            await self._notify_davmail_alert(
                "oauth_failure",
                title="DavMail OAuth 失败",
                body=oauth_error[:240],
            )

    async def _notify_davmail_alert(
        self, sub: str, *, title: str, body: str, severity: str = "critical"
    ) -> bool:
        """DavMail 告警 → 通知中心 (task 08-20-notification-center §7)。

        返回**是否落库成功** —— episode 化的挂点 (token 两档) 据此决定要不要
        commit 水位 (episode.py 的两阶段提交纪律: 没送达就别标已告警);
        `_announced_*` 内存态挂点忽略返回值 (与飞书调用同款 announce-once)。

        落库失败仅 warning: watchdog 巡检循环绝不能被 SQLite 打挂。
        """
        center = self.notify_center
        if center is None:
            return False
        try:
            await asyncio.to_thread(
                center.publish,
                category="system",
                source="davmail",
                title=title,
                body=body,
                severity=severity,
                dedupe_key=f"alert:davmail:{sub}",
                payload={"link": {"type": "route", "to": "/admin/kanban"}},
            )
            return True
        except Exception as e:  # noqa: BLE001 — 通知落库失败不影响巡检
            logger.warning(f"[notify-center] davmail alert failed ({sub}): {e}")
            return False

    async def _notify_davmail_resolve(self, sub: str) -> bool:
        """状态恢复 → 收掉对应通知条目 (open|snoozed → resolved)。"""
        center = self.notify_center
        if center is None:
            return False
        try:
            await asyncio.to_thread(
                center.resolve_by_dedupe, f"alert:davmail:{sub}"
            )
            return True
        except Exception as e:  # noqa: BLE001 — 同上
            logger.warning(f"[notify-center] davmail resolve failed ({sub}): {e}")
            return False

    async def _update_throttle_pause(self, throttle_count: int) -> None:
        """EWS throttle burst → uid-backfill pause flag 的置位/心跳/复位。

        🔴 时间戳心跳语义 (pr-43 follow-up review): PAUSE_AT_KEY 记的是 **watchdog
        存活心跳** 而非「进入 pause 的时刻」。announced pause 持续期间**每轮 tick 都
        刷新**时间戳 (含滞回区间, 见下):
          - watchdog 活着 + pause 持续 → 心跳恒新鲜 → 消费侧 pause 恒生效 (不再有
            30min 上限反噬正常场景: 持续限流 >30min 时消费侧仍老实挂起, 不会误放行
            backfill + poll 反而加剧 throttle)。
          - watchdog 死掉 → 心跳停更 → 消费侧超龄 (默认 30min) 后自愈放行 (原 staleness
            设计目标保留, 防整同步永久静默停摆)。
          - 旧版无时间戳 paused=true 重启且仍在 burst → __init__ 已回种
            _announced_throttle_burst=True, 这一轮补写时间戳 (间隙 = 一个 watchdog
            tick 间隔, 期间消费侧按无时间戳短暂放行一轮, 可接受)。

        🔴 滞回区间也刷心跳 (finding-1): 进入门槛 (>=3) 高于解除门槛 (==0), throttle
        长期徘徊 1-2 时 in_burst=False 但 announced pause 仍在——若只有 in_burst 刷心跳,
        这段心跳停更, 30min 后消费侧误判 stale 放行 (watchdog 明明活着且认为 paused)。
        故心跳条件放宽为「announced pause 且本轮仍有 throttle 事件 (>0)」, 只有完全
        干净一轮 (==0) 才复位——保留「完全干净一轮才解除」的滞回语义。

        🔴 保护面先落盘, 告警后发 (finding-2): 首次进入 burst 时先写 PAUSE_KEY/
        PAUSE_AT_KEY 再 await alert——告警走网络 I/O 可能超时/阻塞, 不能推迟 pause
        保护落盘。alert 只在**首次进入** burst 发一次 (announce-once, 且 alerter
        可能未配置); 复位需完全干净一轮 (throttle_count==0) 避免抖动。
        """
        in_burst = throttle_count >= 3
        # 滞回: 只要仍处 announced pause 且本轮还有 throttle 事件 (含刚进入 burst 这轮)
        # 就 hold —— 覆盖 1-2 徘徊的滞回区间, 否则心跳停更被消费侧误判 stale (finding-1)。
        hold_pause = in_burst or (self._announced_throttle_burst and throttle_count > 0)
        if hold_pause:
            # 心跳: 每轮刷新时间戳 — 消费侧 staleness 兜底靠它判 watchdog 是否还活着。
            # 统一 str 存 float (避 ISO 秒截断误标)。🔴 保护面先落盘再告警 (finding-2):
            # 下方 await alert 走网络 I/O 可能阻塞, 不能推迟 pause 写入。
            self.sync_store.set_state(PAUSE_KEY, "true")
            self.sync_store.set_state(PAUSE_AT_KEY, str(time.time()))
            if in_burst and not self._announced_throttle_burst:
                # 首次进入 burst: announce (announce-once) + 告警一次 (alerter 可能未配置)
                self._announced_throttle_burst = True
                logger.warning(
                    f"[davmail-watchdog] EWS throttle burst detected "
                    f"({throttle_count} events / 5min) — uid-mapper backfill "
                    f"auto-paused"
                )
                if self.alerter is not None:
                    await self.alerter.alert_davmail_ews_throttling(throttle_count)
                # 通知中心 (M3-C2): 与飞书调用并列的第二个出口 —— 默认安装
                # (ALERT_ENABLED=false) 此前只有 /admin/system-alerts 合成得出这档,
                # 摘掉 SystemAlertBadge 后就只剩铃铛。announce-once 与 pause 同源,
                # 无独立水位。
                await self._notify_davmail_alert(
                    "ews_throttle",
                    title="EWS 限流中",
                    body=(
                        f"5 分钟内检测到 {throttle_count} 次 EWS throttle, "
                        "uid-mapper backfill 已自动暂停; 限流消退后自动恢复。"
                    ),
                    severity="warn",
                )
        elif self._announced_throttle_burst and throttle_count == 0:
            # 完全干净一轮才解除，避免抖动
            self.sync_store.set_state(PAUSE_KEY, "false")
            self.sync_store.set_state(PAUSE_AT_KEY, "")
            self._announced_throttle_burst = False
            logger.info(
                "[davmail-watchdog] EWS throttle cleared — uid-mapper backfill "
                "resumed"
            )
            # 解除 = 明确的恢复信号 (与 pause 复位同一判据) → 收掉条目。
            await self._notify_davmail_resolve("ews_throttle")
