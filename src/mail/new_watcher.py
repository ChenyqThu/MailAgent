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
import sqlite3
import time
from datetime import datetime
from typing import List, Dict, Optional, Any
from loguru import logger

from src.config import config as settings
from src.config import notion_enabled
from src.models import Email
from src.mail.sync_store import (
    SyncStore,
    UpdateAfterFetchResult,
)
from src.notion.sync import NotionSync
from src.mail.reader import EmailReader
from src.mail.meeting_sync import MeetingInviteSync
from src.repository import (
    AttachmentStore,
    EmailRepository,
)
from src.mail.backend.base import MarkerUnavailableError
from src.mail.backend.imap_client import parse_folder_csv_or_json
from src.mail.backend.serial_executor import run_backend_io
from src.mail.ingest_provenance import should_suppress_reconcile_notify
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
from src.mail.new_watcher_hooks import (  # noqa: F401
    _NewWatcherHooksMixin,
    should_skip_feishu_for_folder,
    should_skip_llm_for_folder,
)
from src.mail.new_watcher_reconcile import (  # noqa: F401
    _NewWatcherReconcileMixin,
    _publish_email_new,
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


def _fire_contact_governance_if_due(db_path: str, day: str) -> bool:
    """sync_state 判 due → 事务外 enqueue → 成功后写当天 marker。"""
    from src.contacts.governance import (
        CONTACT_GOVERNANCE_FIRE_KEY,
        enqueue_governance_job,
    )
    from src.sync.async_jobs import AsyncJobRepository

    conn = sqlite3.connect(db_path, timeout=30.0)
    try:
        row = conn.execute(
            "SELECT value FROM sync_state WHERE key=?", (CONTACT_GOVERNANCE_FIRE_KEY,)
        ).fetchone()
        if row is not None and str(row[0]) == day:
            return False
    finally:
        conn.close()
    enqueue_governance_job(
        AsyncJobRepository(db_path),
        trigger_kind="schedule",
        idempotency_key=f"contact_governance:daily:{day}",
    )
    conn = sqlite3.connect(db_path, timeout=30.0)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?,?,?)",
            (CONTACT_GOVERNANCE_FIRE_KEY, day, time.time()),
        )
        conn.commit()
    finally:
        conn.close()
    return True


def _parse_sync_start_date() -> Optional[datetime]:
    """解析同步起始日期配置

    用于缓存预热后的场景：历史邮件在 SyncStore 中（用于 Parent Item 查找），
    但只同步 SYNC_START_DATE 之后的邮件到 Notion。

    如果未配置或配置为空，则不过滤日期（正常启动后只同步新邮件）。

    ⚠️ 实现下沉到 ``src.config.parse_sync_start_date`` —— 设置页「同步历史邮件」要把
    这个 Notion 日期地板显示给用户，两处各解析一份迟早对不上（界面承诺的日期与实际
    入库行为分裂）。本函数保留为 watcher 侧的既有名字。

    Returns:
        同步起始日期（带时区），早于此日期的邮件不同步到 Notion
    """
    from src.config import parse_sync_start_date

    return parse_sync_start_date(settings)


class NewWatcher(_NewWatcherHooksMixin, _NewWatcherReconcileMixin):
    """新架构邮件同步监听器"""

    def _notion_date_floor(self) -> Optional[datetime]:
        """Notion 日期地板，**每次判定都重算**。

        relative 模式下它是滚动日期（今天 − SYNC_LOOKBACK_DAYS）：快照到 __init__ 的话，
        长跑进程会一直用启动那天的地板，跨天后越判越松。
        """
        return _parse_sync_start_date()

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

        # Notion 日期地板：这里只打一行启动日志，判定一律走 self._notion_date_floor()
        # —— relative 模式是滚动日期，快照到 __init__ 会让长跑进程一直用启动那天的地板。
        _floor = _parse_sync_start_date()
        if _floor:
            logger.info(f"Notion date floor: {_floor.strftime('%Y-%m-%d')} (mode={settings.sync_date_mode}, emails before it are cached but not synced to Notion)")

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
        #
        # 🔴 v62 起这两个 frozenset 是**回退路径**，不再是运行时权威。权威是
        # folder_pref 行，由 _skip_llm_for_folder / _skip_feishu_for_folder 每封邮件
        # 现读（Settings 里点一下开关，下一封邮件即生效，不必重启 mail-sync）——
        # 这两个 frozenset 在 __init__ 冻结正是"改开关要重启"的根因。env 键降级为
        # 首次 seed（v62 迁移）+ 没有 pref 行时的回退，仍照 .env.example 的语义生效。
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
        self._last_inbox_reconcile_at: Optional[float] = None
        # 通讯录 L0+L1 提取扫描 (task 08-13) 的独立低频节拍游标, 同上解耦 5s poll。
        self._last_contact_extract_at: Optional[float] = None
        # 通讯录日历第三源 (task 08-24 #4) 的节拍游标 —— 与上面那条是两条独立节拍。
        self._last_contact_calendar_scan_at: Optional[float] = None
        self._last_contact_governance_check_at: Optional[float] = None
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
        # 水位格式版本（目前只有 outlook_com 声明）：库里记的版本与 backend 不一致 = 旧代码写的
        # 水位，按 backend 的规则换算一次再用；首次运行定基线时直接盖上当前版本。
        marker_format = getattr(self.backend, "MARKER_FORMAT", None)
        if self.sync_store.has_last_max_row_id():
            last_max_row_id = self.sync_store.get_last_max_row_id()
            if (
                marker_format
                and last_max_row_id > 0
                and self.sync_store.get_state('marker_format') != marker_format
            ):
                upgraded = self.backend.upgrade_marker(last_max_row_id)
                logger.warning(
                    f"[marker-format] 旧格式水位 {last_max_row_id} → {upgraded} "
                    f"(backend={current_backend!r}, format={marker_format})"
                )
                last_max_row_id = upgraded
                self.sync_store.set_last_max_row_id(upgraded)
                self.sync_store.set_state('marker_format', marker_format)
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
            if marker_format:
                self.sync_store.set_state('marker_format', marker_format)
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
                # IMAP 恢复即自愈。
                #
                # 🔴 2026-08-11 事故后收窄「合法返空」的定义 (B1′):
                # 只有 backend **明确报告 OK + 空结果**才算合法空成功 (照常推进 —
                # UIDNEXT 差值会因删信等原因高估, 空成功不推进会把游标卡死);
                # SELECT/SEARCH/FETCH 非 OK、批量解析少项、internal_id 分配失败
                # 现在一律 raise FolderFetchError (不再静默 return []), 走下面的
                # `new_emails = None` 分支守住游标。见 backend.base.FolderFetchError。
                try:
                    new_emails = self.backend.get_new_emails(last_max_row_id)
                except Exception as e:
                    logger.error(
                        f"get_new_emails failed, cursor NOT advanced — window "
                        f"({last_max_row_id}, {current_max}] retried next poll: {e}"
                    )
                    new_emails = None

                # B2 留痕: STATUS 说有新邮件、实际一封没取到 —— 多数是良性的
                # (UIDNEXT 被删信/其他原因推高而 SEARCH 无匹配), 但这**曾经是**
                # 丢邮件的静默现场, 必须可观测而不是完全无声。
                if new_emails is not None and not new_emails and estimated_count > 0:
                    self._record_empty_fetch_gap(last_max_row_id, current_max,
                                                 estimated_count)

                # 任一封写库失败 → 本轮不推进游标 (失败那封会随游标推进永久出窗)。
                save_failed = False
                # 本轮真正新建的行 → 聚合一条 email.new (见 _publish_email_new)。
                saved_new_rows: List[tuple] = []

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
                        # outlook_com: EntryID 是取正文的快路径 (GetItemFromID); 不透传就只能
                        # 按 message_id 反查, 反查落空时这封永远取不到正文。
                        if email_meta.get('entry_id'):
                            payload['entry_id'] = email_meta['entry_id']

                        if not self.sync_store.save_email(payload):
                            # 写库失败若被忽略, 这封会随下面的游标推进永久出窗
                            # (与 get_new_emails 失败同等严重, 故同等处理)。
                            save_failed = True
                            logger.error(
                                f"save_email failed for internal_id={internal_id} "
                                f"(msgid={email_meta.get('message_id')!r}, "
                                f"imap_uid={email_meta.get('imap_uid')}) — cursor "
                                f"NOT advanced, window retried next poll"
                            )
                            continue
                        saved_new_rows.append((internal_id, payload['mailbox']))
                        logger.debug(
                            f"Added email {internal_id} to SyncStore "
                            f"(pending, origin={backend_origin or 'applescript'}, "
                            f"imap_uid={email_meta.get('imap_uid')})"
                        )

                # 新邮件入库即广播 (email.new): 失败与否不影响游标语义, 只是失效 hint。
                _publish_email_new(saved_new_rows)

                # 4. 更新 last_max_row_id（立即持久化）— 仅成功 (含**合法**空成功) 时推进;
                # None = get_new_emails 失败 (含 FolderFetchError), save_failed = 有邮件
                # 没写进库 —— 两者都把游标留在原位等下轮重试。
                if new_emails is not None and not save_failed:
                    # outlook_com 单轮被 MAX_BATCH 截断时只推进到已取到的最后一封, 剩余下轮取
                    advance_to = (
                        self.backend.marker_after_fetch(current_max)
                        if hasattr(self.backend, "marker_after_fetch")
                        else current_max
                    )
                    self.sync_store.set_last_max_row_id(advance_to)
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

        # 9. 收件箱对账兜底 (2026-08-11 丢邮件事故, davmail-only, 默认关) —
        # 同样是独立低频节拍。放在 pending 处理之后: 本轮补抓的行会由下一轮
        # (或本轮之后的 tick) 的 _process_pending_emails 抓正文。
        await self._reconcile_inbox()

        # 10. 通讯录 L0+L1 提取扫描 (task 08-13 WP1, 默认关) — 独立低频节拍,
        # 纯本地 SQLite (零 IMAP 命令), 消化 email_metadata → 通讯录三表。
        await self._extract_contacts()
        # 10b. 通讯录日历第三源 (task 08-24 #4) — 又一条独立低频节拍, 纯本地 SQLite
        # (读 calendar_event, 零 CalDAV 调用)。
        await self._scan_calendar_contacts()
        await self._contact_governance_tick()

    async def _contact_governance_tick(self):
        """每日一次治理扫描 enqueue；按行级 enabled 与时刻触发。"""
        now = time.monotonic()
        last = self._last_contact_governance_check_at
        if last is not None and now - last < 300:
            return
        self._last_contact_governance_check_at = now
        try:
            from src.contacts.governance_config import get_contact_governance_agent_config

            cfg = await asyncio.to_thread(
                get_contact_governance_agent_config, str(self.sync_store.db_path)
            )
            if not cfg.row_exists or not cfg.enabled:
                return
            local_now = datetime.now().astimezone()
            if local_now.hour < cfg.fire_hour:
                return
            day = local_now.date().isoformat()
            fired = await asyncio.to_thread(
                _fire_contact_governance_if_due, str(self.sync_store.db_path), day
            )
            if fired:
                logger.info(f"[contact-governance] daily scan queued day={day}")
        except Exception as exc:
            logger.warning(f"[contact-governance] daily tick failed: {exc}")

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

            # Local storage is independent of the Notion mirror's date window.
            # Keep the existing dual-write flag/failure policy; do not fetch more history.
            self._maybe_dual_write_body(email_obj, internal_id, full_email.get("source"))

            # 5. 日期过滤：早于 Notion 日期地板的邮件不同步到 Notion
            date_floor = self._notion_date_floor()
            if date_floor and email_obj.date:
                email_date = email_obj.date
                if email_date.tzinfo is None:
                    # 裸日期 (Date 头写 -0000 = 无时区信息) 按本机本地时区读 —— 地板也是
                    # 本地午夜, 两边同一个时间系才不会在边界上互相错开。
                    email_date = email_date.astimezone()

                if email_date < date_floor:
                    logger.info(f"Skipping old email: {email_date.strftime('%Y-%m-%d')} < {date_floor.strftime('%Y-%m-%d')}")
                    self.sync_store.mark_skipped(internal_id, reason="notion_date_filter")
                    self._stats["emails_skipped"] += 1
                    return

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
                await self._dispatch_post_sync_hooks(email_obj, internal_id, "")
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

                # 8-12. 后续钩子
                await self._dispatch_post_sync_hooks(email_obj, internal_id, page_id)
            else:
                self.sync_store.mark_failed_v3(internal_id, "Notion sync returned None")

        except Exception as e:
            logger.error(f"Failed to sync email {internal_id}: {e}")
            self.sync_store.mark_failed_v3(internal_id, str(e))
            self._stats["errors"] += 1

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
                # 本地-only synced, 不再产生 failed/dead_letter。
                if not notion_enabled():
                    self.sync_store.mark_synced_local(internal_id)
                    self._stats["retries_succeeded"] += 1
                    self._stats["emails_synced"] += 1
                    logger.info(f"Retry succeeded (local-only, Notion disabled): {internal_id}")
                    await self._dispatch_post_sync_hooks(email_obj, internal_id, "")
                    continue

                # 同步到 Notion
                page_id = await self.notion_sync.create_email_page_v2(email_obj)

                if page_id:
                    self.sync_store.mark_synced_v3(internal_id, page_id)
                    self._stats["retries_succeeded"] += 1
                    self._stats["emails_synced"] += 1
                    logger.info(f"Retry succeeded: {internal_id} -> {page_id}")
                    await self._dispatch_post_sync_hooks(email_obj, internal_id, page_id)
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

    def _suppress_reconcile_notify(self, internal_id: int) -> bool:
        """对账补抓的老邮件不推飞书 (E) —— 判定走 ingest_provenance 单源。

        🔴 三个通知入口 (本方法 / handlers.handle_ai_reviewed / reverse_sync._try_notify)
        共用同一判据, 不许各写一份: service.py 会按配置在后两者之间切换, 只堵一个
        入口 = 换个配置就漏。
        """
        return should_suppress_reconcile_notify(
            self.sync_store,
            internal_id,
            int(getattr(settings, "reconcile_notify_max_age_sec", 7200) or 0),
        )



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
