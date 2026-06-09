"""MailAgent 长驻服务核心 (P1-4a packaging C-1).

本模块是邮件同步**长驻服务**的单一真源 (EmailNotionSyncApp + run_service).

历史背景: 服务逻辑原本写在仓库根 `main.py`, 但 `main.py` 不在 `src/` 包内 ——
打包后 venv 的 site-packages 只含 `src/` (见 pyproject.toml
`[tool.setuptools.packages.find] include = ["src*"]`), 不含根 `main.py`, 导致
`mailagent serve` / 嵌入式 venv 无法拉起服务。P1-4a 把整类 + 服务运行逻辑原样
迁入这里 (绝对包导入 `from src.xxx import ...` 迁入 src/ 后仍成立), 让它成为
可被打包的 import 入口。

调用方:
- `mailagent serve` (src/cli/main.py) → `asyncio.run(run_service())`
- 仓库根 `main.py` 薄壳 (dev / PM2 路径) → `asyncio.run(run_service())`
两条路径行为完全一致 (零行为变更, 仅搬家 + 包装)。

⚠ 路径解析说明: 原 `main.py` 用 `__file__` 推 `davmail-poc/` 与 `scripts/` 都假设
`__file__` == 仓库根 main.py。迁入 `src/service.py` 后 `__file__` 变成 `src/service.py`,
故这里显式用 `_REPO_ROOT = Path(__file__).resolve().parent.parent` (src/ → 仓库根)
还原原行为, 保证 davmail-poc 探测与 scripts/keep_alive 导入路径不变。
"""

import asyncio
import os
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger
from src.config import config
from src.utils.logger import setup_logger

# 仓库根 (src/service.py → 上跳一层). 原 main.py 用 __file__ 推 davmail-poc / scripts
# 时假设 __file__ 在仓库根, 迁入 src/ 后必须显式还原, 否则路径会错指到 src/ 下。
_REPO_ROOT = Path(__file__).resolve().parent.parent

class EmailNotionSyncApp:
    """邮件同步应用主类"""

    def __init__(self):
        # Sprint 16 dual-backend: 启动时按 cfg.mailagent_backend 创建 backend.
        # backend factory 内部 probe 失败时 raise BackendStartupError, 这里捕获后 print
        # 友好切换提示 + sys.exit(1). PM2 ecosystem 配 autorestart=false, 不死循环重试.
        from src.mail.backend import create_backend, BackendStartupError
        from src.mail.sync_store import SyncStore

        try:
            sync_store_early = SyncStore(config.sync_store_db_path)
        except Exception as e:
            logger.error(f"SyncStore init failed: {e}")
            sys.exit(1)

        try:
            self.backend = create_backend(config, sync_store=sync_store_early)
        except BackendStartupError as e:
            print(f"\n❌ {e}", file=sys.stderr)
            if e.fallback_hint:
                print(f"   → {e.fallback_hint}\n", file=sys.stderr)
            # Sprint 16: probe 失败立即发飞书告警 (alerter 还没主流程初始化, 临时一次性发)
            # 注意: asyncio 顶部已 import, 这里不要 re-import, 否则触发 UnboundLocalError
            # ("cannot access local variable 'asyncio'") 把整个 __init__ 当 local scope
            if config.alert_feishu_webhook_url and config.alert_enabled:
                try:
                    from src.notify.alert import FeishuAlertNotifier
                    _tmp_alerter = FeishuAlertNotifier(
                        webhook_url=config.alert_feishu_webhook_url,
                        webhook_secret=config.alert_feishu_webhook_secret,
                        enabled=config.alert_enabled,
                        levels=[lv.strip() for lv in config.alert_levels.split(',')],
                        cooldown=config.alert_cooldown,
                    )
                    asyncio.run(_tmp_alerter.send_alert(
                        level="critical",
                        title=f"MailAgent 启动失败: {config.mailagent_backend} backend probe 不过",
                        message=f"{e}\n\n切换提示: {e.fallback_hint or '无'}\n\n服务已退出, 不会自动重启 (autorestart=false).",
                        alert_key=f"backend_startup_fail:{config.mailagent_backend}",
                    ))
                    asyncio.run(_tmp_alerter.close())
                except Exception as alert_err:
                    print(f"⚠️ 同时尝试发飞书告警也失败: {alert_err}", file=sys.stderr)
            sys.exit(1)

        # Sprint 16: davmail 模式自动禁用 keep_alive (IMAP/SMTP 不需要 UI session).
        if self.backend.backend_origin == "davmail" and config.keep_alive_enabled:
            logger.info(
                "[main] keep_alive 自动禁用 (davmail backend 走 IMAP/SMTP, 不需要 UI session)"
            )
            config.keep_alive_enabled = False  # type: ignore[misc]

        from src.mail.new_watcher import NewWatcher
        logger.info(
            f"Using NewWatcher (backend={self.backend.backend_origin}, "
            f"SQLite Radar + AppleScript Arm)"
        )

        # 解析邮箱列表
        mailboxes = [mb.strip() for mb in config.sync_mailboxes.split(',') if mb.strip()]
        if not mailboxes:
            mailboxes = ["收件箱"]

        self.watcher = NewWatcher(
            mailboxes=mailboxes,
            poll_interval=config.radar_poll_interval,
            sync_store_path=config.sync_store_db_path,
            backend=self.backend,
        )

        # 事件处理器引用（用于 stats）
        self._event_handlers = None

        # Sprint 15: SQLite SSoT inversion — outbox + FanoutWorker
        # 默认关闭（灰度期）；开启后异步派发 email flag / processing_status 到
        # Mail.app + Notion，handler / reverse_sync_poll 走 intent 路径不再
        # 直接 AppleScript。详 SPRINT15-HANDOFF.md §3 + plan。
        # 必须先于 reverse_sync 构造（reverse_sync 需注入 outbox_repo）。
        self.outbox_repo = None
        self.fanout_worker = None
        # C1: JobWorker 在 start() 里按 gate 构造; 这里先初始化为 None, 与 fanout_worker
        # 对齐, 避免 start() 早退路径下 shutdown 引用 self.job_worker 时 AttributeError。
        self.job_worker = None
        if config.mailagent_outbox_enabled:
            from src.sync import (
                FanoutWorker,
                MailAppFanout,
                NotionFanout,
                OutboxRepository,
            )
            self.outbox_repo = OutboxRepository(config.sync_store_db_path)
            mailapp_fanout = MailAppFanout(
                sync_store=self.watcher.sync_store,
                arm=self.watcher.arm,
            )
            notion_fanout = NotionFanout(
                sync_store=self.watcher.sync_store,
                notion_sync=self.watcher.notion_sync,
            )
            self.fanout_worker = FanoutWorker(
                outbox_repo=self.outbox_repo,
                mailapp_fanout=mailapp_fanout,
                notion_fanout=notion_fanout,
                poll_interval_sec=config.mailagent_outbox_poll_interval_sec,
                concurrency=config.mailagent_outbox_concurrency,
                max_attempts=config.mailagent_outbox_max_attempts,
            )
            logger.info(
                f"[outbox] FanoutWorker configured "
                f"(poll={config.mailagent_outbox_poll_interval_sec}s, "
                f"concurrency={config.mailagent_outbox_concurrency}, "
                f"max_attempts={config.mailagent_outbox_max_attempts})"
            )
        else:
            logger.info("[outbox] FanoutWorker disabled (MAILAGENT_OUTBOX_ENABLED=false)")

        # 反向同步（Notion -> Mail.app + 飞书通知）
        # Sprint 15: 注入 outbox_repo 后 sync_single_page 改写 SQLite intent + outbox
        # 不再直调 AppleScript (跟 webhook handle_* / CLI 完全统一)。
        from src.mail.reverse_sync import NotionToMailSync
        # Redis 事件启用时，跳过轮询通知（由 Redis handler 负责，避免重复）
        skip_notify = bool(config.redis_events_enabled and config.redis_url)
        self.reverse_sync = NotionToMailSync(
            notion_sync=self.watcher.notion_sync,
            arm=self.watcher.arm,
            sync_store=self.watcher.sync_store,
            skip_notify=skip_notify,
            outbox_repo=self.outbox_repo,
        )

        # 飞书告警通知
        self.alerter = None
        if config.alert_enabled and config.alert_feishu_webhook_url:
            from src.notify.alert import FeishuAlertNotifier
            self.alerter = FeishuAlertNotifier(
                webhook_url=config.alert_feishu_webhook_url,
                secret=config.alert_feishu_webhook_secret,
                enabled_levels=config.alert_levels,
                cooldown=config.alert_cooldown,
            )
            logger.info(f"Alert notifier configured: levels={config.alert_levels} cooldown={config.alert_cooldown}s")

        # Redis 事件消费（P3: Notion webhook → Redis → Mail.app）
        self.redis_consumer = None
        if config.redis_events_enabled and config.redis_url:
            from src.events.redis_consumer import RedisConsumer
            from src.events.handlers import EventHandlers

            queue_key = f"mailagent:{config.email_database_id.replace('-', '')}:events"
            self.redis_consumer = RedisConsumer(
                redis_url=config.redis_url,
                redis_db=config.redis_db,
                queue_key=queue_key,
            )

            # 构建飞书通知器（复用 reverse_sync 的或新建）
            feishu = self.reverse_sync._feishu

            handlers = EventHandlers(
                arm=self.watcher.arm,
                sync_store=self.watcher.sync_store,
                feishu=feishu,
                notion_sync=self.watcher.notion_sync,
                result_callback=self.redis_consumer.publish_result,
                # v4: 让 handle_fetch_mail_content 优先读 SQLite SSoT，
                # 历史未双写邮件自动 fallback 到 AppleScript
                email_repo=self.watcher.email_repo,
                # Sprint 15: 启用 outbox 时 handle_flag_changed/completed/ai_reviewed
                # 改写为 intent 模式，由 FanoutWorker 异步派发
                outbox_repo=self.outbox_repo,
                # Sprint 16 dual-backend: davmail mode 下 handle_create_draft 走
                # backend.append_draft (IMAP APPEND), applescript mode 仍走 sh GUI 注入
                backend=self.backend,
            )
            self._event_handlers = handlers

            self.redis_consumer.on("flag_changed", handlers.handle_flag_changed)
            self.redis_consumer.on("ai_reviewed", handlers.handle_ai_reviewed)
            self.redis_consumer.on("completed", handlers.handle_completed)
            self.redis_consumer.on("create_draft", handlers.handle_create_draft)
            self.redis_consumer.on("page_updated", handlers.handle_page_updated)
            self.redis_consumer.on("query_mail", handlers.handle_query_mail)
            self.redis_consumer.on("fetch_mail_content", handlers.handle_fetch_mail_content)
            # v4 Phase 3: FTS5 full-text search over email_body / subject / sender
            self.redis_consumer.on("search_email_bodies", handlers.handle_search_email_bodies)

            logger.info(f"Redis event consumer configured: queue={queue_key}")

        # 看板统计上报
        self.stats_reporter = None
        if config.stats_report_url:
            from src.stats_reporter import StatsReporter
            self.stats_reporter = StatsReporter(
                report_url=config.stats_report_url,
                database_id=config.email_database_id,
                token=config.stats_report_token,
                interval=config.stats_report_interval,
            )
            def _flat_watcher_stats():
                stats = self.watcher.get_stats()
                # Flatten sync_store into top level for dashboard
                ss = stats.pop("sync_store", {})
                stats.update(ss)
                # Flatten radar into top level
                radar = stats.pop("radar", {})
                stats.update({f"radar_{k}": v for k, v in radar.items()})
                return stats
            self.stats_reporter.add_collector("watcher", _flat_watcher_stats)
            self.stats_reporter.add_collector("reverse", lambda: self.reverse_sync.get_stats())
            if self.redis_consumer:
                self.stats_reporter.add_collector("redis_consumer", lambda: self.redis_consumer.get_stats())
            if self._event_handlers:
                self.stats_reporter.add_collector("handlers", lambda: self._event_handlers.get_stats())

            # 捕获 ERROR 级别日志作为告警
            def _alert_sink(message):
                record = message.record
                if record["level"].no >= 40:  # ERROR+
                    self.stats_reporter.add_alert(
                        level=record["level"].name.lower(),
                        source=record["name"],
                        message=str(record["message"]),
                    )
            logger.add(_alert_sink, level="ERROR", format="{message}")
            logger.info(f"Stats reporter configured: url={config.stats_report_url} interval={config.stats_report_interval}s")

            if self.alerter:
                self.stats_reporter.add_collector("alerts", lambda: self.alerter.get_stats())

        # roadmap §4.5.1 + §4.5.2 + §4.5.3 — DavMail backend 健康 watchdog
        # 仅 davmail mode 启动。failure / token expiry / EWS throttling 三类
        # 信号统一在这个 60s 循环里检测，状态落 sync_state['davmail.*']
        # 让 frontend / dashboard 直读，跃迁时调 alerter 发飞书。
        self.davmail_watchdog = None
        if self.backend.backend_origin == "davmail":
            from src.mail.davmail_watchdog import DavMailWatchdog
            self.davmail_watchdog = DavMailWatchdog(
                sync_store=self.watcher.sync_store,
                alerter=self.alerter,
                davmail_root=_REPO_ROOT / "davmail-poc",
                imap_host=config.davmail_imap_host,
                imap_port=config.davmail_imap_port,
                smtp_port=config.davmail_smtp_port,
            )
            if self.stats_reporter:
                self.stats_reporter.add_collector(
                    "davmail", self.davmail_watchdog.get_snapshot
                )
            logger.info(
                f"[davmail-watchdog] configured (imap={config.davmail_imap_host}:"
                f"{config.davmail_imap_port} smtp=:{config.davmail_smtp_port})"
            )

        # ping-island 灵动岛集成（Island-Sprint 2，默认关）
        self.island_enabled = bool(config.ping_island_enabled)
        if self.island_enabled:
            from src.notify import island_dispatch  # 触发 import
            # 同步环境变量（dispatcher / reconnect / 模块都从 env 读）
            os.environ.setdefault("ISLAND_SOCKET_PATH", config.island_socket_path)
            os.environ.setdefault("ISLAND_SOCKET_TIMEOUT", str(config.island_socket_timeout))
            os.environ.setdefault("PING_ISLAND_LANG", config.ping_island_lang)
            os.environ.setdefault("PING_ISLAND_RECONNECT_PROBE_INTERVAL",
                                  str(config.ping_island_reconnect_probe_interval))
            os.environ.setdefault("PING_ISLAND_QUEUE_MAX", str(config.ping_island_queue_max))
            # 首次启用 bootstrap manifest + locale 资源（idempotent）
            try:
                from src.notify.island_bootstrap import ensure_plugin_assets
                ensure_plugin_assets()
            except Exception as e:
                logger.warning(f"[island] plugin bootstrap failed (non-fatal): {e}")
            island_dispatch.init(
                enabled=True,
                sync_store=self.watcher.sync_store,
                account_name=config.mail_account_name,
                accent=config.island_accent,
                theme=config.island_theme,
            )
            logger.info(
                f"[island] enabled (socket={config.island_socket_path} "
                f"timeout={config.island_socket_timeout}s "
                f"lang={config.ping_island_lang} "
                f"accent={config.island_accent}/{config.island_theme})"
            )
        else:
            # 也调一次 init() 保证 dispatcher 状态干净；is_enabled() 返回 False
            from src.notify import island_dispatch
            island_dispatch.init(enabled=False, sync_store=self.watcher.sync_store)

        # 防锁屏保活
        self.keep_alive = None
        if config.keep_alive_enabled:
            # 添加 scripts/ 到 path 以便导入 (仓库根 scripts/, 用 _REPO_ROOT 还原原 main.py 行为)
            import sys as _sys
            scripts_dir = os.path.join(str(_REPO_ROOT), "scripts")
            if scripts_dir not in _sys.path:
                _sys.path.insert(0, scripts_dir)
            from keep_alive import KeepAliveDaemon
            self.keep_alive = KeepAliveDaemon(dim=config.keep_alive_dim)
            logger.info(f"Keep-alive configured: dim={config.keep_alive_dim}")

        self._shutdown_event = asyncio.Event()

    def _handle_signal(self, signum, frame):
        """处理系统信号"""
        sig_name = signal.Signals(signum).name
        logger.info(f"Received signal {sig_name}, initiating graceful shutdown...")
        self._shutdown_event.set()

    def _handle_toggle_keep_alive(self, signum, frame):
        """SIGUSR1: 切换保活状态"""
        if self.keep_alive:
            self.keep_alive.toggle()
            logger.info(f"Keep-alive toggled: forced={self.keep_alive.forced}")

    async def start(self):
        """启动应用"""
        logger.info("=" * 60)
        logger.info("Email to Notion Sync Service")
        logger.info("=" * 60)
        logger.info(f"User: {config.user_email}")
        logger.info(f"Poll interval: {config.radar_poll_interval}s")
        logger.info(f"Log level: {config.log_level}")
        logger.info("=" * 60)

        # 注册信号处理器
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)
        if self.keep_alive:
            signal.signal(signal.SIGUSR1, self._handle_toggle_keep_alive)

        try:
            # 启动防锁屏保活
            if self.keep_alive:
                self.keep_alive.start()
                logger.info("Keep-alive daemon started (SIGUSR1 to toggle)")

            # 发送启动告警
            if self.alerter:
                mailboxes = [mb.strip() for mb in config.sync_mailboxes.split(',') if mb.strip()]
                await self.alerter.alert_service_started(mailboxes, config.radar_poll_interval)

            # 启动邮件监听器（在后台任务中运行）
            watcher_task = asyncio.create_task(self.watcher.start())

            # 启动反向同步循环
            reverse_task = asyncio.create_task(self._reverse_sync_loop())

            # 启动 Redis 事件消费（如果配置）
            redis_task = None
            if self.redis_consumer:
                redis_task = asyncio.create_task(
                    self.redis_consumer.start(shutdown_event=self._shutdown_event)
                )

            # 启动看板统计上报（如果配置）
            stats_task = None
            if self.stats_reporter:
                stats_task = asyncio.create_task(self._stats_reporter_loop())

            # 启动告警检查循环（如果配置）
            alert_task = None
            if self.alerter:
                alert_task = asyncio.create_task(self._alert_check_loop())

            # 启动周期会议滚动展开循环
            expansion_task = asyncio.create_task(self._meeting_expansion_loop())

            # Phase C.1 — davmail mode 下 fire-and-forget backfill task, 把 applescript
            # 时代抓的存量邮件 imap_uid 副字段补齐 (DavMailBackend.fetch_email_by_id
            # 快路径准备). 延迟 10s 避免跟其他启动 task 抢资源.
            uid_backfill_task = None
            if self.backend.backend_origin == "davmail":
                from src.mail.backend.davmail_uid_mapper import schedule_backfill_task
                uid_backfill_task = asyncio.create_task(
                    schedule_backfill_task(config, self.watcher.sync_store, delay_sec=10)
                )

            # roadmap §4.5.1-3 — davmail health watchdog (仅 davmail mode)
            davmail_watchdog_task = None
            if self.davmail_watchdog:
                davmail_watchdog_task = asyncio.create_task(
                    self.davmail_watchdog.run()
                )

            # Sprint 15: 启动 outbox FanoutWorker（如果配置开启）
            fanout_task = None
            if self.fanout_worker:
                fanout_task = asyncio.create_task(self.fanout_worker.run())

            # C1: 启动 async_jobs JobWorker（长任务 batch resync / backfill 统一执行器）。
            # 默认关闭灰度 (MAILAGENT_ASYNC_JOBS_ENABLED)；关闭时 POST /api/jobs 仍可
            # enqueue 但无 worker 执行 (行保持 queued)。串行 claim + 复用 LongTaskContext。
            job_worker_task = None
            if config.mailagent_async_jobs_enabled:
                from src.sync import AsyncJobRepository, JobWorker
                self.job_worker = JobWorker(
                    repo=AsyncJobRepository(config.sync_store_db_path),
                    config=config,
                    poll_interval_sec=config.mailagent_async_jobs_poll_interval_sec,
                )
                job_worker_task = asyncio.create_task(self.job_worker.run())
                logger.info(
                    f"[job-worker] enabled "
                    f"(poll={config.mailagent_async_jobs_poll_interval_sec}s)"
                )
            else:
                logger.info(
                    "[job-worker] disabled (MAILAGENT_ASYNC_JOBS_ENABLED=false)"
                )

            # Phase 1 Calendar SSoT: 启动 CalendarSyncWorker (DavMail CalDAV → SQLite
            # calendar_event 表的增量 sync). 默认关闭, 灰度期手动启用. 详见 plan §1.4 +
            # frontend-view-silly-knuth.md.
            calendar_sync_task = None
            if config.calendar_caldav_sync_enabled:
                try:
                    from src.calendar_sync.caldav_reader import CalDAVReader
                    from src.calendar_sync import (
                        CalendarEventRepository,
                        CalendarSyncWorker,
                    )

                    self.calendar_sync_worker = CalendarSyncWorker(
                        cfg=config,
                        reader=CalDAVReader(config),
                        repo=CalendarEventRepository(config.sync_store_db_path),
                        poll_interval=float(
                            config.calendar_caldav_sync_poll_interval_sec
                        ),
                        full_sync_past_days=config.calendar_caldav_sync_window_past_days,
                        full_sync_window_days=config.calendar_caldav_sync_window_future_days,
                    )
                    calendar_sync_task = asyncio.create_task(
                        self.calendar_sync_worker.run()
                    )
                    logger.info(
                        f"[calendar-sync] worker started "
                        f"(poll={config.calendar_caldav_sync_poll_interval_sec}s, "
                        f"window=[-{config.calendar_caldav_sync_window_past_days}d, "
                        f"+{config.calendar_caldav_sync_window_future_days}d])"
                    )
                except Exception as e:
                    logger.error(
                        f"[calendar-sync] failed to start (main loop continues): {e}"
                    )
                    self.calendar_sync_worker = None
            else:
                self.calendar_sync_worker = None
                logger.info(
                    "[calendar-sync] disabled (CALENDAR_CALDAV_SYNC_ENABLED=false)"
                )

            # Sprint 16: 启动本地 SSE server (mail-sync 进程内)
            # 前端 Electron main 直连 127.0.0.1:9200, 0 RTT;
            # 失败 silent (主链路不受影响, 前端自动 fallback 轮询).
            self._sse_runner = None
            if config.mailagent_sse_enabled:
                try:
                    from src.sse_server import start_sse_server
                    self._sse_runner = await start_sse_server(
                        host=config.sse_local_host,
                        port=config.sse_local_port,
                    )
                except Exception as e:
                    logger.warning(
                        f"[sse] failed to start (frontend will fallback to polling): {e}"
                    )
                    self._sse_runner = None

            # 启动 ping-island 重连 / snooze 后台任务（开启时才跑）
            island_reconnect_task = None
            island_snooze_task = None
            daily_digest_task = None
            if self.island_enabled:
                from src.notify import island_reconnect, island_snooze
                island_reconnect_task = asyncio.create_task(
                    island_reconnect.reconnect_loop(shutdown_event=self._shutdown_event)
                )
                island_snooze_task = asyncio.create_task(
                    island_snooze.tick_loop(shutdown_event=self._shutdown_event)
                )
                # Phase 3 DailyDigest 每日巡检（island 开 + digest 开 才跑）
                if config.mailagent_daily_digest_enabled:
                    from src.notify import daily_digest
                    daily_digest_task = asyncio.create_task(
                        daily_digest.tick_loop(
                            sync_store=self.watcher.sync_store,
                            run_once=self._run_daily_digest_once,
                            shutdown_event=self._shutdown_event,
                        )
                    )
                    logger.info(
                        f"[daily-digest] enabled "
                        f"(hours={config.mailagent_daily_digest_hours} "
                        f"window={config.mailagent_daily_digest_window_hours}h)"
                    )

            # 报告 Agent worker（独立于 island，自己的 gate；日/周/月报定时生成）。
            # 启动条件 = 总开关 flag 开 OR report_agent 表里存在 enabled 的 report
            # agent。后者让「前端启用某个报告 agent」即可自动定时生成，无需用户去翻
            # MAILAGENT_REPORT_AGENT_ENABLED env（打包 app 用户尤其碰不到 env）。
            # 表为空 / 无 enabled / 旧库无表 → list_agents 抛 → 回退 flag-only。
            report_worker_task = None
            report_db_path = str(self.watcher.sync_store.db_path)
            from src.reports.store import ReportStore
            report_store = ReportStore(db_path=report_db_path)
            try:
                has_enabled_report_agent = any(
                    a.get("enabled") and (a.get("type") or "report") == "report"
                    for a in report_store.list_agents()
                )
            except Exception as e:  # noqa: BLE001
                logger.debug(f"[report] list_agents probe failed: {e}")
                has_enabled_report_agent = False
            if config.mailagent_report_agent_enabled or has_enabled_report_agent:
                from src.reports import worker as report_worker
                report_worker_task = asyncio.create_task(
                    report_worker.tick_loop(
                        sync_store=self.watcher.sync_store,
                        store=report_store,
                        db_path=report_db_path,
                        shutdown_event=self._shutdown_event,
                    )
                )
                logger.info(
                    f"[report] worker enabled "
                    f"(flag={config.mailagent_report_agent_enabled} "
                    f"enabled_agent={has_enabled_report_agent})"
                )

            # 等待关闭信号
            await self._shutdown_event.wait()

            # 停止组件
            logger.info("Stopping services...")
            if self.keep_alive:
                self.keep_alive.stop()
            await self.watcher.stop()
            if self.redis_consumer:
                await self.redis_consumer.stop()
            if self.fanout_worker:
                self.fanout_worker.stop()
                logger.info(f"[outbox] fanout_worker.stats={self.fanout_worker.stats}")
            if self.job_worker:
                self.job_worker.stop()
                logger.info(f"[job-worker] job_worker.stats={self.job_worker.stats}")

            # 发送停止告警
            if self.alerter:
                await self.alerter.alert_service_stopped("收到关闭信号")

            # 取消任务
            tasks = [watcher_task, reverse_task, expansion_task]
            if uid_backfill_task:
                tasks.append(uid_backfill_task)
            if redis_task:
                tasks.append(redis_task)
            if stats_task:
                tasks.append(stats_task)
            if alert_task:
                tasks.append(alert_task)
            if island_reconnect_task:
                tasks.append(island_reconnect_task)
            if island_snooze_task:
                tasks.append(island_snooze_task)
            if daily_digest_task:
                tasks.append(daily_digest_task)
            if report_worker_task:
                tasks.append(report_worker_task)
            if fanout_task:
                tasks.append(fanout_task)
            if job_worker_task:
                tasks.append(job_worker_task)
            if davmail_watchdog_task:
                tasks.append(davmail_watchdog_task)
            if calendar_sync_task:
                # Phase 1 Calendar SSoT — graceful stop 让 worker 跑完当前 tick 再退
                if self.calendar_sync_worker:
                    self.calendar_sync_worker.stop()
                tasks.append(calendar_sync_task)
            for task in tasks:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            # Sprint 16: 关闭 SSE server (cleanup runner + 等待 in-flight client 断开)
            if self._sse_runner is not None:
                try:
                    await self._sse_runner.cleanup()
                    logger.info("[sse] server shut down")
                except Exception as e:
                    logger.warning(f"[sse] cleanup failed: {e}")

            # 关闭反向同步资源
            await self.reverse_sync.close()

            # 打印最终统计
            stats = self.watcher.get_stats()
            rs_stats = self.reverse_sync.get_stats()
            logger.info(f"Final stats: synced={stats.get('emails_synced', 0)}, flags={stats.get('flag_changes_synced', 0)}, errors={stats.get('errors', 0)}")
            logger.info(f"Reverse sync: synced={rs_stats.get('total_synced', 0)}, notified={rs_stats.get('total_notified', 0)}")
            if self.redis_consumer:
                rc_stats = self.redis_consumer.get_stats()
                logger.info(f"Redis consumer: received={rc_stats.get('received', 0)}, processed={rc_stats.get('processed', 0)}")
            if self.stats_reporter:
                await self.stats_reporter.report_once()
                await self.stats_reporter.close()
            if self.alerter:
                await self.alerter.close()
            logger.info("Shutdown complete")

        except Exception as e:
            logger.error(f"Fatal error: {e}")
            sys.exit(1)

    async def _reverse_sync_loop(self):
        """反向同步循环: 定期检查 Notion AI Review 结果并同步到 Mail.app"""
        interval = config.reverse_sync_interval
        logger.info(f"Reverse sync loop started (interval={interval}s)")

        while not self._shutdown_event.is_set():
            try:
                await self.reverse_sync.check_and_sync()
            except Exception as e:
                logger.error(f"Reverse sync error: {e}")

            try:
                await asyncio.wait_for(self._shutdown_event.wait(), timeout=interval)
                break  # shutdown event set
            except asyncio.TimeoutError:
                pass  # normal timeout, continue loop

    async def _meeting_expansion_loop(self):
        """周期会议滚动展开循环：每天 tick 一次，把 horizon 内的 occurrences 写齐."""
        interval = config.meeting_expansion_interval_seconds
        horizon = config.meeting_expansion_horizon_weeks
        logger.info(
            f"Meeting expansion loop started (interval={interval}s, horizon={horizon}w)"
        )

        # last-run gate：避免 PM2 频繁重启时连续触发
        last_run_str = self.watcher.sync_store.get_state("last_meeting_expansion_at")
        if last_run_str:
            try:
                last_run = datetime.fromisoformat(last_run_str)
                if last_run.tzinfo is None:
                    last_run = last_run.replace(tzinfo=timezone.utc)
                elapsed = (datetime.now(timezone.utc) - last_run).total_seconds()
                if elapsed < interval:
                    wait = interval - elapsed
                    logger.info(
                        f"Meeting expansion: last run {elapsed:.0f}s ago, sleeping {wait:.0f}s"
                    )
                    try:
                        await asyncio.wait_for(
                            self._shutdown_event.wait(), timeout=wait
                        )
                        return
                    except asyncio.TimeoutError:
                        pass
            except (ValueError, TypeError) as e:
                logger.debug(f"Invalid last_meeting_expansion_at, ignoring: {e}")

        while not self._shutdown_event.is_set():
            try:
                await self._run_expansion_tick(horizon)
                self.watcher.sync_store.set_state(
                    "last_meeting_expansion_at",
                    datetime.now(timezone.utc).isoformat(),
                )
            except Exception as e:
                logger.error(f"[expansion] tick failed: {e}")

            try:
                await asyncio.wait_for(self._shutdown_event.wait(), timeout=interval)
                break
            except asyncio.TimeoutError:
                pass

    async def _run_expansion_tick(self, horizon_weeks: int):
        """单次 expansion tick：扫 recurring_series，对低水位的系列补展 horizon 内的 occurrences."""
        from src.calendar_notion.expansion import run_expansion_tick

        return await run_expansion_tick(
            self.watcher.sync_store,
            self.watcher.meeting_sync,
            horizon_weeks,
        )

    def _reconstruct_invite_from_series_row(self, row: dict):
        """从 recurring_series 行还原 minimal MeetingInvite（仅含 expander 必需字段）."""
        from src.calendar_notion.expansion import reconstruct_invite_from_series_row

        return reconstruct_invite_from_series_row(row)

    async def _run_daily_digest_once(self, slot: str):
        """Phase 3 DailyDigest 单次巡检（tick_loop 命中 fire window 时调）.

        注入 repo / sync_store / config cap → daily_digest.run_digest_once 编排
        取数 + LLM summary + dispatch。
        """
        from src.notify import daily_digest

        return await daily_digest.run_digest_once(
            sync_store=self.watcher.sync_store,
            repo=self.watcher.email_repo,
            slot=slot,
            max_emails=config.mailagent_daily_digest_max_emails,
            window_hours=config.mailagent_daily_digest_window_hours,
            max_bulk_ids=config.mailagent_daily_digest_max_bulk_ids,
        )

    async def _alert_check_loop(self):
        """告警检查循环：定期检测异常并发送告警"""
        interval = 60  # 每分钟检查一次
        logger.info("Alert check loop started (interval=60s)")

        # 跳过首次检查，等服务稳定
        try:
            await asyncio.wait_for(self._shutdown_event.wait(), timeout=30)
            return
        except asyncio.TimeoutError:
            pass

        while not self._shutdown_event.is_set():
            try:
                await self._check_and_alert()
            except Exception as e:
                logger.debug(f"Alert check error: {e}")

            try:
                await asyncio.wait_for(self._shutdown_event.wait(), timeout=interval)
                break
            except asyncio.TimeoutError:
                pass

    async def _check_and_alert(self):
        """执行一次告警检查"""
        if not self.alerter:
            return

        stats = self.watcher.get_stats()

        # 1. 连续错误检查
        consecutive = stats.get("consecutive_errors", 0)
        if consecutive >= 3:
            last_err = ""
            await self.alerter.alert_consecutive_errors(consecutive, last_err)

        # 2. 服务不健康
        if not stats.get("healthy", True):
            await self.alerter.alert_service_unhealthy(consecutive)

        # 3. dead_letter 累积
        sync_store_stats = stats.get("sync_store", {})
        dead_count = sync_store_stats.get("dead_letter", 0)
        if dead_count >= config.alert_dead_letter_threshold:
            await self.alerter.alert_dead_letters(dead_count, config.alert_dead_letter_threshold)
            # ping-island DeadLetterAccum hook（fail-open）
            try:
                from src.notify import island_dispatch
                if island_dispatch.is_enabled():
                    island_dispatch.dispatch_dead_letter_accum(
                        count=dead_count,
                        threshold=config.alert_dead_letter_threshold,
                    )
            except Exception as e:
                logger.debug(f"[island-hook] dead_letter dispatch failed: {e}")

        # 4. 雷达不可用
        radar_available = stats.get("radar", {}).get("available", True)
        if not radar_available:
            await self.alerter.alert_radar_unavailable()

        # 5. Redis 断连检查
        if self.redis_consumer:
            rc_stats = self.redis_consumer.get_stats()
            if rc_stats.get("connected") is False:
                await self.alerter.alert_redis_disconnected(
                    rc_stats.get("last_error", "unknown")
                )

        # 6. davmail fetch 突增 (Sprint 16 收尾): davmail mode 下检查最近 10min
        # 进入 fetch_failed 的邮件数, 超阈值 → 飞书告警 (alerter 内置 cooldown 防刷)
        if self.backend and self.backend.backend_origin == "davmail":
            try:
                import sqlite3 as _sql
                with _sql.connect(config.sync_store_db_path, timeout=5.0) as _conn:
                    row = _conn.execute(
                        "SELECT COUNT(*) FROM email_metadata "
                        "WHERE sync_status='fetch_failed' "
                        "  AND backend_origin='davmail' "
                        "  AND updated_at > strftime('%s','now') - 600"
                    ).fetchone()
                    recent_fail = (row[0] if row else 0)
                if recent_fail >= 3:
                    await self.alerter.send_alert(
                        level="error",
                        title=f"DavMail fetch 突增: 最近 10min {recent_fail} 封 fetch_failed",
                        message=(
                            f"backend=davmail 最近 10min 共 {recent_fail} 封邮件 "
                            f"fetch_email_by_id 失败 (含 IMAP timeout / SELECT 失败 / "
                            f"UIDVALIDITY mismatch). 看 pm2 logs mail-sync | "
                            f"grep davmail-backend 定位; uid-mapper 后台跑可能加剧 "
                            f"IMAP 并发, 必要时调大 DAVMAIL_FETCH_TIMEOUT_SEC."
                        ),
                        alert_key="davmail_fetch_burst",
                    )
            except Exception as e:
                logger.debug(f"[alert] davmail fetch burst check failed: {e}")

    async def _stats_reporter_loop(self):
        """看板统计上报循环"""
        interval = self.stats_reporter.interval
        logger.info(f"Stats reporter loop started (interval={interval}s)")

        while not self._shutdown_event.is_set():
            try:
                await self.stats_reporter.report_once()
            except Exception as e:
                logger.debug(f"Stats report error: {e}")

            try:
                await asyncio.wait_for(self._shutdown_event.wait(), timeout=interval)
                break
            except asyncio.TimeoutError:
                pass


async def run_service():
    """服务主入口 (等价于原 main.py 的 async def main() body, 零行为变更).

    仓库根 main.py 薄壳 与 `mailagent serve` 都调它, 保证两条路径完全一致。

    注: 原 main.py 在模块顶层 (load_dotenv 之后) 调 setup_logger; 迁入 src/ 后改在
    这里调, 避免「import src.service」(serve 命令 / 打包 import 探测) 有重配日志的
    副作用, 同时保证两条入口在 app 启动前都已配好日志 —— 运行时行为与原来一致。
    """
    setup_logger(config.log_level, config.log_file)
    app = EmailNotionSyncApp()
    await app.start()
