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
import time
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Optional, Any
from loguru import logger

from src.config import config as settings
from src.config import notion_enabled
from src.models import Email
from src.mail.sync_store import (
    DRAFT_MAILBOX_LABELS,
    SyncStore,
    UpdateAfterFetchResult,
)
from src.notion.sync import NotionSync
from src.mail.reader import EmailReader
from src.mail.meeting_sync import MeetingInviteSync
from src.repository import (
    AttachmentStore,
    EmailRepository,
    build_storage_payloads,
)
from src.mail.backend.base import MarkerUnavailableError
from src.mail.backend.imap_client import parse_folder_csv_or_json
from src.mail.backend.serial_executor import run_backend_io
from src.mail.throttle_pause import is_uid_backfill_paused

# 标准邮箱 (非自定义文件夹) —— L2/L3 gate 不影响这些; 自定义文件夹 = mailbox 不在此集合。
# issue #42 C 案起单源迁至 src/mail/mailbox_semantics.py (STANDARD_MAILBOXES,
# 「存档」有意不进的语义注释随迁); is_custom_folder_mailbox 在原处 re-export 保兼容。
from src.mail.mailbox_semantics import (  # noqa: F401  (re-export)
    INBOX_LABEL,
    is_custom_folder_mailbox,
    is_drafts_mailbox,
    is_sent_mailbox,
)


# 入向已读回收 (issue #58) 聚合刷新事件里携带的 internal_id 上限 —— 单条事件要能
# 让前端失效对应的 ['email', id] detail cache, 但首次开启/大批量收敛时可能上千封,
# 全塞进 SSE payload 既撑爆消息也无意义。超限时置 ids_truncated=True, 由前端退化成
# "失效所有活跃 detail"。
READ_RECONCILE_EVENT_ID_CAP = 200

# 入向已读回收: 「定向 FETCH 复核 → 收敛提交」的分块大小。
# 复核与提交之间存在无法用本地状态拦截的外部竞态 (FETCH 说已读 → 用户在 Outlook 又标
# 未读 → 此刻还没有任何本地写/intent, CAS 和在途闸都看不见 → 提交后本功能单向不自愈)。
# 分块让这个窗口从「整批候选的处理时长」收窄到「单 chunk 的本地事务时长」。
# 选 100 而非 backend 的 _FLAGS_FETCH_CHUNK(500): 候选通常个位数, ≤100 时两者都只发
# 一次 FETCH (零额外 IMAP 会话); 只有首次开启的存量积压才会分块, 那时窄窗口比省下
# 几次定向 FETCH 更值。
READ_RECONCILE_CONVERGE_CHUNK = 100

# 收敛事务的 SQLite busy timeout。事务本身全是本地语句 (BEGIN IMMEDIATE + 1 SELECT +
# 1 UPDATE + 1 UPSERT), 正常持锁毫秒级; 2s 已远高于常规竞争, 又远低于 outbox 默认的
# 30s —— 收敛是可跳过的便利型写 (下轮重判), 不该为它挂住 watcher 的 poll cycle。
#
# 🔴 **第一次锁超时就终止本轮** (不是"连续 N 次"): 一旦开始等锁, 手里这份 seen_map 就
# 在变旧, 继续消费它只会把 FETCH↔提交的竞态窗口按 2s/封 地撑大 (交替出现的成功会让
# "连续"计数永远清零, 窗口能拉到近百秒)。被跳过的封下个 interval 必然重新成为候选并
# 重新 FETCH 取新鲜真值 —— 幂等的保守让路, 不丢状态。
READ_RECONCILE_LOCK_TIMEOUT_SEC = 2.0

# 单 chunk 收敛的**累计耗时预算**。上面那条"首次锁超时即停"只堵住「等满 timeout 仍拿不到
# 锁」这一种形态; 另一种形态是别的 writer 在每封之间反复抢放锁, 每封都在 timeout 之前
# (比如 1.5s) 才拿到 —— 每封都**成功返回**, ConvergeLockBusy 一次都不抛, 但 100 封 chunk
# 能累计到分钟级, 手里的 seen_map 一样在变旧 (FETCH↔提交窗口按 chunk 长度线性膨胀)。
# 取 3s: 无竞争时整个 chunk 全是本地语句 (100 封 × 个位数毫秒 ≈ 0.2-0.5s), 3s 留了一个
# 数量级余量, 不会误伤正常路径; 又把陈旧窗口的上界钉在「预算 + 最后那封的锁等待
# (≤ READ_RECONCILE_LOCK_TIMEOUT_SEC)」≈ 5s, 而不是随 chunk 长度线性增长。
READ_RECONCILE_CHUNK_BUDGET_SEC = 3.0

# ---- KOS 失败重试 (issue #59, 主 tick 第 6c 步) ------------------------------
# 每 tick 处理上限, 镜像 6b _process_llm_retry_queue 的 get_ready_for_retry(limit=3):
# 3 封/5s tick ≈ 0.6/s, 与 KOS 限流 (50 req/15min, client.py 头注) 天然匹配;
# 101 封积压 (2026-07-24 实测) 约 3 分钟排干, 无需"恢复轮放宽 chunk"特例。
KOS_RETRY_BATCH_PER_TICK = 3


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
                None 默认 → 按 applescript 模式自构 AppleScriptBackend
                (仅本模块 main() 手动入口使用; 生产由 service.py 注入).

        Raises:
            RuntimeError: 如果关键组件初始化失败
        """
        self.mailboxes = mailboxes or ["收件箱", "发件箱"]
        self.poll_interval = poll_interval

        # 解析同步起始日期
        self.sync_start_date = _parse_sync_start_date()
        if self.sync_start_date:
            logger.info(f"Sync start date: {self.sync_start_date.strftime('%Y-%m-%d')} (emails before this date will be cached but not synced to Notion)")

        # E1 契约收口: watcher 直接持 IMailBackend 调方法 (雷达面 + 抓取面),
        # 无 arm/radar 影子层. backend=None (老手动入口兼容) → 构造
        # AppleScriptBackend, 与旧直构 arm/radar 语义一致 (SQLiteRadar 构造
        # 不抛, Envelope Index 缺失仅 is_available()=False; probe 由 factory 管).
        if backend is None:
            from src.mail.backend.applescript_backend import AppleScriptBackend
            backend = AppleScriptBackend(settings)
            if not backend.is_available():
                logger.warning("SQLite radar not available, will rely on AppleScript only")
        else:
            logger.info(f"[dual-backend] NewWatcher 使用 backend={type(backend).__name__}")
        self.backend = backend

        try:
            self.sync_store = SyncStore(sync_store_path)
        except Exception as e:
            logger.error(f"Failed to initialize SyncStore: {e}")
            raise RuntimeError(f"SyncStore initialization failed: {e}")

        # v4: SQLite SSoT 仓库（strict DI 需要在 NotionSync 之前初始化）
        # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md
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

        # 项目周报外挂钩子（S5 W5a: 专型行 type='project_progress'，DB v31 播种单例）。
        # 总闸 = env PROJECT_PROGRESS_SYNC_ENABLED + 配置了项目进度库 ID（runner 需要，非事件热读项）。
        # 具体触发（enabled + sender/subject）每封邮件从 report_agent 行**热读**（Settings 改即生效）；
        # 行不存在（老库未跑 v31）→ 回退 env 构造（行为等价窗口）。db_path 供 hook 裸 sqlite3 热读。
        # + notion_enabled 门（07-12 P3b）: 项目周报 runner 写 Notion 项目库，
        # 无 NOTION_TOKEN 时整个钩子无意义 → 不激活。
        self._progress_hook_active = bool(
            getattr(settings, "project_progress_sync_enabled", False)
            and getattr(settings, "project_progress_database_id", "")
            and notion_enabled()
        )
        self._agent_db_path = str(self.sync_store.db_path)
        if self._progress_hook_active:
            logger.info(
                f"Project Progress hook active (db={settings.project_progress_database_id}); "
                f"enabled/trigger 从 report_agent 行热读（Settings 可改）"
            )

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

        # Custom Agent email_filter 触发钩子（S4，需 MAILAGENT_CUSTOM_AGENTS_ENABLED）。
        # 主循环只做 flag + 存在性检查；正则匹配移进 fire-and-forget 后台任务体（ReDoS 收面）。
        self._custom_agents_enabled = getattr(settings, "custom_agents_enabled", False)
        self._agent_store = None
        self._agent_job_repo = None
        if self._custom_agents_enabled:
            try:
                from src.reports.store import ReportStore
                from src.sync.async_jobs import AsyncJobRepository
                _agent_db = str(self.sync_store.db_path)
                self._agent_store = ReportStore(db_path=_agent_db)
                self._agent_job_repo = AsyncJobRepository(_agent_db)
                logger.info("[custom-agent] email_filter hook enabled")
            except Exception as e:
                logger.warning(f"[custom-agent] init failed, disabling: {e}")
                self._custom_agents_enabled = False

        # 运行状态
        self._running = False
        self._healthy = True  # 服务健康状态
        # EWS 限流暂停日志的跃迁标记: 进入暂停首轮 warning、持续期间 debug、恢复
        # 首轮 info —— 否则暂停期间每轮 poll (默认 5s) 一条 warning, 30min ≈ 360 条。
        self._throttle_pause_announced = False
        # 入向已读回收 (issue #58) 的独立低频节拍游标 (monotonic 秒)。None = 从未跑过,
        # 首次进入即执行; 与 5s radar poll 解耦, 间隔见 inbound_read_reconcile_interval_sec。
        self._last_inbound_read_reconcile_at: Optional[float] = None
        # KOS 失败重试 (issue #59, 第 6c 步) 的不健康冷却截止 (monotonic 秒):
        # 探活失败后到此刻之前整段跳过, 不必每个 5s tick 都对着倒掉的 KOS 探活。
        self._kos_unhealthy_until: Optional[float] = None
        # task 06-10 (prd Fix 2d): fire-and-forget hook task (pp/llm/kos) 的强
        # 引用集合 — Python 3.11 asyncio loop 只弱引用 task, 无强引用的 pending
        # task 会被 GC 中途回收 (生产实证见 start() 里 _rollout_flush_task 注释)。
        # add_done_callback(discard) 完成即自动移除, len 可观测 in-flight 数。
        self._bg_tasks: set = set()
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

        # 检查雷达面（backend 可用性）
        if not self.backend.is_available():
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

        # issue #34: 切 backend 时防 marker id-space 混用（详见
        # sync_store.reconcile_marker_backend + config MAILAGENT_MARKER_BACKEND_GUARD）。
        # 必须在下面 restore/baseline 之前跑：reset 分支会把 marker 清零，让 restore 落到
        # first-run baseline 分支、在当前 backend 的 id 空间重新定基线（只向前，不回捞历史
        # gap —— gap 由 backfill 兜）。
        current_backend = getattr(settings, "mailagent_backend", "applescript")
        if getattr(settings, "mailagent_marker_backend_guard", True):
            action = self.sync_store.reconcile_marker_backend(current_backend)
            if action == 'reset':
                logger.warning(
                    "[marker-guard] backend changed → 上次 marker 属于别的 id 空间; "
                    "已重置到 first-run baseline 防 silent-loss/deadlock (issue #34). "
                    f"backend={current_backend!r}"
                )
            elif action == 'adopt':
                logger.info(
                    f"[marker-guard] 认领既有 marker 归属 backend={current_backend!r} (不重置)"
                )

        # 初始化：从 SyncStore 恢复 last_max_row_id
        # finding F1: 首次运行判定必须用「marker 键是否存在」而非「值 > 0」——
        # get_last_max_row_id() 对「键缺失」和「合法持久化的 '0'」都返回 0，applescript
        # 空邮箱 baseline 0 会被误判首次 → 重定基线 → 停机期间到达的首封邮件被静默跳过。
        # 键存在即恢复（哪怕值是 0）；#34 reset 走删键 → 键缺失 → 落 first-run baseline。
        if self.sync_store.has_last_max_row_id():
            last_max_row_id = self.sync_store.get_last_max_row_id()
            self.backend.set_last_max_row_id(last_max_row_id)
            logger.info(f"Restored last_max_row_id from SyncStore: {last_max_row_id}")
        else:
            # 首次运行，获取当前 max_row_id 作为基线。
            # 🔴 查询失败绝不能落 0 (task 07-14 L3): 下轮 check_for_changes 拿真实
            # UIDNEXT 与 0 求差 → 误判几十万封 → get_new_emails(0) 发 UID 1:* 全量
            # 重刷。带 backoff 重试 (probe 刚过, 多为 STATUS 瞬时慢); 仍失败宁可
            # 不启动 (raise, 复用上面 health check 失败的 RuntimeError 范式)。
            current_max = None
            for attempt in range(3):
                try:
                    current_max = self.backend.get_current_max_row_id()
                    break
                except MarkerUnavailableError as e:
                    logger.warning(f"Baseline marker query failed ({attempt + 1}/3): {e}")
                    await asyncio.sleep(2)
            if current_max is None:  # 真实 0 (applescript 空邮箱) 合法, 不算失败
                raise RuntimeError(
                    "Cannot establish baseline marker (backend marker query "
                    "unavailable), refusing to start with poisoned marker=0"
                )
            self.backend.set_last_max_row_id(current_max)
            self.sync_store.set_last_max_row_id(current_max)
            # issue #34: 盖上 marker 归属，供下次启动的 guard 比对（reset 后重定基线也走这里）
            self.sync_store.set_state('marker_backend', current_backend)
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

        # EWS 限流退避: davmail_watchdog 检测到 Microsoft EWS 限流 (throttle burst)
        # 时会把 sync_state['davmail_uid_backfill_paused'] 置 'true'。限流时整轮跳过 —
        # check_for_changes 的 STATUS、pending fetch、retry 都不发 IMAP, 最大化减压
        # 让 EWS 配额恢复; watchdog 检测到限流解除后复位 flag, 下一轮 poll 自然继续。
        # applescript 模式无 watchdog → flag 恒非 'true' → 行为不变。
        #
        # 日志跃迁式 (跟 davmail_uid_mapper.run_backfill 的 paused_announced 同套路):
        # 进入暂停首轮 warning、持续期间降 debug (不每 5s 刷屏)、恢复首轮 info。
        if is_uid_backfill_paused(self.sync_store):
            if not self._throttle_pause_announced:
                logger.warning("[watcher] EWS throttling active — 跳过本轮 poll (等配额恢复)")
                self._throttle_pause_announced = True
            else:
                logger.debug("[watcher] EWS throttling 仍在暂停中 — 跳过本轮 poll")
            return
        if self._throttle_pause_announced:
            logger.info("[watcher] EWS throttling 解除 — 恢复正常 poll")
            self._throttle_pause_announced = False

        # 1. 雷达检测新邮件并直接获取元数据
        if self.backend.is_available():
            last_max_row_id = self.sync_store.get_last_max_row_id()
            has_new, current_max, estimated_count = self.backend.check_for_changes(last_max_row_id)

            if not has_new:
                logger.debug("No new emails detected")
            else:
                logger.info(f"Detected ~{estimated_count} new emails (row_id {last_max_row_id} -> {current_max})")
                self._stats["new_emails_detected"] += estimated_count

                # 2. SQLite 直接获取新邮件元数据（不通过 AppleScript）
                #
                # PR #23 (credit @KevinWangQQ) 游标守卫: check_for_changes 用轻量
                # STATUS 证明有新邮件后, 这里的重量级 SEARCH/FETCH 若失败 (超时/断连),
                # 本轮**不推进游标**、不更新 last_sync_time — 下轮同窗口自动重试,
                # IMAP 恢复即自愈。合法返空 ([]) 仍照常推进 (UIDNEXT 差值会高估:
                # 删信/SEARCH 不匹配, 空成功不推进会卡死)。
                try:
                    new_emails = self.backend.get_new_emails(last_max_row_id)
                except Exception as e:
                    logger.error(
                        f"get_new_emails failed, cursor NOT advanced — window "
                        f"({last_max_row_id}, {current_max}] retried next poll: {e}"
                    )
                    new_emails = None

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

                # 4. 更新 last_max_row_id（立即持久化）— 仅成功 (含空成功) 时推进;
                # None = get_new_emails 失败, 游标留在原位等下轮重试
                if new_emails is not None:
                    self.sync_store.set_last_max_row_id(current_max)
                    self.sync_store.set_last_sync_time(datetime.now().isoformat())
        else:
            logger.debug("Radar unavailable, skipping new email detection")

        # 4.6 草稿箱对账 (davmail-only, DRAFTS_SYNC_ENABLED) — 新草稿入库 (pending,
        # 下一步即 fetch body) + 删除已消失草稿 (编辑替换/发送/删除)
        await self._reconcile_drafts()

        # 5. 处理 pending 邮件（AppleScript 获取完整内容并同步到 Notion）
        await self._process_pending_emails()

        # 6. 处理重试队列（fetch_failed 和 failed 状态）
        await self._process_retry_queue()

        # 6b. 处理 LLM 失败重试队列（若启用本地 LLM）
        await self._process_llm_retry_queue()

        # 6c. 处理 KOS 入库失败重试队列 (issue #59, 若启用 KOS ingest) — 镜像 6b 的
        # 队列驱动形状 (limit=3/tick, next_retry_at 指数退避排程), 前置健康探活。
        await self._process_kos_retry_queue()

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

        # 8. 入向已读回收 (issue #58, davmail-only, 默认关) — 独立低频节拍, 不挂每轮。
        # 位置在 throttle-pause guard 之后, EWS 限流时本轮已 return 不会走到这里。
        await self._reconcile_inbound_read()

    async def _reconcile_inbound_read(self):
        """入向「未读→已读」单向回收 (davmail-only, MAILAGENT_INBOUND_READ_RECONCILE_ENABLED)。

        Outlook/OWA 等外部客户端标已读后, MailAgent 未读不回流 (Sprint15 为避 flag/unflag
        死循环禁了入向回收, 见 _detect_and_sync_flag_changes docstring)。这里加**安全版**
        单向收敛: 服务器上确认带 \\Seen 的本地未读邮件 → 收敛为已读。

        判定分两步, **SEARCH 只出候选、FETCH 才是判据**:
          1. ``UID SEARCH UNSEEN`` 拿服务器未读集 → 本地未读且不在其中的 = 候选;
          2. 提交前对候选 uid 定向 ``UID FETCH (FLAGS)`` 复核 —— 未返回 (已归档/删除/
             被规则搬走/UID 空洞) 或返回但无 \\Seen (SEARCH 快照期间又被标未读) 一律
             跳过, 只有确证带 \\Seen 才收敛。缺了这步就会把 "不在 INBOX" 误解释成
             "已读", 把归档掉的未读邮件永久标已读 (codex review BLOCK 1/2)。

        安全闸 (缺一不可):
          (a) outbox 有未终态 (pending/processing/failed) flag_sync intent → 跳过 (避
              Sprint15 fanout 窗口把 "出向 intent 尚未派发" 误判为入向 drift)。这道闸与
              本地 CAS + 入队在**同一个事务**内 (converge_local_read_atomic), 消 TOCTOU。
          (b) 恒走 outbox 单向派发 (target='notion', 不入 mailapp 队) —— **绝不直调
              Notion** (Sprint15 死循环根因之一); 服务器本就是已读真源, 不回写 Mail.app。
          (c) 本地 imap_uidvalidity 与服务器当前 UIDVALIDITY 一致才用 imap_uid 匹配;
              不一致的行整批跳过 (uidvalidity 变化让 imap_uid 全失效 → 批量误判污染)。
              两次 IMAP 会话之间 uv 变了同样整轮作废。
          (c2) uid 必须落在服务器 IMAP 视图的截断窗口内 (davmail.folderSizeLimit 只保留
              最近 N 封) —— 窗口外老邮件在 UNSEEN 里必然缺席, 缺席 ≠ 已读。

        ⚠️ 已知残留竞态 (有意不彻底消除, 见 test_marked_unread_between_verify_and_commit):
          定向 FETCH 说「已读」之后、本轮事务提交之前, 用户在 Outlook 把这封标回未读 ——
          此刻**还没有**任何本地写或 outbox intent, 所以 CAS 与在途闸都看不见它, 这封会
          被收敛成已读; 下轮它已不在本地未读集, 而本功能单向 (不做已读→未读) → 不自愈。
          处置: 复核与提交按 chunk 紧邻 (READ_RECONCILE_CONVERGE_CHUNK), 把窗口从「整批
          候选的处理时长」(候选多时可达数秒) 收窄到「单 chunk 内、该封之前那些收敛事务的
          累计时长」—— 无锁竞争时全是本地语句, 毫秒级; 一旦有一封等锁超时就**立即终止本轮**
          (见 READ_RECONCILE_LOCK_TIMEOUT_SEC), 不让 2s 级的锁等待逐封累加把窗口撑大, 也不
          再消费已经变旧的 seen_map。另有**累计耗时预算**
          (READ_RECONCILE_CHUNK_BUDGET_SEC) 兜住「每封都等很久、但都在 timeout 之前拿到锁」
          这一形态 —— 那种情况一次 ConvergeLockBusy 都不抛, 却同样把窗口按 chunk 长度撑大。
          两道闸合起来把窗口钉在常数量级 (预算 + 一次锁等待), 与候选量、chunk 长度都解耦。
          再窄一档要 CONDSTORE/MODSEQ (DavMail 经 EWS 桥支持存疑) —— 但那也只是"提交前
          再便宜地复核一次", **写在本地**, TOCTOU 依旧, 只是窗口更小; 真正闭合只有提交后
          补偿事务 (撤销本地已读 + 取消/覆盖可能已派发的 Notion intent, 而"覆盖"就是
          Sprint15 死循环那条出向路径, 补偿本身又有自身竞态) —— 对一个默认关的便利功能
          不成比例。用户侧兜底: 在 Outlook 重新标未读一次即可。

        只做未读→已读单向 (已读→未读 / \\Flagged 不碰), 只收件箱; 任何异常仅 warning 不阻塞。
        绝不挂 5s radar poll: 独立低频周期 (interval env), 避免 UID SEARCH 重现 EWS 全量枚举
        限流 (issue #46)。AppleScript fallback 无这两个方法 → 整段 noop。
        SQLite 侧的查询与收敛事务全部 ``asyncio.to_thread`` 出去 —— 锁等待发生在工作线程,
        不冻住 event loop (与 SEARCH/FETCH 走 backend-io 队列同理)。
        """
        # flag 门 (默认 false → 字节级 inert, 不发 SEARCH、不改任何行)
        if not getattr(settings, "inbound_read_reconcile_enabled", False):
            return
        backend = self.backend
        # davmail-only: AppleScript backend 无这两个方法 → noop (应急回切也安全)。
        # 定向复核缺席时**整段不激活** —— 没有 FETCH 判据就只能靠 SEARCH 缺席猜,
        # 那正是会误标归档邮件的不安全形态。
        if not (hasattr(backend, "search_inbox_unseen")
                and hasattr(backend, "fetch_inbox_seen_flags")):
            return

        # 独立低频节拍: 距上次收敛不足 interval → 本轮跳过 (与 5s radar poll 解耦)。
        # 失败也推进游标 (下 interval 再试), 不在失败时高频重试打限流。
        interval = max(1, int(getattr(settings, "inbound_read_reconcile_interval_sec", 300)))
        now = time.monotonic()
        last = self._last_inbound_read_reconcile_at
        if last is not None and (now - last) < interval:
            return
        self._last_inbound_read_reconcile_at = now

        try:
            # 走 backend-io 单线程队列: SELECT+SEARCH 在大邮箱可能数分钟 (issue #46),
            # 直接在事件循环里跑会连带冻住 fanout / reverse / island 所有 worker 的 tick。
            result = await run_backend_io(backend.search_inbox_unseen)
        except Exception as e:
            logger.warning(f"[read-reconcile] search_inbox_unseen failed (skip cycle): {e}")
            return
        if result is None:
            logger.debug("[read-reconcile] server UNSEEN unavailable, skip this cycle")
            return
        server_uv, server_unseen, min_visible_uid = result

        try:
            # to_thread: 全表 is_read=0 扫描在大邮箱不是 O(1), 别占着事件循环线程跑
            rows = await asyncio.to_thread(
                self.sync_store.get_inbox_unread_for_read_reconcile, INBOX_LABEL
            )
        except Exception as e:
            logger.warning(f"[read-reconcile] local unread query failed (skip cycle): {e}")
            return
        if not rows:
            return

        # 候选筛选: 只是"值得复核"的集合, **不是**判定结果 —— 判定在下面的定向 FETCH。
        # 用 list 而非 uid→id 字典: 幽灵重复行可能共享同一 imap_uid, 字典会静默丢掉一封。
        # updated_at 一并带着: 提交时的 CAS 要用它认出"本轮期间这行被别处写过"。
        candidates: List[tuple] = []             # [(imap_uid, internal_id, updated_at)]
        for row in rows:
            imap_uid = row.get("imap_uid")
            row_uv = row.get("imap_uidvalidity")
            # (c) uidvalidity 一致性闸: imap_uid/uv 缺失 (AppleScript 行) 或与服务器
            # 当前 uv 不一致 → 该 imap_uid 已失效, 跳过 (不拿失效 uid 去匹配)。
            if imap_uid is None or row_uv is None or int(row_uv) != int(server_uv):
                continue
            # (c2) 截断窗口下界闸: davmail.folderSizeLimit 让 IMAP 视图只剩最近 N 封,
            # 窗口外的老邮件在 UNSEEN 里**必然缺席** —— 缺席 ≠ 已读, 少了这道闸会把
            # 真未读老邮件批量误标已读 (见 backend._lowest_visible_uid)。
            if int(imap_uid) < int(min_visible_uid):
                continue
            # 服务器仍未读 → 真未读, 连候选都不是
            if int(imap_uid) in server_unseen:
                continue
            candidates.append((int(imap_uid), row["internal_id"], row.get("updated_at")))
        if not candidates:
            return
        # uid 升序: 分块边界确定 (便于排查/测试), 定向 FETCH 的 uid set 也更紧凑
        candidates.sort(key=lambda c: c[0])

        from src.sync.outbox import OutboxRepository

        outbox = OutboxRepository(str(self.sync_store.db_path))
        converged_ids: List[int] = []
        stats = {
            "gone": 0,        # 已不在 INBOX (归档/删除/规则搬走/UID 空洞)
            "unread": 0,      # 服务器仍未读 (SEARCH 快照期间又被标未读)
            "busy": 0,        # 事务内被闸住: 在途 intent, 或本轮期间该行被别处写过
            "locked": 0,      # 短 busy timeout 内没拿到 SQLite 写锁 → 让路
            "lock_abort": False,
            "abort_reason": "",   # 'lock_timeout' | 'time_budget' (日志要能分辨)
        }
        # 🔴 定向复核 (codex BLOCK 1/2 的统一解): 对候选 uid 拉 (UID FLAGS), 把"耗时可能
        # 数分钟的全局 SEARCH 快照"降级为候选筛选, 最终判据以这一步为准。
        # 🔴 按 chunk「复核 → 立即收敛 → 下一 chunk」: 复核与提交之间的外部竞态 (用户在
        # Outlook 标回未读, 此刻无本地写可拦) 无法彻底消除, 只能把窗口收窄到单 chunk 的
        # 本地事务时长 —— 一次性复核全部候选再逐封收敛会把它拉成整批处理时长 (见 docstring)。
        for start in range(0, len(candidates), READ_RECONCILE_CONVERGE_CHUNK):
            chunk = candidates[start:start + READ_RECONCILE_CONVERGE_CHUNK]
            try:
                verified = await run_backend_io(backend.fetch_inbox_seen_flags,
                                                sorted({u for u, _, _ in chunk}))
            except Exception as e:
                logger.warning(f"[read-reconcile] flags verify failed (stop cycle): {e}")
                break
            if verified is None:
                logger.debug("[read-reconcile] flags verify unavailable, stop cycle")
                break
            verify_uv, seen_map = verified
            if int(verify_uv) != int(server_uv):
                # 两次会话之间 UIDVALIDITY 变了 → 剩余候选的 uid 全部失效, 停止本轮
                logger.warning(
                    f"[read-reconcile] UIDVALIDITY changed mid-cycle "
                    f"({server_uv}→{verify_uv}), stop cycle"
                )
                break
            # to_thread: 收敛是同步 SQLite 事务, 锁等待必须发生在工作线程 —— 直接在
            # 事件循环里跑, 别的进程持写锁时会把整个 watcher loop 拖住 (每封都可能等)。
            converged_ids.extend(
                await asyncio.to_thread(
                    self._converge_read_chunk_blocking, outbox, chunk, seen_map, stats
                )
            )
            if stats["lock_abort"]:
                if stats["abort_reason"] == "time_budget":
                    cause = (
                        f"单 chunk 收敛累计耗时超过 {READ_RECONCILE_CHUNK_BUDGET_SEC}s "
                        f"(写锁竞争: 每封都拿到了锁, 但每封都等了很久)"
                    )
                else:
                    cause = (
                        f"有候选在 {READ_RECONCILE_LOCK_TIMEOUT_SEC}s 内没拿到 SQLite 写锁 "
                        f"(写锁竞争)"
                    )
                logger.warning(
                    f"[read-reconcile] {cause}, 本轮提前终止以免消费陈旧的 FETCH 快照; "
                    f"已提交的不回滚, 被跳过的下个周期重新复核重判"
                )
                break
        if stats["gone"] or stats["unread"] or stats["busy"] or stats["locked"]:
            logger.debug(
                f"[read-reconcile] skipped {stats['gone']} 已移出 INBOX / "
                f"{stats['unread']} 服务器仍未读 / {stats['busy']} 在途或并发写 / "
                f"{stats['locked']} 写锁竞争 (候选 {len(candidates)})"
            )
        if converged_ids:
            logger.info(
                f"[read-reconcile] converged {len(converged_ids)} inbox 邮件 未读→已读 "
                f"(outbox→notion, server_uv={server_uv})"
            )
            # 让前端刷新列表 + 未读徽标 + **已打开的详情**。整轮只发一条 (不按封刷屏),
            # 但携带有界的 internal_ids 让前端能失效对应的 ['email', id] detail cache ——
            # 少了它, 列表显示已读而详情 toolbar 仍显示未读 (codex BLOCK 4)。超过上限时
            # ids_truncated=True, 前端据此失效所有活跃 detail。
            # 本地-only 模式 (无 Notion 页) 下这是**唯一**的刷新信号 (notion_fanout
            # 的 email.flag_changed 在 page_id 为空时 noop 不发)。
            try:
                from src.events.publisher import safe_publish
                safe_publish(
                    "email.flag_changed",
                    internal_id=None,
                    data={
                        "target": "local",
                        "converged": len(converged_ids),
                        "reason": "inbound_read_reconcile",
                        "internal_ids": converged_ids[:READ_RECONCILE_EVENT_ID_CAP],
                        "ids_truncated": len(converged_ids) > READ_RECONCILE_EVENT_ID_CAP,
                    },
                    source="read_reconcile",
                )
            except Exception:
                pass

    def _converge_read_chunk_blocking(
        self,
        outbox,
        chunk: List[tuple],
        seen_map: Dict[int, bool],
        stats: Dict[str, Any],
    ) -> List[int]:
        """一个 chunk 的收敛 —— **同步阻塞**, 由 ``_reconcile_inbound_read`` 经
        ``asyncio.to_thread`` 在工作线程里跑, 返回本 chunk 真正收敛的 internal_ids。

        为什么必须离开事件循环: 事务本身无网络 I/O、无内在死锁顺序, 但 SQLite 写锁的
        **等待**是同步阻塞 —— 另一进程 (serve-api / CLI / fanout) 持写锁时, 每封候选
        都可能在这里干等, 多封可重复发生, 把 watcher 的 event loop 整个卡住。

        ``stats`` 就地累加各跳过原因; 两种情况会置 ``stats['lock_abort']=True`` 并提前
        返回 (由调用方停掉后续 chunk, ``stats['abort_reason']`` 区分两者):
        ``lock_timeout`` = **第一封**等满 busy timeout 仍没拿到锁;
        ``time_budget``  = 本 chunk 收敛累计耗时超过 READ_RECONCILE_CHUNK_BUDGET_SEC
        (每封都拿到了锁、但每封都等很久 —— 一次 ConvergeLockBusy 都不抛的那种竞争)。
        两者语义相同: 等锁 = 手里的 seen_map 在变旧, 让路比硬等更保守。
        已提交的前序封不回滚 —— 与 chunk 级失败 break 的既有语义一致, 收敛本身幂等。
        """
        from src.sync.outbox_intents import ConvergeLockBusy, converge_local_read_atomic

        converged: List[int] = []
        started = time.monotonic()
        for imap_uid, internal_id, snapshot_updated_at in chunk:
            seen = seen_map.get(imap_uid)
            if seen is None:
                stats["gone"] += 1
                continue
            if not seen:
                stats["unread"] += 1
                continue
            # 累计耗时预算 (在开一笔新事务**之前**判, 不做已知会迟到的提交): 每封都在
            # busy timeout 之前拿到锁时 ConvergeLockBusy 永远不抛, 但 seen_map 照样在
            # 变旧 —— 这道闸把陈旧窗口钉在常数量级, 不随 chunk 长度膨胀。跳过与被闸住的
            # 封不花时间, 故正常路径 (毫秒级) 永远碰不到它。
            if time.monotonic() - started > READ_RECONCILE_CHUNK_BUDGET_SEC:
                stats["lock_abort"] = True
                stats["abort_reason"] = "time_budget"
                logger.debug(
                    f"[read-reconcile] 本 chunk 收敛累计超 {READ_RECONCILE_CHUNK_BUDGET_SEC}s "
                    f"(锁竞争但每封都拿到了锁), 从 {internal_id} 起终止本轮, 下轮重判"
                )
                break
            # (a)+(b) 在途 intent 复核 + 本地 CAS 置已读 + notion 入队, 同一事务内完成:
            # 任一步不成立就整体回滚, 不会留下"本地已读但 Notion intent 缺失"的半提交
            # (那种半提交下轮不再进候选 → 永久漏 Notion 收敛)。
            try:
                ok = converge_local_read_atomic(
                    self.sync_store,
                    outbox,
                    internal_id,
                    expected_updated_at=snapshot_updated_at,
                    notion_payload={"is_read": True},
                    source="read_reconcile",
                    busy_timeout_sec=READ_RECONCILE_LOCK_TIMEOUT_SEC,
                )
            except ConvergeLockBusy:
                # 保守让路 + 立即终止本轮: 等过锁就说明这份 seen_map 已经旧了, 剩下的封
                # 下个 interval 会重新 FETCH 取新鲜真值再判 (收敛幂等, 不丢状态)。
                stats["locked"] += 1
                stats["lock_abort"] = True
                stats["abort_reason"] = "lock_timeout"
                logger.debug(
                    f"[read-reconcile] {internal_id} 写锁竞争 "
                    f"({READ_RECONCILE_LOCK_TIMEOUT_SEC}s 未获锁), 终止本轮, 下轮重判"
                )
                break
            except Exception as e:
                logger.warning(f"[read-reconcile] converge failed for {internal_id}: {e}")
                continue
            if ok:
                converged.append(internal_id)
            else:
                # 静默跳过会让"为什么这封没收敛"无从排查 —— 事务内的两道闸
                # (在途 intent / CAS 快照失配) 各自留一条可追溯的 debug 行。
                stats["busy"] += 1
                logger.debug(
                    f"[read-reconcile] {internal_id} 本轮被闸住 (在途 flag_sync "
                    f"intent 或期间被别处写过), 下轮重判"
                )
        return converged

    async def _process_kos_retry_queue(self) -> None:
        """6c: KOS 入库失败重试 (issue #59, MAILAGENT_KOS_RETRY_ENABLED 默认开)。

        生产实测 (2026-07-24): KOS 卡死 35 分钟 → producer 推送全部失败且 fire-and-
        forget 直接丢弃 → 101 封邮件 KOS 侧永久空洞 (+69 条图谱边挂不上), 只能手动
        bulk_ingest 找回。台账 (kos_ingest_log, v41) 落地后, 这里对 status='failed'
        且到期 (next_retry_at <= now) 的行做队列驱动补偿。

        形状**镜像 6b _process_llm_retry_queue** (llm_processing 是逐字对应的现成
        模板): 每 tick 一次轻量 SQLite 队列探测, 空即返; 有到期行才处理, 上限
        KOS_RETRY_BATCH_PER_TICK=3 (≈0.6/s, 与 KOS 50 req/15min 限流天然匹配;
        101 封积压约 3 分钟排干)。不新起 worker、不进 supervise 心跳。
        与 6b 的两点差异 (KOS 是外部服务, LLM 是本地):
          - R4 前置健康探活: 不可用 → 本 tick 整体跳过、不逐封试 (故障期逐封重试
            会把每行 retry_count 白烧到上限转 dead, 等于重试机制自废), 并进入
            kos_retry_interval_sec (默认 300s) 冷却 —— 不必每个 5s tick 都对着
            倒掉的 KOS 探活。探活结果落 sync_state kos.health.*。
          - 超限终态是台账自己的 'dead' (kos_ingest_log 内, 由 record_failure 判),
            与 email_outbox 的 dead_letter 告警体系完全解耦 (镜像 llm 的 gave_up
            不触发死信告警的纪律)。

        MAILAGENT_KOS_INGEST_ENABLED=false 时整段不激活 (链路字节级 inert)。
        SQLite 读与探活/重推的网络调用全部 to_thread / 已在 producer 内 to_thread。
        """
        if not getattr(settings, "mailagent_kos_ingest_enabled", False):
            return
        # 默认开 (D1 有意偏离"新功能默认关"惯例): 重试是纯补偿, 只重推本该推、且已
        # 因 put_page 覆盖写幂等的内容; ingest 总闸关着时整段不激活, 灰度价值≈0。
        if not getattr(settings, "kos_retry_enabled", True):
            return
        # 不健康冷却: 上次探活失败后 interval 内直接跳过 (连队列探测都省)
        now = time.monotonic()
        if self._kos_unhealthy_until is not None and now < self._kos_unhealthy_until:
            return

        from src.kos import ingest_log
        from src.kos.producer import (
            llm_labels_settled,
            make_bulk_kos_client,
            repush_stored_email_to_kos,
        )

        db_path = str(self.sync_store.db_path)
        try:
            ready = await asyncio.to_thread(
                ingest_log.claim_due_retries, db_path, KOS_RETRY_BATCH_PER_TICK
            )
            due_deferred = await asyncio.to_thread(
                ingest_log.claim_due_deferred, db_path, KOS_RETRY_BATCH_PER_TICK
            )
        except Exception as e:  # noqa: BLE001 — 补偿层, 绝不炸 watcher (镜像 6b)
            logger.warning(f"[kos-retry] queue probe failed: {e}")
            return
        if not ready and not due_deferred:
            return

        # deferred (等 LLM 标签) 行的就绪判定 —— 纯本地 SQLite, 不需要 client/探活。
        # 就绪 = llm_processing 终态 (success/gave_up) 或等待轮数达 DEFER_MAX_CHECKS
        # 兜底 (LLM dispatch 失败的孤例不能永久卡队); 未就绪 → bump 下轮再看
        # (retry_count 在 pending 行上 = 已检查轮数)。issue #64 Lane A。
        ready_deferred: List[int] = []
        if due_deferred:
            def _classify_deferred() -> List[int]:
                out: List[int] = []
                for iid, checks in due_deferred:
                    if (llm_labels_settled(db_path, iid)
                            or checks >= ingest_log.DEFER_MAX_CHECKS):
                        out.append(iid)
                    else:
                        ingest_log.bump_deferred(db_path, iid)
                return out

            try:
                ready_deferred = await asyncio.to_thread(_classify_deferred)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"[kos-retry] deferred classify failed: {e}")
        if not ready and not ready_deferred:
            return  # 本 tick 全是等标签 bump, 无网络工作 (不探活)
        client = make_bulk_kos_client()
        if not client.configured:
            logger.debug("[kos-retry] bulk client not configured, skip")
            return

        # R4 健康探活 (只在有到期行时发, 不给 KOS 发无谓请求)
        health_err = ""
        try:
            h = await asyncio.to_thread(client.health)
            healthy = isinstance(h, dict) and h.get("status") == "ok"
            if not healthy:
                health_err = f"health status={h.get('status') if isinstance(h, dict) else h!r}"
        except Exception as e:  # noqa: BLE001 — 探活失败 = 不健康, 不上抛
            healthy = False
            health_err = str(e)
        try:
            recovered = await asyncio.to_thread(
                ingest_log.record_health, db_path, healthy, health_err
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[kos-retry] record_health failed: {e}")
            recovered = False
        if not healthy:
            cooldown = max(1, int(getattr(settings, "kos_retry_interval_sec", 300)))
            self._kos_unhealthy_until = now + cooldown
            logger.warning(
                f"[kos-retry] KOS 不可用 ({health_err}), 跳过并冷却 {cooldown}s "
                f"(到期 {len(ready) + len(ready_deferred)} 封原地等待, "
                f"retry_count 不增长)"
            )
            return
        if recovered:
            logger.info("[kos-retry] KOS 已恢复, 积压将按 tick 逐批补偿")

        priority_floor = getattr(settings, "kos_ingest_priority_floor", "normal")
        require_labeled = bool(getattr(settings, "kos_require_labeled", False))
        logger.info(
            f"[kos-retry] processing {len(ready)} failed retry + "
            f"{len(ready_deferred)} label-ready deferred push(es)"
        )
        for iid in [*ready, *ready_deferred]:
            outcome = await repush_stored_email_to_kos(
                db_path, iid, client=client,
                priority_floor=priority_floor, require_labeled=require_labeled,
            )
            if outcome.failed:
                # 台账已按退避重排 / 转 dead; 本 tick 剩余的照常试 (batch 只有 3,
                # 真是 KOS 又倒了的话, 下个 tick 的探活会拦住并进入冷却)。
                logger.debug(
                    f"[kos-retry] internal_id={iid} still failing "
                    f"code={outcome.error_code}"
                )

    async def _reconcile_drafts(self):
        """草稿箱对账 (davmail-only, DRAFTS_SYNC_ENABLED)。

        backend.reconcile_drafts() 全量 UID 对账（草稿会被编辑/发送/删除，增量 marker
        只见新增不见消失）：新草稿 save_email(pending) 进主链路（_sync_single_email_v3
        的草稿分支只落本地，不进 Notion / LLM / 飞书）；已消失草稿走
        email_repo.delete_email_full（CASCADE 清 body / 附件 / FTS）。
        AppleScript fallback 模式无此方法 → 整段 noop。任何失败不影响主循环。
        """
        backend = self.backend
        if not hasattr(backend, "reconcile_drafts"):
            return
        try:
            to_add, to_delete = backend.reconcile_drafts()
        except Exception as e:
            logger.warning(f"[drafts] reconcile failed (main loop unaffected): {e}")
            return

        for email_meta in to_add:
            internal_id = email_meta.get('internal_id')
            try:
                if self.sync_store.get(internal_id):
                    continue
                payload = {
                    'internal_id': internal_id,
                    'message_id': email_meta.get('message_id'),
                    'subject': email_meta.get('subject', ''),
                    'sender': (
                        email_meta.get('sender')
                        or email_meta.get('sender_email', '')
                    ),
                    'sender_name': email_meta.get('sender_name', ''),
                    'date_received': email_meta.get('date_received', ''),
                    'mailbox': email_meta.get('mailbox', '草稿箱'),
                    # 草稿是自己写的，FLAGS 缺失时按已读处理（不该凸显未读）
                    'is_read': email_meta.get('is_read', True),
                    'is_flagged': email_meta.get('is_flagged', False),
                    'thread_id': email_meta.get('thread_id'),
                    'sync_status': 'pending',
                    'backend_origin': email_meta.get('backend_origin') or 'davmail',
                }
                if email_meta.get('imap_uid') is not None:
                    payload['imap_uid'] = email_meta.get('imap_uid')
                if email_meta.get('imap_uidvalidity') is not None:
                    payload['imap_uidvalidity'] = email_meta.get('imap_uidvalidity')
                # 草稿线程 linkage 透传 (D1 Bug A, reconcile_drafts 已解析/反查)
                for key in (
                    'draft_source_internal_id',
                    'draft_in_reply_to',
                    'draft_references',
                ):
                    if email_meta.get(key) is not None:
                        payload[key] = email_meta.get(key)
                self.sync_store.save_email(payload)
                logger.debug(f"[drafts] added draft {internal_id} (pending)")
            except Exception as e:
                logger.warning(f"[drafts] save new draft {internal_id} failed: {e}")

        for internal_id in to_delete:
            try:
                # 防御 (纵深): 删前复核该行是否仍是草稿。若已被 sync_store 的
                # Draft→Sent 提升为发件箱 (外部从草稿发送), 就不是"消失草稿"而是
                # 已发邮件 → 删了就丢数据。reconcile 是同步、与 merge 不交错, 正常
                # 路径 merge 先提升 mailbox 使其不进 to_delete; 这里兜底顺序竞态。
                row = self.sync_store.get(internal_id)
                if row is not None and row.get('mailbox') not in DRAFT_MAILBOX_LABELS:
                    logger.info(
                        f"[drafts] skip delete {internal_id}: mailbox="
                        f"{row.get('mailbox')!r} (promoted, sent from draft)"
                    )
                    continue
                self.email_repo.delete_email_full(internal_id)
                logger.info(f"[drafts] deleted vanished draft {internal_id}")
                # 让前端刷新列表/badge（events_bridge 对 email.synced 宽 invalidate）
                try:
                    from src.events.publisher import safe_publish
                    safe_publish(
                        "email.synced",
                        internal_id=internal_id,
                        data={"deleted": True},
                        source="new_watcher",
                    )
                except Exception:
                    pass
            except Exception as e:
                logger.warning(f"[drafts] delete draft {internal_id} failed: {e}")

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
        # in_reply_to (直接父邮件 message_id, KOS Thread 链接反查用)。只在非空时写 →
        # 线程首封 (无 In-Reply-To) 保持 NULL (forward-only 语义)。
        if getattr(email_obj, 'in_reply_to', None):
            patch['in_reply_to'] = email_obj.in_reply_to
        if patch:
            try:
                self.sync_store.update_after_fetch(internal_id, patch)
            except Exception as exc:
                logger.warning(
                    "Failed to persist parsed metadata for %s: %s", internal_id, exc
                )

    def _abort_after_fetch(
        self,
        internal_id: int,
        result: UpdateAfterFetchResult,
        context: str,
    ) -> bool:
        """判定 update_after_fetch 的结果, 需要中止本封邮件时返回 True.

        幽灵行事故 (2026-07-14): update_after_fetch 撞 message_id UNIQUE 时只
        logger.error + return False, 而三个写 message_id 的调用点都不看返回值 →
        冲突被吞 → 整条 UPDATE 回滚, 连 sender 都没写进去 → 下游读 SQLite 得
        sender='' → Notion 400 → 重试 → 每轮重试在 400 之前先把附件重传一遍
        (实测 image001_2.png → image001_3.png 递增)。所以中止必须发生在建 Notion
        页 / 传附件之前。

        DUPLICATE: 真身已 synced, 当前行是重复行 (sync_store 已物理删除幽灵行 +
            CASCADE body/attachment/outbox) → 中止本封即可, **不能**再 mark_failed_v3
            (行已不存在, 且会凭空重建一条 failed 行拉回重试队列)。
        FAILED: 真失败 (DB 错误 / 冲突但无法判定真身) → mark_failed_v3 走既有退避 +
            死信, 不静默吞。

        放在这里而不是每个调用点 inline: 正向 sync + 两条 retry 路径共三个调用点,
        语义必须一致 (同 _persist_email_metadata_after_parse 的理由)。
        """
        if result is UpdateAfterFetchResult.DUPLICATE:
            self._stats["emails_skipped"] += 1
            logger.info(
                f"Duplicate row resolved, aborting sync ({context}): "
                f"internal_id={internal_id} (see sync_store log for the twin)"
            )
            return True

        if result is UpdateAfterFetchResult.FAILED:
            self.sync_store.mark_failed_v3(
                internal_id,
                f"update_after_fetch failed ({context}); see sync_store log",
            )
            return True

        return False

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
            #    davmail 模式是网络 IMAP fetch（阻塞）—— 经单线程 backend-io executor
            #    移出事件循环线程且保序, 一封慢邮件不再卡住 fanout/reverse/island 的 tick。
            full_email = await run_backend_io(self.backend.fetch_email_content_by_id, internal_id, mailbox)
            if not full_email:
                backend_name = type(self.backend).__name__
                logger.warning(f"Failed to fetch email content by id {internal_id} (backend={backend_name})")
                self.sync_store.mark_fetch_failed(internal_id, f"fetch_email_content_by_id returned None (backend={backend_name})")
                return

            # 2. AppleScript 成功，更新 SyncStore 元数据（填充 message_id、thread_id）
            message_id = full_email.get('message_id')
            thread_id = full_email.get('thread_id')

            fetch_result = self.sync_store.update_after_fetch(internal_id, {
                'message_id': message_id,
                'thread_id': thread_id,
                'subject': full_email.get('subject'),
                'sender': full_email.get('sender')
            })
            # message_id 撞 UNIQUE 必须在这里终结 (见 _abort_after_fetch):
            # 重复行继续往下走 = 每轮重试都往 Notion 重传一遍附件。
            if self._abort_after_fetch(internal_id, fetch_result, "sync"):
                return

            # 2.5 草稿箱分支: 仅落本地 (SQLite body + FTS), 不进 Notion / 会议检测 /
            # LLM / 飞书 / KOS, 也不做日期过滤 (草稿无论多老都保留 — reconcile 全量
            # 对账要求本地数量与 Exchange Drafts 一致)。正文依赖 dual-write
            # (BODY_DUAL_WRITE_ENABLED, 默认开); 关闭时草稿详情无正文但列表/数量正常。
            if is_drafts_mailbox(mailbox):
                draft_obj = await self._build_email_object(full_email, mailbox)
                if not draft_obj:
                    logger.error(f"Failed to build Email object for draft: {internal_id}")
                    self.sync_store.mark_failed_v3(internal_id, "Failed to build Email object")
                    return
                draft_obj.internal_id = internal_id
                self._persist_email_metadata_after_parse(internal_id, draft_obj)
                self._maybe_dual_write_body(draft_obj, internal_id, full_email.get("source"))
                self.sync_store.mark_synced_local(internal_id)
                self._stats["emails_synced"] += 1
                logger.info(f"Draft {internal_id} synced (local-only)")
                return

            # 3. 检测并处理会议邀请
            source = full_email.get('source', '')
            meeting_invite = None
            if self.meeting_sync.has_meeting_invite(source):
                calendar_page_id, meeting_invite = await self.meeting_sync.process_email(source, message_id)
                # 阶段 2.1 (P1-3): 邮件 ↔ 日历 ical_uid 映射落 email_meeting,
                # 供「邮件详情 → 查看日程」/「drawer → 来源邀请邮件」双向反查。
                # 只要解析出 invite 就写 (与 Notion sync 成败无关 — 映射表达的是
                # "这封邮件携带该 uid" 这一事实)。
                if meeting_invite is not None and meeting_invite.uid:
                    self.sync_store.upsert_email_meeting(
                        internal_id,
                        ical_uid=meeting_invite.uid,
                        method=(meeting_invite.method or "REQUEST").upper(),
                        recurrence_id=(
                            meeting_invite.recurrence_id.isoformat()
                            if meeting_invite.recurrence_id else None
                        ),
                        sequence=meeting_invite.sequence,
                        is_recurring=bool(meeting_invite.recurrence_rule),
                    )
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
            # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md
            # 失败仅 warning，主流程继续走 Notion sync
            self._maybe_dual_write_body(email_obj, internal_id, full_email.get("source"))

            # 5.7 Notion 可选化（task 07-12 P3b 方案 C）：未配置 NOTION_TOKEN/
            # EMAIL_DATABASE_ID 时跳过 Notion 页创建，邮件走 mark_synced_local
            # （草稿箱先例：synced + notion_page_id=NULL），5 个事件钩子以 page_id=""
            # 照常派发（岛/KOS/feishu 对空 page_id 已容忍；周报钩子在
            # _progress_hook_active 里被 notion_enabled 再门掉——它本身写 Notion 库）。
            # enabled 路径（下方 步骤6-12）一字不动 —— 本分支是纯新增，存量
            # （三键非空）行为零漂移。
            if not notion_enabled():
                self.sync_store.mark_synced_local(internal_id)
                self._stats["emails_synced"] += 1
                logger.info(f"Email synced (local-only, Notion disabled): {internal_id}")
                self._maybe_trigger_project_progress_hook(email_obj, internal_id, "")
                self._maybe_trigger_llm_hook(email_obj, internal_id, "")
                self._maybe_trigger_kos_hook(email_obj, internal_id, "")
                self._maybe_dispatch_island_received(email_obj, internal_id, "")
                self._maybe_trigger_custom_agents(email_obj, internal_id)
                return

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

                # 12. Custom Agent email_filter 触发钩子（S4，非阻塞，默认关）
                self._maybe_trigger_custom_agents(email_obj, internal_id)
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
        - 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md

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

    def _track_bg_task(self, task) -> None:
        """持有 fire-and-forget hook task 的强引用 (task 06-10, prd Fix 2d).

        Python 3.11 asyncio loop 只弱引用 task — 无强引用的 pending task 可能
        被 GC 中途回收 (生产实证: start() 里 _rollout_flush_task 注释记录的同
        类 bug)。完成后 done_callback 自动 discard, 集合大小 = 当前 in-flight
        hook 数 (可观测)。部分测试用 NewWatcher.__new__ 构造不走 __init__ →
        lazy init 防 AttributeError。
        """
        tasks = getattr(self, "_bg_tasks", None)
        if tasks is None:
            tasks = set()
            self._bg_tasks = tasks
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    def _maybe_trigger_project_progress_hook(
        self, email_obj: Email, internal_id: int, notion_page_id: str
    ) -> None:
        """若该邮件匹配项目周报规则，派发后台任务跑外挂同步（S5 W5a 行内热读）。

        运行判定 = env 总闸 PROJECT_PROGRESS_SYNC_ENABLED（+database_id，__init__ gate）AND
        行 enabled AND ProjectProgressDetector.is_match。触发配置每封邮件从 report_agent 的
        project_progress 行热读（Settings 改即生效）；行不存在（老库未跑 v31）→ 回退 env 构造。
        runner 逐字不变、执行仍 fire-and-forget 直调（不进 async_jobs / gateway）。
        任何失败只打 warning，不影响主同步流程。
        """
        if not getattr(self, "_progress_hook_active", False):
            return
        try:
            from src.project_progress.agent_config import get_project_progress_agent_config
            from src.project_progress.detector import ProjectProgressDetector

            cfg = get_project_progress_agent_config(self._agent_db_path)
            if cfg.row_exists:
                if not cfg.enabled:
                    return
                detector = ProjectProgressDetector(
                    sender=cfg.sender, subject_pattern=cfg.subject_pattern
                )
            else:
                # 老库未跑 v31 迁移 → 回退 env 构造（行为等价窗口）。
                if not getattr(settings, "project_progress_auto_sync_enabled", False):
                    return
                detector = ProjectProgressDetector(
                    sender=settings.project_progress_sender,
                    subject_pattern=settings.project_progress_subject_pattern,
                )
            if not detector.is_match(sender=email_obj.sender, subject=email_obj.subject):
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

            self._track_bg_task(asyncio.create_task(_bg()))
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

            self._track_bg_task(asyncio.create_task(_bg()))
        except Exception as e:
            logger.warning(f"[llm-hook] dispatch failed: {e}")

    def _maybe_trigger_custom_agents(self, email_obj: Email, internal_id: int) -> None:
        """若启用 Custom Agent，匹配 email_filter 规则并派发后台 run（S4，ADR D5）。

        主循环只做 flag + 存在性检查（不解析/编译 trigger 正则）；正则匹配 + enqueue 移出
        当封邮件的内联处理路径（放后台 task）。任何失败只 warning。
        注意：bg task 仍跑在同一 asyncio 事件循环（create_task 不换线程、re 匹配持 GIL），
        owner 若配 catastrophic pattern 仍会卡循环——ReDoS 防线是 pattern≤256 + 输入截断 512
        + owner 配置（非攻击者），不是这层 task 隔离。
        """
        if not self._custom_agents_enabled or self._agent_store is None:
            return
        try:
            # 廉价存在性检查：有无 enabled 的 type='custom' 行（不碰正则）。
            candidates = [
                a for a in self._agent_store.list_agents()
                if a.get("enabled") and a.get("type") == "custom"
            ]
            if not candidates:
                return
            sender = getattr(email_obj, "sender", None)
            subject = getattr(email_obj, "subject", None)
            mailbox = getattr(email_obj, "mailbox", None)
            repo = self._agent_job_repo

            async def _bg():
                try:
                    from src.agents.email_dispatch import dispatch_email_agents
                    dispatch_email_agents(
                        candidates,
                        sender=sender,
                        subject=subject,
                        mailbox=mailbox,
                        internal_id=internal_id,
                        repo=repo,
                    )
                except Exception as e:
                    logger.warning(f"[custom-agent] background dispatch failed: {e}")

            self._track_bg_task(asyncio.create_task(_bg()))
        except Exception as e:
            logger.warning(f"[custom-agent] dispatch failed: {e}")

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
            from src.kos.producer import push_email_to_kos, resolve_thread_refs

            # 完整 AI labels (llm_processing.labels_json) + body + 附件 — 增量入图
            # 跟 bulk historical ingest 形态一致 (category/ai_summary/key_points 都带)
            priority_floor = getattr(settings, "kos_ingest_priority_floor", "normal")
            require_labeled = bool(getattr(settings, "kos_require_labeled", False))
            dry_run = getattr(settings, "kos_ingest_dry_run", False)

            # issue #64 Lane A: 本 hook 与步骤 9 的 LLM hook 同为 fire-and-forget,
            # 曾在 LLM 后台任务写完 labels **之前**就同步读 LLMProcessingStore →
            # 100% 读空 (实测 83/83 封 pushed_at 平均早于 llm_processing.updated_at
            # 911s): priority floor 恒按 normal 放行 (23 封 ⚪低 误入库)、增量页面
            # 无 AI 标签、KOS_REQUIRE_LABELED 一开即全 skipped。修法 = 会跑 LLM 的
            # 邮件不在此刻推, 落台账 status='pending' 排队 (record_deferred), 由
            # 6c _process_kos_retry_queue 在 llm_processing 终态 (success/gave_up)
            # 或 DEFER_MAX_CHECKS 兜底后用 repush_stored_email_to_kos 从 SQLite
            # SSoT 重建 payload 首推 —— floor/require_labeled 在标签就位后才第一次
            # 真正生效, 主同步路径反而少了几次 SQLite 读 (fetch 块整个跳过)。
            # 不会跑 LLM 的路径 (LLM 未启用 / FOLDER_LLM_DISABLED) 走下方直推,
            # labels 空是事实而非 race; kos_retry_enabled=false (6c 应急关, defer
            # 无消费者会永久卡队) 或 dry_run (defer 后 repush 是真推) 同样保持
            # 直推老行为 —— 即整套 defer 的应急回退 = MAILAGENT_KOS_RETRY_ENABLED=false。
            mailbox = getattr(email_obj, "mailbox", "") or ""
            will_run_llm = (
                self._llm_runner is not None
                and not should_skip_llm_for_folder(
                    mailbox, getattr(self, "_folder_llm_disabled", frozenset())
                )
            )
            if (will_run_llm and not dry_run
                    and getattr(settings, "kos_retry_enabled", True)):
                from src.kos import ingest_log

                db_path = str(self.sync_store.db_path)
                logger.debug(
                    f"[kos-hook] deferring internal_id={internal_id} until LLM "
                    f"labels settle (status='pending' in kos_ingest_log)"
                )

                async def _bg_defer():
                    # 入队失败 (台账写锁 5s 超时等) 只 warning: 后果 = 这封不进
                    # KOS 队列 (与修复前 fire-and-forget 丢失同级), 日志可见 +
                    # bulk_ingest 补漏可捞, 不为极低概率路径加直推回退分支。
                    try:
                        await asyncio.to_thread(
                            ingest_log.record_deferred, db_path, internal_id,
                            f"sources/email/{internal_id}", "producer",
                        )
                    except Exception as e:
                        logger.warning(
                            f"[kos-hook] defer enqueue failed "
                            f"internal_id={internal_id}: {e}"
                        )

                self._track_bg_task(asyncio.create_task(_bg_defer()))
                return

            labels: Optional[dict] = None
            body_markdown: Optional[str] = None
            attachments: Optional[list] = None
            thread_parent = None
            thread_root = None
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
                # Thread 链接反查 (parent=In-Reply-To, root=thread_id) — 行已落库
                # (save_email + _persist_email_metadata_after_parse 在 hook 前跑)。
                # 与 bulk_ingest 共用同一 SQLite 反查 → 两路径 payload 一致。
                refs = resolve_thread_refs(str(self.sync_store.db_path), internal_id)
                thread_parent = refs.get("parent")
                thread_root = refs.get("root")
            except Exception as e:
                # warning 而非 debug (issue #64 Lane A): 这里吞掉的异常曾让孤例
                # internal_id=1000010856 (4 附件) 既无 llm_processing 行也无台账行
                # 且日志零线索 —— fetch 失败虽不阻断推送 (labels/body 缺省 None),
                # 但必须在默认日志级别可见。
                logger.warning(
                    f"[kos-hook] labels/body/attachments/thread fetch failed "
                    f"internal_id={internal_id}: {e}"
                )

            subject_preview = (getattr(email_obj, "subject", "") or "")[:60]
            logger.debug(
                f"[kos-hook] dispatching internal_id={internal_id} "
                f"priority={(labels or {}).get('priority')!r} floor={priority_floor!r} "
                f"require_labeled={require_labeled} "
                f"subject={subject_preview!r}"
            )

            async def _bg():
                try:
                    outcome = await push_email_to_kos(
                        email_obj,
                        internal_id,
                        body_markdown=body_markdown,
                        notion_page_id=notion_page_id,
                        labels=labels,
                        attachments=attachments,
                        thread_parent=thread_parent,
                        thread_root=thread_root,
                        priority_floor=priority_floor,
                        require_labeled=require_labeled,
                        dry_run=dry_run,
                        db_path=str(self.sync_store.db_path),
                    )
                    # issue #59: 失败与跳过必须分级 —— 老实现两者都返 None 一律记
                    # debug "skipped", 101 页空洞在日志层面伪装成正常跳过。
                    if outcome.failed:
                        logger.warning(
                            f"[kos-hook] push FAILED internal_id={internal_id} "
                            f"code={outcome.error_code} (已记台账, 瞬时错误由重试"
                            f"扫描补偿): {outcome.error}"
                        )
                    elif outcome.skipped:
                        logger.debug(
                            f"[kos-hook] skipped internal_id={internal_id} "
                            f"({outcome.reason})"
                        )
                except Exception as e:
                    logger.warning(
                        f"[kos-hook] background task failed internal_id={internal_id}: {e}"
                    )

            self._track_bg_task(asyncio.create_task(_bg()))
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
            if is_sent_mailbox(mailbox):
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
                # in_reply_to: 优先 backend 归一化值 (davmail _normalize_message_id),
                # backend 未提供 (applescript full_email 无此键) 时保留 parse_email_source
                # 从 MIME 解析的值。
                email_obj.in_reply_to = full_email.get('in_reply_to') or email_obj.in_reply_to

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
                    full_email = await run_backend_io(self.backend.fetch_email_content_by_id, internal_id, mailbox)

                    if not full_email:
                        backend_name = type(self.backend).__name__
                        logger.warning(f"Retry fetch failed for {internal_id} (backend={backend_name})")
                        self.sync_store.mark_fetch_failed(internal_id, f"fetch_email_content_by_id returned None on retry (backend={backend_name})")
                        continue

                    # 获取成功，更新元数据
                    message_id = full_email.get('message_id')
                    thread_id = full_email.get('thread_id')
                    fetch_result = self.sync_store.update_after_fetch(internal_id, {
                        'message_id': message_id,
                        'thread_id': thread_id,
                        'subject': full_email.get('subject'),
                        'sender': full_email.get('sender')
                    })
                    if self._abort_after_fetch(internal_id, fetch_result, "retry"):
                        continue

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
                        full_email = await run_backend_io(self.backend.fetch_email_content_by_id, internal_id, mailbox)
                        if not full_email:
                            self.sync_store.mark_fetch_failed(internal_id, "Cannot refetch for retry")
                            continue
                        message_id = full_email.get('message_id')
                        fetch_result = self.sync_store.update_after_fetch(internal_id, {
                            'message_id': message_id,
                            'thread_id': full_email.get('thread_id'),
                            'subject': full_email.get('subject'),
                            'sender': full_email.get('sender')
                        })
                        if self._abort_after_fetch(internal_id, fetch_result, "retry"):
                            continue
                    else:
                        # 有 message_id，通过 internal_id 重新获取
                        full_email = await run_backend_io(self.backend.fetch_email_content_by_id, internal_id, mailbox)
                        if not full_email:
                            self.sync_store.mark_fetch_failed(internal_id, "Cannot refetch for retry")
                            continue

                        # 幽灵行常态: 带假 @localhost message_id(非 NULL)恰落本分支。refetch
                        # 拿回真实 message_id 写回 → 撞真身 UNIQUE → 必须走冲突 guard 终结,
                        # 否则每轮读空 sender → Notion 400 → 先灌一遍重复附件。与另两个 refetch
                        # 分支语义一致 (见 _abort_after_fetch docstring: 三入口必须一致)。
                        message_id = full_email.get('message_id')
                        fetch_result = self.sync_store.update_after_fetch(internal_id, {
                            'message_id': message_id,
                            'thread_id': full_email.get('thread_id'),
                            'subject': full_email.get('subject'),
                            'sender': full_email.get('sender')
                        })
                        if self._abort_after_fetch(internal_id, fetch_result, "retry"):
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

                # 草稿箱分支 (与 _sync_single_email_v3 的 2.5 一致): 仅落本地,
                # 不进 Notion — retry 路径不能绕过草稿 gate。
                if is_drafts_mailbox(mailbox):
                    self._maybe_dual_write_body(
                        email_obj, internal_id, full_email.get("source")
                    )
                    self.sync_store.mark_synced_local(internal_id)
                    self._stats["retries_succeeded"] += 1
                    self._stats["emails_synced"] += 1
                    logger.info(f"Retry succeeded (draft, local-only): {internal_id}")
                    continue

                # v4: 双写邮件正文 + 附件到 SQLite（重试路径同样需要双写）
                self._maybe_dual_write_body(
                    email_obj, internal_id, full_email.get("source")
                )

                # Notion 可选化（与 _sync_single_email_v3 5.7 一致）: disabled 时
                # 本地-only synced, 不再产生 failed/dead_letter。retry 路径与
                # enabled 主路径同样不派发事件钩子（现状 parity）。
                if not notion_enabled():
                    self.sync_store.mark_synced_local(internal_id)
                    self._stats["retries_succeeded"] += 1
                    self._stats["emails_synced"] += 1
                    logger.info(f"Retry succeeded (local-only, Notion disabled): {internal_id}")
                    continue

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
            "last_max_row_id": self.backend.get_last_max_row_id(),
            "available": self.backend.is_available()
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
