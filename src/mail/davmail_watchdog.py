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

sync_state key 约定 (frontend 通过 better-sqlite3 直读)：
  davmail.last_probe_at           ISO 时间戳
  davmail.imap_reachable          '0' / '1'
  davmail.smtp_reachable          '0' / '1'
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
import re
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.mail.sync_store import SyncStore
    from src.notify.alert import FeishuAlertNotifier


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
_PROCESS_DOWN_THRESHOLD = 3  # 连续失败次数
_TOKEN_WARN_DAYS = 80.0
_TOKEN_CRITICAL_DAYS = 87.0


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
    ) -> None:
        self.sync_store = sync_store
        self.alerter = alerter
        self.davmail_root = Path(davmail_root)
        self.token_path = self.davmail_root / "token" / "token.dat"
        self.log_path = self.davmail_root / "logs" / "davmail.log"
        self.imap_host = imap_host
        self.imap_port = imap_port
        self.smtp_port = smtp_port
        self.poll_interval = poll_interval
        self.probe_timeout = probe_timeout

        self._stop = False
        # 用于跃迁检测：上一轮状态
        self._prev: Dict[str, Any] = {}
        self._consecutive_imap_fails = 0
        self._consecutive_smtp_fails = 0
        # 已告警的"门槛"标记，避免每轮重发（alerter 自己也有 cooldown 兜底）
        self._announced_process_down_imap = False
        self._announced_process_down_smtp = False
        self._announced_throttle_burst = False
        # 累计指标 (stats_reporter 用)
        self._counters = {
            "probe_cycles": 0,
            "imap_probe_failures_total": 0,
            "smtp_probe_failures_total": 0,
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
        )

        # ── 落盘 sync_state ───────────────────────────────────────────
        now_iso = datetime.fromtimestamp(now).isoformat(timespec="seconds")
        self._write_state(
            now_iso=now_iso,
            imap_ok=imap_ok,
            smtp_ok=smtp_ok,
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
            "throttle_events_5min": throttle_count,
            "last_oauth_error": oauth_error,
            "uid_backfill_paused": self._announced_throttle_burst,
            **self._counters,
        }

        # ── 告警跃迁 ──────────────────────────────────────────────────
        await self._evaluate_alerts(
            imap_ok=imap_ok,
            smtp_ok=smtp_ok,
            token_age_days=token_age_days,
            oauth_error=oauth_error,
            throttle_count=throttle_count,
        )

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
        """扫 davmail.log 末尾 50KB 找 OAuth 失败 + 5min 内 EWS throttle 计数。"""
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
        cutoff = time.time() - _THROTTLE_WINDOW_SECS

        for line in lines:
            if _OAUTH_FAIL_RE.search(line):
                # 取最后一条（最近）
                trimmed = line.strip()
                if len(trimmed) > 240:
                    trimmed = trimmed[:240] + "…"
                oauth_error = trimmed
            if _EWS_THROTTLE_RE.search(line):
                ts = self._extract_log_ts(line)
                # 只对带 log4j 行首 timestamp 的"事件头"行计数；
                # stack trace 续行没 timestamp 会被忽略，避免单次事件多行被重复计数。
                if ts is not None and ts >= cutoff:
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
    ) -> str:
        if oauth_error_active:
            return "critical"
        if not imap_ok or not smtp_ok:
            return "critical"
        if token_age_days is not None and token_age_days >= _TOKEN_CRITICAL_DAYS:
            return "critical"
        if token_age_days is not None and token_age_days >= _TOKEN_WARN_DAYS:
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
        token_age_days: Optional[float],
        oauth_error: Optional[str],
        throttle_count: int,
    ) -> None:
        if self.alerter is None:
            return

        # 1. 进程死亡（IMAP/SMTP 连续 ≥3 失败一次性告警，恢复后重置）
        if self._consecutive_imap_fails >= _PROCESS_DOWN_THRESHOLD:
            if not self._announced_process_down_imap:
                await self.alerter.alert_davmail_process_down(
                    self._consecutive_imap_fails, self.imap_port, "IMAP"
                )
                self._announced_process_down_imap = True
        elif imap_ok and self._announced_process_down_imap:
            await self.alerter.alert_davmail_process_recovered("IMAP")
            self._announced_process_down_imap = False

        if self._consecutive_smtp_fails >= _PROCESS_DOWN_THRESHOLD:
            if not self._announced_process_down_smtp:
                await self.alerter.alert_davmail_process_down(
                    self._consecutive_smtp_fails, self.smtp_port, "SMTP"
                )
                self._announced_process_down_smtp = True
        elif smtp_ok and self._announced_process_down_smtp:
            await self.alerter.alert_davmail_process_recovered("SMTP")
            self._announced_process_down_smtp = False

        # 2. Token 过期门槛
        if token_age_days is not None:
            if token_age_days >= _TOKEN_CRITICAL_DAYS:
                await self.alerter.alert_davmail_token_critical(token_age_days)
            elif token_age_days >= _TOKEN_WARN_DAYS:
                await self.alerter.alert_davmail_token_expiring(token_age_days)

        # 3. OAuth 失败：只在出现新错误时报（同一行不重复）
        if oauth_error and oauth_error != self._prev.get("oauth_error"):
            await self.alerter.alert_davmail_oauth_failure(oauth_error)

        # 4. EWS throttling burst：进入/离开 burst 时分别处理
        in_burst = throttle_count >= 3
        if in_burst and not self._announced_throttle_burst:
            await self.alerter.alert_davmail_ews_throttling(throttle_count)
            self.sync_store.set_state("davmail_uid_backfill_paused", "true")
            # 时间戳给 uid-mapper 的 24h 自动复位用 — 否则进程重启后
            # _announced_throttle_burst 内存态丢失, paused=true 永久残留。
            self.sync_store.set_state(
                "davmail_uid_backfill_paused_at", str(time.time())
            )
            self._announced_throttle_burst = True
            logger.warning(
                f"[davmail-watchdog] EWS throttle burst detected ({throttle_count} "
                f"events / 5min) — uid-mapper backfill auto-paused"
            )
        elif not in_burst and self._announced_throttle_burst and throttle_count == 0:
            # 完全干净一轮才解除，避免抖动
            self.sync_store.set_state("davmail_uid_backfill_paused", "false")
            self.sync_store.set_state("davmail_uid_backfill_paused_at", "")
            self._announced_throttle_burst = False
            logger.info(
                "[davmail-watchdog] EWS throttle cleared — uid-mapper backfill resumed"
            )
