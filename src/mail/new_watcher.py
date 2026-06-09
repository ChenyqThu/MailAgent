"""
NewWatcher - v3 架构邮件同步监听器

基于 internal_id（SQLite ROWID = AppleScript id）的新架构：
- SQLite 雷达检测 max_row_id 变化并直接获取新邮件元数据
- 立即写入 SyncStore（internal_id 为主键，message_id 后续填充）
- AppleScript 通过 `whose id is <int>` 获取邮件内容（127x 性能提升）
- 使用 thread_id 关联 Parent Item

核心流程（v3）：
1. 雷达检测到新邮件 → SQLite 直接获取新邮件元数据（internal_id, subject, sender, date）
2. 立即写入 SyncStore（status=pending, message_id=NULL）
3. 处理 pending 邮件：AppleScript 通过 internal_id 获取完整内容
4. AppleScript 成功后更新 SyncStore（填充 message_id、thread_id）
5. 同步到 Notion
6. 更新状态（synced/failed）
7. 定期重试 fetch_failed 和 failed 状态的邮件

性能改进：
- `whose id is <int>` ~0.8s vs `whose message id is "<str>"` ~101s（127x 提升）
- 即使 AppleScript 失败也能追踪（有 internal_id）

Usage:
    watcher = NewWatcher()
    await watcher.start()
"""

import asyncio
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional, Any
from loguru import logger

from src.config import config as settings
from src.models import Email
from src.mail.sqlite_radar import SQLiteRadar
from src.mail.applescript_arm import AppleScriptArm
from src.mail.sync_store import SyncStore
from src.notion.sync import NotionSync
from src.mail.reader import EmailReader
from src.mail.meeting_sync import MeetingInviteSync
from src.repository import (
    AttachmentStore,
    EmailRepository,
    build_storage_payloads,
)
from src.mail.backend.imap_client import parse_folder_csv_or_json

# 标准邮箱 (非自定义文件夹) —— L2/L3 gate 不影响这些; 自定义文件夹 = mailbox 不在此集合。
# 注: "存档" **有意**不在此列 —— PRD §7 D7「存档/草稿箱并入白名单走主链路」, 存档作为可同步
# 自定义文件夹, 享受 L3 默认静默 (归档邮件不该刷飞书, 这正是想要的)。
_STANDARD_MAILBOXES = frozenset({"收件箱", "发件箱", "已发送", "已发送邮件", "草稿", "草稿箱"})


def is_custom_folder_mailbox(mailbox: str) -> bool:
    """mailbox 是自定义文件夹 (多文件夹同步接入的, 非收件箱/发件箱/草稿)。"""
    return bool(mailbox) and mailbox not in _STANDARD_MAILBOXES


def should_skip_feishu_for_folder(mailbox: str, notify_enabled: frozenset) -> bool:
    """L3 通知降噪: 自定义文件夹**默认不通知**, 仅 notify_enabled 内的才通知。

    标准邮箱 (收件箱等) 不受影响 (返回 False = 不 skip)。
    """
    if not is_custom_folder_mailbox(mailbox):
        return False
    return mailbox not in notify_enabled


def should_skip_llm_for_folder(mailbox: str, llm_disabled: frozenset) -> bool:
    """L2 LLM gate: 自定义文件夹**默认跑 LLM**, 仅 llm_disabled 内的才跳过。

    标准邮箱不受影响 (返回 False = 不 skip)。
    """
    if not is_custom_folder_mailbox(mailbox):
        return False
    return mailbox in llm_disabled


def _parse_sync_start_date() -> Optional[datetime]:
    """解析同步起始日期配置

    用于缓存预热后的场景：历史邮件在 SyncStore 中（用于 Parent Item 查找），
    但只同步 SYNC_START_DATE 之后的邮件到 Notion。

    如果未配置或配置为空，则不过滤日期（正常启动后只同步新邮件）。

    Returns:
        同步起始日期（带时区），早于此日期的邮件不同步到 Notion
    """
    if not settings.sync_start_date:
        return None

    tz = timezone(timedelta(hours=8))  # 北京时区

    try:
        dt = datetime.strptime(settings.sync_start_date, "%Y-%m-%d")
        return dt.replace(tzinfo=tz)
    except ValueError:
        logger.warning(f"Invalid SYNC_START_DATE format: {settings.sync_start_date}, expected YYYY-MM-DD")
        return None


class NewWatcher:
    """新架构邮件同步监听器"""

    def __init__(
        self,
        mailboxes: List[str] = None,
        poll_interval: int = 5,
        sync_store_path: str = "data/sync_store.db",
        backend=None,
    ):
        """初始化监听器

        Args:
            mailboxes: 要监听的邮箱列表，默认 ["收件箱", "发件箱"]
            poll_interval: 轮询间隔（秒），默认 5
            sync_store_path: SyncStore 数据库路径
            backend: 可选 IMailBackend 实例 (Sprint 16 dual-backend).
                传入时 self.arm / self.radar 复用 backend 内部 wrapping;
                None 默认 → 自己构造 arm/radar 走老路径 (向后兼容).

        Raises:
            RuntimeError: 如果关键组件初始化失败
        """
        self.mailboxes = mailboxes or ["收件箱", "发件箱"]
        self.poll_interval = poll_interval
        self.backend = backend  # Sprint 16 dual-backend: 可选注入 IMailBackend

        # 解析同步起始日期
        self.sync_start_date = _parse_sync_start_date()
        if self.sync_start_date:
            logger.info(f"Sync start date: {self.sync_start_date.strftime('%Y-%m-%d')} (emails before this date will be cached but not synced to Notion)")

        # 初始化 SQLiteRadar + AppleScriptArm
        # Sprint 16 dual-backend: 如果 backend 传入 → self.arm/radar 直接从 backend 拿
        #   - AppleScriptBackend: self.arm = 真 AppleScriptArm, self.radar = 真 SQLiteRadar
        #   - DavMailBackend: self.arm = self, self.radar = self (alias 兼容层, 转发到
        #     IMAP STORE/FETCH/SEARCH); davmail mode 下 NewWatcher._poll_cycle 调
        #     self.radar.get_new_emails → DavMailBackend.get_new_emails (IMAP UID SEARCH).
        # backend=None (默认, 老调用方兼容) → 自己构造 arm/radar 跟现状一致.
        if backend is not None and hasattr(backend, 'radar') and hasattr(backend, 'arm'):
            self.radar = backend.radar
            self.arm = backend.arm
            logger.info(f"[dual-backend] NewWatcher 使用 backend={type(backend).__name__} (arm/radar 来自 backend)")
        else:
            try:
                self.radar = SQLiteRadar(mailboxes=self.mailboxes, account_url_prefix=settings.mail_account_url_prefix)
                if not self.radar.is_available():
                    logger.warning("SQLite radar not available, will rely on AppleScript only")
            except Exception as e:
                logger.error(f"Failed to initialize SQLite radar: {e}")
                self.radar = None

            self.arm = AppleScriptArm(
                account_name=settings.mail_account_name,
                inbox_name=settings.mail_inbox_name
            )

        try:
            self.sync_store = SyncStore(sync_store_path)
        except Exception as e:
            logger.error(f"Failed to initialize SyncStore: {e}")
            raise RuntimeError(f"SyncStore initialization failed: {e}")

        # v4: SQLite SSoT 仓库（strict DI 需要在 NotionSync 之前初始化）
        # 详见 docs/architecture_v4_sqlite_ssot.md
        try:
            self.email_repo = EmailRepository(
                db_path=sync_store_path,
                attachment_store=AttachmentStore(
                    getattr(settings, "attachment_storage_dir", "data/attachments")
                ),
            )
            if getattr(settings, "body_dual_write_enabled", True):
                logger.info("[v4] email body dual-write enabled (SQLite SSoT)")
            else:
                logger.info("[v4] EmailRepository ready (dual-write disabled, read-only for NotionSync DI)")
        except Exception as e:
            logger.error(f"[v4] failed to init EmailRepository: {e}")
            raise RuntimeError(f"EmailRepository init failed (required for NotionSync DI): {e}")

        self.notion_sync = NotionSync(
            email_repo=self.email_repo,
            sync_store=self.sync_store,
        )
        self.email_reader = EmailReader()
        # 会议邀请同步器：注入 sync_store 以使用 recurring_series 表
        self.meeting_sync = MeetingInviteSync(sync_store=self.sync_store)

        # 项目周报外挂钩子（需同时打开 PROJECT_PROGRESS_SYNC_ENABLED 总开关 +
        # PROJECT_PROGRESS_AUTO_SYNC_ENABLED 子开关，且配置了项目进度库 ID）
        self._progress_detector = None
        if (
            getattr(settings, "project_progress_sync_enabled", False)
            and getattr(settings, "project_progress_auto_sync_enabled", False)
            and getattr(settings, "project_progress_database_id", "")
        ):
            try:
                from src.project_progress.detector import ProjectProgressDetector
                self._progress_detector = ProjectProgressDetector(
                    sender=settings.project_progress_sender,
                    subject_pattern=settings.project_progress_subject_pattern,
                )
                logger.info(
                    f"Project Progress auto-sync enabled (db={settings.project_progress_database_id})"
                )
            except Exception as e:
                logger.warning(f"Failed to enable project-progress detector: {e}")
                self._progress_detector = None

        # 多文件夹同步 L2/L3 per-folder gate（按 mailbox 显示名匹配，PRD §2.3）。
        # 自定义文件夹默认: L2 LLM 开 / L3 通知关。空配置 = 默认行为。
        self._folder_notify_enabled = frozenset(
            parse_folder_csv_or_json(getattr(settings, "folder_notify_enabled", "") or "")
        )
        self._folder_llm_disabled = frozenset(
            parse_folder_csv_or_json(getattr(settings, "folder_llm_disabled", "") or "")
        )

        # LLM Agent 钩子（需 LLM_AGENT_ENABLED=true 且配置了 API key）
        # ⚠️ 启用前先到 Notion automation 暂停 Email Agent，避免双跑撞车
        self._llm_runner = None
        if (
            getattr(settings, "llm_agent_enabled", False)
            and getattr(settings, "llm_api_key", "")
        ):
            try:
                from src.llm_agent.runner import LLMRunner
                # v4: 把 EmailRepository 注入给 runner → processor，
                # 让 LLM hook 直读 SQLite markdown body，免去重新正则剥 HTML
                # Sprint 16: backend 注入让 davmail mode 下 LLM 走 IMAP fetch
                # (而非 AppleScript whose-id 抓不到 internal_id >= 10^9)
                self._llm_runner = LLMRunner(
                    repo=self.email_repo,
                    backend=self.backend,
                )
                logger.info(
                    f"[llm-agent] enabled (model={settings.llm_model} base={settings.llm_api_base})"
                )
                # Sprint 17 — 启动时 reset 卡 pending > 5min 的 LLM row.
                # 场景: 上次 mail-sync 被 pm2 restart 直接 kill, LLM 调用中途
                # 死掉 row 留在 status='pending', retry queue 只看 'failed' 永远
                # 不会重试. 启动一次性扫一遍 → failed + next_retry_at=now, 让
                # _process_llm_retry_queue 接管.
                try:
                    reset_n = self._llm_runner._store.reset_stale_pending(
                        threshold_sec=300
                    )
                    if reset_n > 0:
                        logger.info(
                            f"[llm-agent] reset {reset_n} stale pending row(s) → failed (will retry)"
                        )
                except Exception as e:
                    logger.warning(f"[llm-agent] reset_stale_pending failed (non-fatal): {e}")
            except Exception as e:
                logger.warning(f"[llm-agent] init failed, disabling: {e}")
                self._llm_runner = None

        # 飞书通知器（本地 LLM review 路径直推重要邮件）
        # 背景: 本地 LLM Agent 取代 Notion Email Agent 后, Notion 端不再触发
        # ai_reviewed automation webhook → 旧的 webhook→Redis→handle_ai_reviewed→飞书
        # 回环断供. 这里在 LLM review 完成处直接补飞书通知 (见 _maybe_notify_feishu).
        # 飞书自带 page_id 去重(10min) + 3 天时效, 可与未来恢复的 webhook 路径共存.
        self._feishu = None
        if getattr(settings, "feishu_notify_enabled", False):
            try:
                from src.notify.feishu import FeishuNotifier
                self._feishu = FeishuNotifier(
                    app_id=settings.feishu_app_id,
                    app_secret=settings.feishu_app_secret,
                    chat_id=settings.feishu_chat_id,
                    webhook_url=settings.feishu_webhook_url,
                    secret=settings.feishu_webhook_secret,
                    database_id=settings.email_database_id,
                )
                mode = "app_api" if settings.feishu_app_id else "webhook"
                logger.info(f"[feishu] notifier enabled on LLM-review path (mode={mode})")
            except Exception as e:
                logger.warning(f"[feishu] init failed, disabling: {e}")
                self._feishu = None

        # 运行状态
        self._running = False
        self._healthy = True  # 服务健康状态
        self._stats = {
            "polls": 0,
            "new_emails_detected": 0,
            "emails_synced": 0,
            "emails_skipped": 0,  # 因日期过滤跳过的邮件
            "meeting_invites": 0,  # 检测到的会议邀请
            "retries_attempted": 0,
            "retries_succeeded": 0,
            "flag_changes_synced": 0,
            "errors": 0,
            "consecutive_errors": 0  # 连续错误计数
        }

        logger.info(f"NewWatcher initialized: mailboxes={self.mailboxes}, poll_interval={poll_interval}s")

    def _check_health(self) -> bool:
        """检查服务健康状态

        Returns:
            True 如果所有关键组件正常
        """
        # 检查 SyncStore
        try:
            self.sync_store.get_stats()
        except Exception as e:
            logger.error(f"SyncStore health check failed: {e}")
            return False

        # 检查 radar（可选组件）
        if self.radar and not self.radar.is_available():
            logger.warning("SQLite radar became unavailable")

        return True

    async def start(self):
        """启动监听器"""
        if self._running:
            logger.warning("Watcher is already running")
            return

        # 启动前健康检查
        if not self._check_health():
            raise RuntimeError("Service health check failed, cannot start")

        self._running = True
        self._healthy = True
        logger.info("NewWatcher started")

        # 初始化：从 SyncStore 恢复 last_max_row_id
        last_max_row_id = self.sync_store.get_last_max_row_id()
        if self.radar:
            if last_max_row_id > 0:
                self.radar.set_last_max_row_id(last_max_row_id)
                logger.info(f"Restored last_max_row_id from SyncStore: {last_max_row_id}")
            else:
                # 首次运行，获取当前 max_row_id 作为基线
                current_max = self.radar.get_current_max_row_id()
                self.radar.set_last_max_row_id(current_max)
                self.sync_store.set_last_max_row_id(current_max)
                logger.info(f"First run, set baseline max_row_id: {current_max}")

        # PR-4 US-008: 启动 v4_rollout flush loop (RFC §8 选项 A)
        # 每 60s 把 NotionSync 内存累计的路由命中 / miss / error 写一行到
        # v4_rollout_stats 表; admin stats 读最新行 + staleness.
        # 保存 task 引用避免 Python 3.11 asyncio 弱引用 GC (生产 3h 0 row 实证).
        self._rollout_flush_task = asyncio.create_task(
            self._flush_v4_rollout_stats_loop()
        )

        # 主循环
        while self._running:
            try:
                await self._poll_cycle()
                # 成功后重置连续错误计数
                self._stats["consecutive_errors"] = 0
            except Exception as e:
                logger.error(f"Poll cycle error: {e}")
                self._stats["errors"] += 1
                self._stats["consecutive_errors"] += 1

                # 连续错误过多时进行健康检查
                if self._stats["consecutive_errors"] >= 5:
                    logger.warning("Too many consecutive errors, performing health check...")
                    self._healthy = self._check_health()
                    if not self._healthy:
                        logger.error("Service unhealthy, stopping watcher")
                        self._running = False
                        break

            await asyncio.sleep(self.poll_interval)

    async def stop(self):
        """停止监听器"""
        self._running = False
        if self._feishu is not None:
            try:
                await self._feishu.close()
            except Exception as e:
                logger.debug(f"[feishu] close failed: {e}")
        logger.info("NewWatcher stopped")

    async def _flush_v4_rollout_stats_loop(
        self,
        *,
        interval_seconds: int = 60,
    ) -> None:
        """周期性 flush NotionSync 内存累计到 v4_rollout_stats 表 (PR-4 R-06).

        - 间隔 60s
        - flush 失败仅 warning, 不停 loop
        - watcher 停时 self._running=False, loop 自然退出
        """
        try:
            notion_sync = self.notion_sync  # type: ignore[attr-defined]
        except AttributeError:
            logger.debug(
                "[v4-rollout] no notion_sync on watcher; skipping flush loop"
            )
            return
        while self._running:
            try:
                await asyncio.sleep(interval_seconds)
                if not self._running:
                    break
                if hasattr(notion_sync, "flush_rollout_stats"):
                    notion_sync.flush_rollout_stats(
                        sync_store=self.sync_store,
                        window_seconds=interval_seconds,
                    )
            except asyncio.CancelledError:  # pragma: no cover
                break
            except Exception as exc:  # pragma: no cover
                logger.warning(
                    f"[v4-rollout] flush loop error: {type(exc).__name__}: {exc}"
                )

    async def _poll_cycle(self):
        """单次轮询周期（v3 架构）

        v3 流程：
        1. SQLite 雷达检测变化并直接获取新邮件元数据
        2. 立即写入 SyncStore（internal_id 为主键）
        3. 处理 pending 邮件（AppleScript 获取完整内容）
        4. 处理重试队列
        """
        self._stats["polls"] += 1

        # 1. 雷达检测新邮件并直接获取元数据
        if self.radar and self.radar.is_available():
            last_max_row_id = self.sync_store.get_last_max_row_id()
            has_new, current_max, estimated_count = self.radar.check_for_changes(last_max_row_id)

            if not has_new:
                logger.debug("No new emails detected")
            else:
                logger.info(f"Detected ~{estimated_count} new emails (row_id {last_max_row_id} -> {current_max})")
                self._stats["new_emails_detected"] += estimated_count

                # 2. SQLite 直接获取新邮件元数据（不通过 AppleScript）
                new_emails = self.radar.get_new_emails(last_max_row_id)

                if new_emails:
                    logger.info(f"SQLite found {len(new_emails)} new emails")

                    # 3. 立即写入 SyncStore（internal_id 为主键，message_id=NULL）
                    #
                    # Sprint 16 dual-backend (review CRITICAL #2):
                    # - AppleScript 路径: internal_id = Mail.app ROWID (radar 给的), message_id=None
                    #   (等下面 _process_pending_emails 抓 MIME 时填); 不传 imap_uid/imap_uidvalidity/
                    #   backend_origin → sync_store 默认 backend_origin='applescript', imap_uid=NULL.
                    # - DavMail 路径: backend.get_new_emails 已经分配独立 internal_id (>=10^9) +
                    #   填好 imap_uid/imap_uidvalidity/backend_origin='davmail' + 解析了 message_id
                    #   (IMAP UID FETCH 直接拿 header). 这里只需透传, 不要丢字段.
                    for email_meta in new_emails:
                        internal_id = email_meta['internal_id']

                        # 检查是否已存在
                        existing = self.sync_store.get(internal_id)
                        if existing:
                            logger.debug(f"Email {internal_id} already in SyncStore, skipping")
                            continue

                        backend_origin = email_meta.get('backend_origin')
                        payload = {
                            'internal_id': internal_id,
                            # davmail 已解析的 message_id 透传; AppleScript 路径仍 None (等 MIME 抓回)
                            'message_id': email_meta.get('message_id'),
                            'subject': email_meta.get('subject', ''),
                            'sender': (
                                email_meta.get('sender')
                                or email_meta.get('sender_email', '')
                            ),
                            'sender_name': email_meta.get('sender_name', ''),
                            'date_received': email_meta.get('date_received', ''),
                            'mailbox': email_meta.get('mailbox', '收件箱'),
                            'is_read': email_meta.get('is_read', False),
                            'is_flagged': email_meta.get('is_flagged', False),
                            'thread_id': email_meta.get('thread_id'),
                            'sync_status': 'pending',
                        }
                        # v13 davmail 字段透传 (AppleScript 路径不传, sync_store 默认 'applescript' + NULL)
                        if backend_origin:
                            payload['backend_origin'] = backend_origin
                        if email_meta.get('imap_uid') is not None:
                            payload['imap_uid'] = email_meta.get('imap_uid')
                        if email_meta.get('imap_uidvalidity') is not None:
                            payload['imap_uidvalidity'] = email_meta.get('imap_uidvalidity')

                        self.sync_store.save_email(payload)
                        logger.debug(
                            f"Added email {internal_id} to SyncStore "
                            f"(pending, origin={backend_origin or 'applescript'}, "
                            f"imap_uid={email_meta.get('imap_uid')})"
                        )

                # 4. 更新 last_max_row_id（立即持久化）
                self.sync_store.set_last_max_row_id(current_max)
                self.sync_store.set_last_sync_time(datetime.now().isoformat())
        else:
            logger.debug("Radar unavailable, skipping new email detection")

        # 5. 处理 pending 邮件（AppleScript 获取完整内容并同步到 Notion）
        await self._process_pending_emails()

        # 6. 处理重试队列（fetch_failed 和 failed 状态）
        await self._process_retry_queue()

        # 6b. 处理 LLM 失败重试队列（若启用本地 LLM）
        await self._process_llm_retry_queue()

        # 7. 检测 read/flagged 变化并同步到 Notion
        #
        # Sprint 15 SSoT inversion 下 sync_store 是状态真源, Mail.app 是 fanout 派发
        # 的镜像; 把 Mail.app 当 drift truth 反向覆盖 sync_store + Notion 会跟前端 /
        # CLI 的 intent race (前端写 sync_store=True, fanout 还未派发到 Mail.app 时
        # Mail.app 还是 False -> 本函数会把 sync_store 拉回 False 并把 Notion
        # processing_status 错误地设为 '已完成', 进而触发 handle_completed unflag,
        # 形成死循环). 已在 _detect_and_sync_flag_changes 函数体内 short-circuit;
        # 调用保留以便后续切换到"真 drift -> outbox(notion)"语义时复用。
        await self._detect_and_sync_flag_changes()

    async def _process_pending_emails(self):
        """处理 pending 状态的邮件（v3 架构）

        从 SyncStore 获取 pending 邮件，通过 AppleScript 获取完整内容并同步到 Notion。
        每次最多处理 10 封，避免阻塞。
        """
        pending_emails = self.sync_store.get_pending_emails(limit=10)

        if not pending_emails:
            return

        logger.info(f"Processing {len(pending_emails)} pending emails...")

        for email_meta in pending_emails:
            await self._sync_single_email_v3(email_meta)

    def _persist_email_metadata_after_parse(self, internal_id: int, email_obj) -> None:
        """把 reader 解析出的 MIME header 字段写回 SQLite metadata.

        SQLite radar 第一次写入只拿到 internal_id + subject + sender + date
        (AppleScript surface 属性);  to / cc / sender_name / Importance 这些
        头部字段必须等 reader.parse_email_source 解析完整 MIME 才有.  之前
        update_after_fetch 仅写 message_id / thread_id / subject / sender,
        导致 to_addr 与 cc_addr 在 SQLite 永远是空 (历史 6300+ 封全空,
        backfill 走 scripts/dev/backfill_to_cc.py 通过 Notion API 反拉).

        放在这里而不是每个调用点 inline 是因为正向 sync + 两条 retry 路径
        都要走一次, 防止再漏写.
        """
        patch: Dict[str, Any] = {}
        if email_obj.to:
            patch['to_addr'] = email_obj.to
        if email_obj.cc:
            patch['cc_addr'] = email_obj.cc
        if email_obj.sender_name:
            patch['sender_name'] = email_obj.sender_name
        if patch:
            try:
                self.sync_store.update_after_fetch(internal_id, patch)
            except Exception as exc:
                logger.warning(
                    "Failed to persist parsed metadata for %s: %s", internal_id, exc
                )

    async def _sync_single_email_v3(self, email_meta: Dict[str, Any]):
        """同步单封邮件（v3 架构）

        通过 internal_id 获取邮件完整内容，然后同步到 Notion。

        Args:
            email_meta: SyncStore 中的邮件元数据（包含 internal_id）
        """
        internal_id = email_meta.get('internal_id')
        mailbox = email_meta.get('mailbox', '收件箱')
        calendar_page_id = None

        try:
            logger.info(f"Syncing email {internal_id}: {email_meta.get('subject', '')[:50]}...")

            # 1. 通过 internal_id 获取完整邮件内容（127x 性能提升）
            full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
            if not full_email:
                backend_name = type(self.arm).__name__
                logger.warning(f"Failed to fetch email content by id {internal_id} (backend={backend_name})")
                self.sync_store.mark_fetch_failed(internal_id, f"fetch_email_content_by_id returned None (backend={backend_name})")
                return

            # 2. AppleScript 成功，更新 SyncStore 元数据（填充 message_id、thread_id）
            message_id = full_email.get('message_id')
            thread_id = full_email.get('thread_id')

            self.sync_store.update_after_fetch(internal_id, {
                'message_id': message_id,
                'thread_id': thread_id,
                'subject': full_email.get('subject'),
                'sender': full_email.get('sender')
            })

            # 3. 检测并处理会议邀请
            source = full_email.get('source', '')
            meeting_invite = None
            if self.meeting_sync.has_meeting_invite(source):
                calendar_page_id, meeting_invite = await self.meeting_sync.process_email(source, message_id)
                if calendar_page_id:
                    self._stats["meeting_invites"] += 1
                    logger.info(f"Meeting invite synced to calendar: {calendar_page_id}")

            # 4. 解析邮件源码，构建 Email 对象
            email_obj = await self._build_email_object(full_email, mailbox)
            if not email_obj:
                logger.error(f"Failed to build Email object: {internal_id}")
                self.sync_store.mark_failed_v3(internal_id, "Failed to build Email object")
                return

            # 设置 internal_id（v3 架构）
            email_obj.internal_id = internal_id

            # 把 reader 解析出的完整 MIME header 字段写回 SQLite metadata
            # (to/cc/sender_name). 之前漏写, 6000+ 封历史邮件 to_addr/cc_addr
            # 全空, 历史邮件 backfill 走 `mailagent backfill body` (顺手补
            # metadata) 或 `mailagent backfill metadata --source notion` (快).
            self._persist_email_metadata_after_parse(internal_id, email_obj)

            # v9 — 邮件原生重要性（Importance / X-Priority header）落 SQLite，
            # 给前端 ❗ 角标用。reader._parse_importance 在 parse 时已经填好。
            if email_obj.is_important:
                self.sync_store.update_after_fetch(
                    internal_id, {'is_important': True}
                )

            # 5. 日期过滤：早于 sync_start_date 的邮件不同步到 Notion
            if self.sync_start_date and email_obj.date:
                email_date = email_obj.date
                if email_date.tzinfo is None:
                    email_date = email_date.replace(tzinfo=timezone(timedelta(hours=8)))

                if email_date < self.sync_start_date:
                    logger.info(f"Skipping old email: {email_date.strftime('%Y-%m-%d')} < {self.sync_start_date.strftime('%Y-%m-%d')}")
                    self.sync_store.mark_skipped(internal_id)
                    self._stats["emails_skipped"] += 1
                    return

            # 5.5 v4: 双写邮件正文 + 附件到 SQLite（SSoT 切换的关键一步）
            # 详见 docs/architecture_v4_sqlite_ssot.md
            # 失败仅 warning，主流程继续走 Notion sync
            self._maybe_dual_write_body(email_obj, internal_id, full_email.get("source"))

            # 6. 同步到 Notion
            page_id = await self.notion_sync.create_email_page_v2(
                email_obj,
                calendar_page_id=calendar_page_id,
                meeting_invite=meeting_invite
            )

            if page_id:
                # 7. 更新 SyncStore (synced)
                self.sync_store.mark_synced_v3(internal_id, page_id)
                self._stats["emails_synced"] += 1
                logger.info(f"Email synced successfully: {internal_id} -> {page_id}")

                # 8. 项目周报外挂钩子（非阻塞、异常不影响主流程）
                self._maybe_trigger_project_progress_hook(email_obj, internal_id, page_id)

                # 9. 本地 LLM Agent 钩子（非阻塞、异常不影响主流程）
                self._maybe_trigger_llm_hook(email_obj, internal_id, page_id)

                # 10. KOS producer 钩子 (PR-2d, Sprint 19 M2)
                # — 非阻塞推 Jarvis KOS v2 让图谱跨域 entity 合并丰富
                self._maybe_trigger_kos_hook(email_obj, internal_id, page_id)

                # 11. ping-island MailReceived（非阻塞，默认关；启用前提见 .env.example）
                self._maybe_dispatch_island_received(email_obj, internal_id, page_id)
            else:
                self.sync_store.mark_failed_v3(internal_id, "Notion sync returned None")

        except Exception as e:
            logger.error(f"Failed to sync email {internal_id}: {e}")
            self.sync_store.mark_failed_v3(internal_id, str(e))
            self._stats["errors"] += 1

    def _maybe_dual_write_body(
        self,
        email_obj: Email,
        internal_id: int,
        raw_mime_source: Optional[str],
    ) -> None:
        """v4: 把邮件正文 + 附件双写到 SQLite（SSoT 切换）.

        - BODY_DUAL_WRITE_ENABLED=false 时直接返回
        - 任何失败仅 warning，不阻断 Notion sync 主流程
        - 详见 docs/architecture_v4_sqlite_ssot.md

        v4 子步骤:
            1. **预跑 Office 转换**：把 docx→pdf / xlsx→csv 产物追加到 email_obj.attachments
               这样 dual-write 时附件列表完整（含 derived 行），Notion sync 后续会 skip 重复转换
            2. build_storage_payloads → SQLite commit
        """
        if not getattr(settings, "body_dual_write_enabled", True):
            return
        try:
            # v4 step 1: 预跑 Office 转换（让 derived CSV/PDF 进 email_attachment 表）
            try:
                derived = self.notion_sync._convert_office_attachments(email_obj)
                if derived:
                    email_obj.attachments.extend(derived)
                    logger.debug(
                        f"[v4] pre-converted {len(derived)} Office derivatives for internal_id={internal_id}"
                    )
            except Exception as e:
                logger.warning(f"[v4] pre-conversion failed for internal_id={internal_id}: {e}")

            # v4 step 2: 构造 payload + 事务 commit
            body, attachments = build_storage_payloads(
                email_obj,
                internal_id,
                raw_mime_source=raw_mime_source,
                attachment_store=self.email_repo.attachment_store,
            )
            self.email_repo.commit_email_with_body(
                internal_id,
                body,
                attachments,
                message_id=email_obj.message_id,
            )
            logger.debug(
                f"[v4] body+attachments committed to SQLite: internal_id={internal_id}, "
                f"format={body.body_format}, attachments={len(attachments)}, "
                f"inline_images={body.has_inline_images}"
            )
        except Exception as e:
            logger.warning(
                f"[v4] dual-write to SQLite failed for internal_id={internal_id}: {e}"
            )

    def _maybe_trigger_project_progress_hook(
        self, email_obj: Email, internal_id: int, notion_page_id: str
    ) -> None:
        """若该邮件匹配项目周报规则，派发后台任务跑外挂同步。

        任何失败只打 warning，不影响主同步流程。
        """
        if self._progress_detector is None:
            return
        try:
            if not self._progress_detector.is_match(
                sender=email_obj.sender, subject=email_obj.subject
            ):
                return
            logger.info(
                f"[pp-hook] matched internal_id={internal_id} subject="
                f"{(email_obj.subject or '')[:60]!r}; dispatching background task"
            )
            from src.project_progress.runner import ProjectProgressRunner

            runner = ProjectProgressRunner()

            async def _bg():
                try:
                    summary = await runner.sync_from_email(
                        internal_id=internal_id,
                        notion_email_page_id=notion_page_id,
                        force=False,
                        dry_run=False,
                    )
                    logger.info(f"[pp-hook] done: {summary.as_log_line()}")
                except Exception as e:
                    logger.warning(f"[pp-hook] background task failed: {e}")

            asyncio.create_task(_bg())
        except Exception as e:
            logger.warning(f"[pp-hook] dispatch failed: {e}")

    def _maybe_trigger_llm_hook(
        self, email_obj: Email, internal_id: int, notion_page_id: str
    ) -> None:
        """若启用本地 LLM Agent，派发后台任务填充 Notion AI 字段。

        任何失败只打 warning，不影响主同步流程。
        失败 N 次后由 _process_llm_retry_queue 接手重试。
        """
        if self._llm_runner is None:
            return
        # L2 gate: 自定义文件夹默认跑 LLM, FOLDER_LLM_DISABLED 内的跳过 (省成本去噪)。
        # getattr 兜底: 最小 NewWatcher.__new__ 构造 (部分测试) 不走 __init__ 无此属性。
        mailbox = getattr(email_obj, "mailbox", "") or ""
        if should_skip_llm_for_folder(mailbox, getattr(self, "_folder_llm_disabled", frozenset())):
            logger.debug(
                f"[llm-hook] skip internal_id={internal_id} mailbox={mailbox!r} "
                f"(FOLDER_LLM_DISABLED)"
            )
            return
        try:
            subject_preview = (getattr(email_obj, "subject", "") or "")[:60]
            logger.debug(
                f"[llm-hook] dispatching internal_id={internal_id} subject={subject_preview!r}"
            )

            async def _bg():
                try:
                    result = await self._llm_runner.run_for_internal_id(
                        internal_id,
                        dry_run=False,
                        force=False,
                        overwrite=True,
                    )
                    # skipped='already_success' 说明此邮件 LLM 早已处理 + 已通知,
                    # labels 为空 → 不重发灵动岛通知 (问题 A 去重根因 2)。
                    if result.get("ok") and not result.get("skipped"):
                        labels = result.get("labels") or {}
                        logger.info(
                            f"[llm-hook] ok internal_id={internal_id} "
                            f"priority={labels.get('priority')} "
                            f"action_type={labels.get('action_type')} "
                            f"tokens={labels.get('tokens')}"
                        )
                        # ping-island LLMReviewed[Urgent] hook（默认关）
                        self._maybe_dispatch_island_reviewed(
                            email_obj, internal_id, notion_page_id, labels,
                        )
                        # 本地 LLM review 路径补飞书通知（取代停用的 Notion webhook 回环）
                        await self._maybe_notify_feishu(
                            email_obj, internal_id, notion_page_id, labels,
                        )
                    else:
                        logger.warning(
                            f"[llm-hook] failed internal_id={internal_id} "
                            f"error={result.get('error')} retry={result.get('retry_count')}"
                        )
                except Exception as e:
                    logger.warning(f"[llm-hook] background task failed: {e}")

            asyncio.create_task(_bg())
        except Exception as e:
            logger.warning(f"[llm-hook] dispatch failed: {e}")

    def _maybe_trigger_kos_hook(
        self, email_obj: Email, internal_id: int, notion_page_id: str
    ) -> None:
        """KOS Producer (PR-2d, Sprint 19 M2) — 异步推邮件入 Jarvis KOS v2.

        从 SQLite 读 LLM 已 classify 的 ai_priority 做 priority floor 过滤;
        body markdown 从 EmailRepository.get_body_markdown (v4 SSoT) 取;
        调 src.kos.producer.push_email_to_kos fire-and-forget.

        任何失败 (KOS 不可达 / KOSError / unexpected) 仅 warning 不阻塞主流程
        (KOS 是图谱丰富, 不丢功能性数据 — Mail.app + Notion 仍 SSoT).
        默认 MAILAGENT_KOS_INGEST_ENABLED=false 整段 noop.
        """
        if not getattr(settings, "mailagent_kos_ingest_enabled", False):
            return
        try:
            from src.kos.producer import push_email_to_kos

            # 完整 AI labels (llm_processing.labels_json) + body + 附件 — 增量入图
            # 跟 bulk historical ingest 形态一致 (category/ai_summary/key_points 都带)
            priority_floor = getattr(settings, "kos_ingest_priority_floor", "normal")
            dry_run = getattr(settings, "kos_ingest_dry_run", False)
            labels: Optional[dict] = None
            body_markdown: Optional[str] = None
            attachments: Optional[list] = None
            try:
                from src.llm_agent.store import LLMProcessingStore

                labels = LLMProcessingStore().get_labels(internal_id)
                body_markdown = self.email_repo.get_body_markdown(
                    internal_id, max_chars=200_000
                )
                attachments = [
                    {"filename": a.filename, "size": a.size_bytes,
                     "content_type": a.content_type}
                    for a in self.email_repo.get_attachments(internal_id)
                    if not a.is_inline
                ]
            except Exception as e:
                logger.debug(
                    f"[kos-hook] labels/body/attachments fetch failed "
                    f"internal_id={internal_id}: {e}"
                )

            subject_preview = (getattr(email_obj, "subject", "") or "")[:60]
            logger.debug(
                f"[kos-hook] dispatching internal_id={internal_id} "
                f"priority={(labels or {}).get('priority')!r} floor={priority_floor!r} "
                f"subject={subject_preview!r}"
            )

            async def _bg():
                try:
                    result = await push_email_to_kos(
                        email_obj,
                        internal_id,
                        body_markdown=body_markdown,
                        notion_page_id=notion_page_id,
                        labels=labels,
                        attachments=attachments,
                        priority_floor=priority_floor,
                        dry_run=dry_run,
                    )
                    if result is None:
                        logger.debug(
                            f"[kos-hook] skipped internal_id={internal_id} "
                            "(priority floor / not configured)"
                        )
                except Exception as e:
                    logger.warning(
                        f"[kos-hook] background task failed internal_id={internal_id}: {e}"
                    )

            asyncio.create_task(_bg())
        except Exception as e:
            logger.warning(
                f"[kos-hook] dispatch failed internal_id={internal_id}: {e}"
            )

    def _maybe_dispatch_island_received(
        self, email_obj: Email, internal_id: int, notion_page_id: str
    ) -> None:
        """ping-island ``MailReceived`` 派发（默认关，fail-open）.

        在 ``_sync_single_email_v3`` Notion sync 成功后调；envelope 构造与发送都是 fire-and-forget，
        异常不影响主同步流程。详见 frontend/ISLAND-PLUGIN.md §4.3。
        """
        try:
            from src.notify import island_dispatch
            if not island_dispatch.is_enabled():
                return
            island_dispatch.dispatch_mail_received(
                internal_id=internal_id,
                page_id=notion_page_id or "",
                subject=getattr(email_obj, "subject", "") or "",
                sender_email=getattr(email_obj, "sender", "") or "",
                sender_name=getattr(email_obj, "sender_name", "") or "",
                mailbox=getattr(email_obj, "mailbox", "") or "",
                is_flagged=bool(getattr(email_obj, "is_flagged", False)),
                attach_count=len(getattr(email_obj, "attachments", []) or []),
            )
        except Exception as e:
            logger.debug(f"[island-hook] mail_received dispatch failed: {e}")

    def _maybe_dispatch_island_reviewed(
        self, email_obj: Email, internal_id: int,
        notion_page_id: str, labels: Dict[str, Any],
    ) -> None:
        """ping-island ``LLMReviewed`` / ``LLMReviewedUrgent`` 派发（默认关，fail-open）.

        Phase 1 (PRD §5.1): 透传 ``ai_summary`` 给 envelope metadata，让 fork 端
        ``MailAgentSessionView`` 渲染 1 行 LLM 摘要。
        """
        try:
            from src.notify import island_dispatch
            if not island_dispatch.is_enabled():
                return
            priority = str(labels.get("priority") or "")
            action = str(labels.get("action_type") or labels.get("action") or "")
            # 走 ai_summary_full (完整 2-4 句中文); ai_summary 字段是 summary_for_log 内
            # 截 80 后的 log line 用副本, 不适合 envelope.metadata.
            ai_summary = str(
                labels.get("ai_summary_full") or labels.get("ai_summary") or ""
            )
            # Phase 2 (PRD §5.2): LLM sanitized recommended_actions 透传给 dispatch
            # → urgent 分支动态构 intervention.options 替代 DEFAULT_OPTION_IDS.
            # processor._parse 已按 mailbox-specific whitelist filter, dispatch 再做
            # confidence >= 0.5 + handler whitelist 二次防御性 filter.
            recommended_actions = labels.get("recommended_actions") or []
            if not isinstance(recommended_actions, list):
                recommended_actions = []
            island_dispatch.dispatch_llm_reviewed(
                internal_id=internal_id,
                page_id=notion_page_id or "",
                subject=getattr(email_obj, "subject", "") or "",
                sender_email=getattr(email_obj, "sender", "") or "",
                sender_name=getattr(email_obj, "sender_name", "") or "",
                mailbox=getattr(email_obj, "mailbox", "") or "",
                priority=priority,
                action=action,
                ai_summary=ai_summary,
                recommended_actions=recommended_actions,
            )
        except Exception as e:
            logger.debug(f"[island-hook] llm_reviewed dispatch failed: {e}")

    async def _maybe_notify_feishu(
        self, email_obj: Email, internal_id: int,
        notion_page_id: str, labels: Dict[str, Any],
    ) -> None:
        """本地 LLM review 完成后, 对重要/紧急且需行动的邮件直推飞书通知.

        取代旧链路: Notion Email Agent → Automation webhook(ai_reviewed) → Redis
        → handle_ai_reviewed → 飞书. 本地 LLM 接管分类后 Notion 端不再触发该
        automation, 旧链路断供 (用户现象: 切换后再也收不到飞书通知).

        判据与 handlers.handle_ai_reviewed / reverse_sync._try_notify 一致
        (重要/紧急 + 需行动 + 非发件箱). priority/action_type 直接来自
        labels.summary_for_log(), 格式与飞书判据天然一致 (PRIORITY_ENUM).
        飞书内部自带 page_id 去重(10min) + 3 天时效过滤; 失败仅 warning 不阻塞.
        """
        if self._feishu is None:
            return
        # 与 handlers.FLAG_ACTIONS / reverse_sync.NOTIFY_PRIORITIES 同口径
        notify_priorities = {"🔴 紧急", "🟡 重要"}
        flag_actions = {
            "需要回复", "需要决策", "需要Review",
            "需要会议", "需要跟进", "等待响应",
        }
        try:
            priority = str(labels.get("priority") or "")
            action = str(labels.get("action_type") or "")
            mailbox = getattr(email_obj, "mailbox", "") or ""
            if priority not in notify_priorities:
                return
            if action not in flag_actions:
                return
            if mailbox in ("发件箱", "已发送邮件", "已发送"):
                return
            # L3 降噪: 自定义文件夹默认不通知 (PRD §2.3); FOLDER_NOTIFY_ENABLED 内的才通知。
            # getattr 兜底: 最小 NewWatcher.__new__ 构造 (部分测试) 不走 __init__ 无此属性。
            if should_skip_feishu_for_folder(mailbox, getattr(self, "_folder_notify_enabled", frozenset())):
                logger.debug(
                    f"[feishu] skip custom folder internal_id={internal_id} "
                    f"mailbox={mailbox!r} (L3 降噪; 加 FOLDER_NOTIFY_ENABLED 可开)"
                )
                return

            email_date = getattr(email_obj, "date", None)
            date_iso = (
                email_date.isoformat()
                if isinstance(email_date, datetime)
                else ""
            )
            page_info = {
                "page_id": notion_page_id or "",
                "message_id": getattr(email_obj, "message_id", "") or "",
                "internal_id": internal_id,
                "subject": getattr(email_obj, "subject", "") or "",
                "from_name": getattr(email_obj, "sender_name", "") or "",
                "from_email": getattr(email_obj, "sender", "") or "",
                "to_addr": getattr(email_obj, "to", "") or "",
                "cc_addr": getattr(email_obj, "cc", "") or "",
                "date": date_iso,
                "mailbox": mailbox,
                "ai_action": action,
                "ai_priority": priority,
                "ai_summary": str(
                    labels.get("ai_summary_full") or labels.get("ai_summary") or ""
                ),
                "category": str(labels.get("category") or ""),
                # reply_suggestion 不在 summary_for_log (防完整回复泄露进日志),
                # 飞书卡片回复按钮由 Openclaw 按 page_id/message_id 处理, 此处留空.
                "reply_suggestion": "",
            }
            ok = await self._feishu.notify_important_email(page_info)
            if ok:
                logger.info(
                    f"[feishu] notified internal_id={internal_id} "
                    f"priority={priority} action={action}"
                )
        except Exception as e:
            logger.warning(f"[feishu] notify failed internal_id={internal_id}: {e}")

    async def _process_llm_retry_queue(self) -> None:
        """重试 LLM 失败的邮件（指数退避：1m/5m/15m/1h/2h）。

        超过 LLM_MAX_RETRIES 的邮件状态转 gave_up：
        - 不再重试
        - 不写 AI 字段
        - 不动 Processing Status（保持'未处理'）
        - 让 Notion Custom Agent 自然接手（如果还活着）
        """
        if self._llm_runner is None:
            return
        try:
            ready = self._llm_runner._store.get_ready_for_retry(limit=3)
        except Exception as e:
            logger.warning(f"[llm-retry] queue probe failed: {e}")
            return
        if not ready:
            return
        logger.info(f"[llm-retry] retrying {len(ready)} failed email(s)")
        llm_disabled = getattr(self, "_folder_llm_disabled", frozenset())
        for row in ready:
            internal_id = row.get("internal_id")
            # L2 gate: 黑名单文件夹的 retry 也跳过 (与新邮件 dispatch 一致，省成本去噪)。
            # mailbox 不在 llm_processing 表 → 从 sync_store 按 internal_id 查。
            if llm_disabled:
                meta = self.sync_store.get(internal_id)
                mailbox = (meta or {}).get("mailbox", "") if meta else ""
                if should_skip_llm_for_folder(mailbox or "", llm_disabled):
                    logger.debug(
                        f"[llm-retry] skip internal_id={internal_id} "
                        f"mailbox={mailbox!r} (FOLDER_LLM_DISABLED)"
                    )
                    continue
            try:
                result = await self._llm_runner.run_for_internal_id(
                    internal_id,
                    dry_run=False,
                    force=True,          # bypass already-success short-circuit
                    overwrite=True,
                )
                if result.get("ok"):
                    logger.info(f"[llm-retry] recovered internal_id={internal_id}")
                else:
                    logger.warning(
                        f"[llm-retry] still failing internal_id={internal_id} "
                        f"retry={result.get('retry_count')} status={result.get('status')}"
                    )
            except Exception as e:
                logger.warning(f"[llm-retry] internal_id={internal_id} exception: {e}")

    async def _build_email_object(self, full_email: Dict[str, Any], mailbox: str) -> Optional[Email]:
        """从 AppleScript 返回的数据构建 Email 对象

        Args:
            full_email: fetch_email_by_message_id 返回的数据
            mailbox: 邮箱名称

        Returns:
            Email 对象，失败返回 None
        """
        try:
            source = full_email.get('source', '')
            if not source:
                logger.warning("Email source is empty")
                return None

            # 使用 EmailReader 解析邮件源码
            email_obj = self.email_reader.parse_email_source(
                source=source,
                message_id=full_email.get('message_id'),
                is_read=full_email.get('is_read', False),
                is_flagged=full_email.get('is_flagged', False)
            )

            if email_obj:
                # 设置额外属性
                email_obj.mailbox = mailbox
                email_obj.thread_id = full_email.get('thread_id')

                # 优先使用 AppleScript 返回的 subject（比 MIME 解析更准确）
                if full_email.get('subject'):
                    email_obj.subject = full_email.get('subject')

            return email_obj

        except Exception as e:
            logger.error(f"Failed to build Email object: {e}")
            return None

    async def _process_retry_queue(self):
        """处理重试队列（v3 架构）

        处理两种失败状态：
        1. fetch_failed: AppleScript 获取失败，需要重新获取内容
        2. failed: Notion 同步失败，内容已获取，只需重试同步

        使用指数退避策略：1min, 5min, 15min, 1h, 2h
        每次轮询最多重试 3 封，避免阻塞正常同步。
        超过最大重试次数的邮件会被标记为 dead_letter。
        """
        # 获取可以重试的邮件（next_retry_at <= now）
        ready_emails = self.sync_store.get_ready_for_retry(limit=3)

        if not ready_emails:
            return

        logger.info(f"Retrying {len(ready_emails)} failed emails...")

        for email_meta in ready_emails:
            internal_id = email_meta.get('internal_id')
            sync_status = email_meta.get('sync_status')
            retry_count = email_meta.get('retry_count', 0)
            mailbox = email_meta.get('mailbox', '收件箱')

            self._stats["retries_attempted"] += 1
            logger.info(f"Retry #{retry_count + 1} for {internal_id} (status={sync_status}): {email_meta.get('subject', '')[:40]}...")

            try:
                if sync_status == 'fetch_failed':
                    # AppleScript 获取失败，需要重新获取
                    full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)

                    if not full_email:
                        backend_name = type(self.arm).__name__
                        logger.warning(f"Retry fetch failed for {internal_id} (backend={backend_name})")
                        self.sync_store.mark_fetch_failed(internal_id, f"fetch_email_content_by_id returned None on retry (backend={backend_name})")
                        continue

                    # 获取成功，更新元数据
                    message_id = full_email.get('message_id')
                    thread_id = full_email.get('thread_id')
                    self.sync_store.update_after_fetch(internal_id, {
                        'message_id': message_id,
                        'thread_id': thread_id,
                        'subject': full_email.get('subject'),
                        'sender': full_email.get('sender')
                    })

                    # 构建 Email 对象
                    email_obj = await self._build_email_object(full_email, mailbox)
                    if not email_obj:
                        self.sync_store.mark_failed_v3(internal_id, "Failed to build Email object on retry")
                        continue

                    # 设置 internal_id（v3 架构）
                    email_obj.internal_id = internal_id

                else:
                    # failed 状态：已有完整内容，重新获取以确保数据最新
                    message_id = email_meta.get('message_id')
                    if not message_id:
                        # 没有 message_id，尝试重新获取
                        full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
                        if not full_email:
                            self.sync_store.mark_fetch_failed(internal_id, "Cannot refetch for retry")
                            continue
                        message_id = full_email.get('message_id')
                        self.sync_store.update_after_fetch(internal_id, {
                            'message_id': message_id,
                            'thread_id': full_email.get('thread_id'),
                            'subject': full_email.get('subject'),
                            'sender': full_email.get('sender')
                        })
                    else:
                        # 有 message_id，通过 internal_id 重新获取
                        full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
                        if not full_email:
                            self.sync_store.mark_fetch_failed(internal_id, "Cannot refetch for retry")
                            continue

                    email_obj = await self._build_email_object(full_email, mailbox)
                    if not email_obj:
                        self.sync_store.mark_failed_v3(internal_id, "Failed to build Email object on retry")
                        continue

                # 设置 internal_id（v3 架构）
                email_obj.internal_id = internal_id

                # 把 reader 解析出的完整 MIME header 字段写回 SQLite metadata
                # (to/cc/sender_name). 主 sync 路径同步落地, 见 _sync_single_
                # email_v3 内同样调用; 抽 helper 避免两条路径再次漏写.
                self._persist_email_metadata_after_parse(internal_id, email_obj)

                # v4: 双写邮件正文 + 附件到 SQLite（重试路径同样需要双写）
                self._maybe_dual_write_body(
                    email_obj, internal_id, full_email.get("source")
                )

                # 同步到 Notion
                page_id = await self.notion_sync.create_email_page_v2(email_obj)

                if page_id:
                    self.sync_store.mark_synced_v3(internal_id, page_id)
                    self._stats["retries_succeeded"] += 1
                    self._stats["emails_synced"] += 1
                    logger.info(f"Retry succeeded: {internal_id} -> {page_id}")
                else:
                    self.sync_store.mark_failed_v3(internal_id, "Notion sync returned None on retry")

            except Exception as e:
                logger.error(f"Retry failed for {internal_id}: {e}")
                self.sync_store.mark_failed_v3(internal_id, str(e))

    async def _detect_and_sync_flag_changes(self):
        """[DEPRECATED Sprint 15 — disabled, see commit log]

        v3 设计: 把 Mail.app 当 drift truth, diff vs SQLite stored 后直调
            `notion_sync.update_email_flags()` 反向写 Notion + 覆盖 sync_store.

        Sprint 15 SSoT inversion 下这个语义彻底反了:
          - sync_store 才是状态真源, Mail.app / Notion 都是 fanout 的镜像
          - 前端 / CLI / handler 写完 sync_store 后, fanout 派发是异步的, Mail.app
            会有 ~5s 窗口跟 sync_store 不一致 -> 旧函数会把那个窗口判为 "drift"
            并:
              1. 把 sync_store 拉回 Mail.app stale 值 (破坏前端 intent)
              2. 写 Notion processing_status='已完成' (触发 handle_completed unflag)
              3. 形成 flag/unflag 死循环 (实测见 logs/sprint15-d-handoff)

        修复: 函数体 short-circuit return. 调用点 (_poll_cycle 第 7 步) 暂时保留,
        待真要"Mail.app 端用户手改 -> 写 outbox(notion)"的反向语义设计时复用本钩子.

        当前用户场景:
          - 前端点 flag -> CLI 写 sync_store + outbox -> fanout 派发到 Mail/Notion
          - Notion 端 automation -> webhook -> handle_flag_changed/completed
            (二者都走 outbox, 也是单向)
          - macOS Mail.app 端用户直接改 flag: 暂时不会反向同步到 Notion (需要后续
            设计真 drift 检测 + 写 outbox(notion) 路径, 不能直调 Notion API).
        """
        return

    def get_stats(self) -> Dict[str, Any]:
        """获取统计信息"""
        radar_stats = {
            "last_max_row_id": 0,
            "available": False
        }
        if self.radar:
            radar_stats = {
                "last_max_row_id": self.radar.get_last_max_row_id(),
                "available": self.radar.is_available()
            }

        return {
            **self._stats,
            "healthy": self._healthy,
            "running": self._running,
            "sync_store": self.sync_store.get_stats(),
            "radar": radar_stats
        }

    def is_healthy(self) -> bool:
        """返回服务健康状态"""
        return self._healthy and self._running


async def main():
    """测试入口"""
    import sys

    # 配置日志
    logger.remove()
    logger.add(sys.stderr, level="INFO")

    watcher = NewWatcher()

    # 打印状态
    print("NewWatcher Stats:")
    print(watcher.get_stats())

    # 运行一次轮询
    print("\nRunning single poll cycle...")
    await watcher._poll_cycle()

    print("\nDone. Stats:")
    print(watcher.get_stats())


if __name__ == "__main__":
    asyncio.run(main())
