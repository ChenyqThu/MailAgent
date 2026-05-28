from pydantic_settings import BaseSettings
from pydantic import Field, ConfigDict

class Config(BaseSettings):
    """配置类"""

    model_config = ConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Notion 配置
    notion_token: str = Field(..., env="NOTION_TOKEN")
    email_database_id: str = Field(..., env="EMAIL_DATABASE_ID")

    # 用户配置
    user_email: str = Field(..., env="USER_EMAIL")
    mail_account_name: str = Field(default="Exchange", env="MAIL_ACCOUNT_NAME")
    mail_account_url_prefix: str = Field(default="ews://", env="MAIL_ACCOUNT_URL_PREFIX", description="SQLite 账户 URL 前缀过滤（如 ews:// 只匹配 Exchange）")
    mail_inbox_name: str = Field(default="收件箱", env="MAIL_INBOX_NAME")

    # 日志配置
    log_level: str = Field(default="INFO", env="LOG_LEVEL")
    log_file: str = Field(default="logs/sync.log", env="LOG_FILE")

    # 附件配置
    max_attachment_size: int = Field(default=20971520, env="MAX_ATTACHMENT_SIZE")  # 20MB (Notion limit)

    # v4: SQLite SSoT 配置（邮件正文 + 附件元数据进 SQLite，详见 docs/architecture_v4_sqlite_ssot.md）
    body_dual_write_enabled: bool = Field(
        default=True, env="BODY_DUAL_WRITE_ENABLED",
        description="是否在 Notion sync 前把邮件正文 + 附件双写到 SQLite（v4 架构）。失败仅 warning，不阻断主流程"
    )
    attachment_storage_dir: str = Field(
        default="data/attachments", env="ATTACHMENT_STORAGE_DIR",
        description="附件本地落盘目录（按 internal_id 分子目录），与 sync_store.db 同 data/ 便于统一备份"
    )

    # 日历同步配置
    calendar_database_id: str = Field(default="", env="CALENDAR_DATABASE_ID")
    calendar_name: str = Field(default="日历", env="CALENDAR_NAME")
    calendar_check_interval: int = Field(default=300, env="CALENDAR_CHECK_INTERVAL")  # 5分钟
    calendar_past_days: int = Field(default=7, env="CALENDAR_PAST_DAYS")
    calendar_future_days: int = Field(default=90, env="CALENDAR_FUTURE_DAYS")
    calendar_sync_mode: str = Field(
        default="applescript",
        env="CALENDAR_SYNC_MODE",
        description="日历同步模式: applescript (更稳定，推荐) / eventkit (更快但可能丢失权限)"
    )

    # 混合同步模式配置
    sync_mode: str = Field(default="hybrid", env="SYNC_MODE", description="同步模式: hybrid / applescript_only")
    radar_poll_interval: int = Field(default=5, env="RADAR_POLL_INTERVAL", description="雷达轮询间隔(秒)")
    reverse_sync_interval: int = Field(default=30, env="REVERSE_SYNC_INTERVAL", description="反向同步间隔(秒)")
    sync_date_mode: str = Field(default="relative", env="SYNC_DATE_MODE", description="日期模式: fixed / relative")
    sync_start_date: str = Field(default="2026-01-01", env="SYNC_START_DATE", description="fixed模式: 只同步此日期之后的邮件")
    sync_lookback_days: int = Field(default=14, env="SYNC_LOOKBACK_DAYS", description="relative模式: 只同步最近N天的邮件")
    health_check_interval: int = Field(default=3600, env="HEALTH_CHECK_INTERVAL", description="健康检查间隔(秒)")
    sync_store_db_path: str = Field(default="data/sync_store.db", env="SYNC_STORE_DB_PATH", description="同步状态存储SQLite数据库路径")

    # 周期会议滚动展开配置
    meeting_expansion_interval_seconds: int = Field(
        default=86400, env="MEETING_EXPANSION_INTERVAL_SECONDS",
        description="周期会议滚动展开间隔(秒)，默认每天一次"
    )
    meeting_expansion_horizon_weeks: int = Field(
        default=4, env="MEETING_EXPANSION_HORIZON_WEEKS",
        description="周期会议展开未来窗口宽度(周)"
    )

    # 多邮箱同步配置
    sync_mailboxes: str = Field(
        default="收件箱,发件箱",
        env="SYNC_MAILBOXES",
        description="要同步的邮箱列表，逗号分隔。含'发件箱'时 davmail 会同步 Sent folder 进 email_metadata (mailbox='发件箱')"
    )
    mail_sent_name: str = Field(default="已发送", env="MAIL_SENT_NAME", description="发件箱名称（AppleScript用）")

    # 飞书通知配置
    feishu_app_id: str = Field(default="", env="FEISHU_APP_ID", description="飞书应用 App ID")
    feishu_app_secret: str = Field(default="", env="FEISHU_APP_SECRET", description="飞书应用 App Secret")
    feishu_chat_id: str = Field(default="", env="FEISHU_CHAT_ID", description="飞书群聊 chat_id")
    feishu_webhook_url: str = Field(default="", env="FEISHU_WEBHOOK_URL", description="飞书自定义机器人 webhook URL（备用）")
    feishu_webhook_secret: str = Field(default="", env="FEISHU_WEBHOOK_SECRET", description="飞书 webhook 签名密钥（可选）")
    feishu_notify_enabled: bool = Field(default=False, env="FEISHU_NOTIFY_ENABLED", description="是否启用飞书通知")

    # Redis 事件消费配置（P3: Notion→Mail 方向）
    redis_url: str = Field(default="", env="REDIS_URL", description="Redis 连接 URL（如 redis://localhost:6379）")
    redis_db: int = Field(default=2, env="REDIS_DB", description="Redis DB 号（默认 2，MailAgent 专用）")
    redis_events_enabled: bool = Field(default=False, env="REDIS_EVENTS_ENABLED", description="是否启用 Redis 事件消费")

    # Sprint 16: mail-sync 进程内本地 SSE endpoint
    # Electron main 直连 127.0.0.1:9200/api/events/stream (0 RTT), V2 web 后续走
    # cloudflared 映射. 整个 server 由 main.py 启动; 关闭这个开关时不暴露端口,
    # 前端 events_bridge 自动 fallback 到轮询.
    mailagent_sse_enabled: bool = Field(
        default=True, env="MAILAGENT_SSE_ENABLED",
        description="是否在 mail-sync 进程内启动本地 SSE server (前端 Electron 直连)",
    )
    sse_local_host: str = Field(
        default="127.0.0.1", env="SSE_LOCAL_HOST",
        description="SSE server 绑定地址 (默认 127.0.0.1 仅本地; 0.0.0.0 暴露公网需自带 token)",
    )
    sse_local_port: int = Field(
        default=9200, env="SSE_LOCAL_PORT",
        description="SSE server 监听端口",
    )

    # 初始化同步配置
    init_batch_size: int = Field(default=100, env="INIT_BATCH_SIZE", description="初始化时每批获取邮件数量")
    applescript_timeout: int = Field(default=200, env="APPLESCRIPT_TIMEOUT", description="AppleScript超时时间(秒)")

    # 看板统计上报配置
    stats_report_url: str = Field(default="", env="STATS_REPORT_URL", description="看板统计上报 URL（如 https://mailagent.chenge.ink/api/stats/report）")
    stats_report_interval: int = Field(default=60, env="STATS_REPORT_INTERVAL", description="统计上报间隔(秒)")
    stats_report_token: str = Field(default="", env="STATS_REPORT_TOKEN", description="上报认证 token（默认复用 WEBHOOK_SECRET）")

    # Sprint 15 Stage 3: webhook-server 看板登录密码
    # 之前只在 .env.example 文档化, 不在 Settings 里 — 前端 admin config show 拿不到。
    # 留空 = 禁用 /dashboard 入口 (API 不受影响)
    dashboard_password: str = Field(
        default="", env="DASHBOARD_PASSWORD",
        description="webhook-server 看板登录密码; 留空则禁用 /dashboard 入口"
    )

    # 飞书告警机器人配置
    alert_feishu_webhook_url: str = Field(default="", env="ALERT_FEISHU_WEBHOOK_URL", description="飞书告警机器人 webhook URL")
    alert_feishu_webhook_secret: str = Field(default="", env="ALERT_FEISHU_WEBHOOK_SECRET", description="飞书告警 webhook 签名密钥")
    alert_enabled: bool = Field(default=False, env="ALERT_ENABLED", description="是否启用飞书告警")
    alert_levels: str = Field(default="critical,error,warning", env="ALERT_LEVELS", description="告警级别（逗号分隔）")
    alert_cooldown: int = Field(default=300, env="ALERT_COOLDOWN", description="同类告警冷却时间(秒)")
    alert_dead_letter_threshold: int = Field(default=5, env="ALERT_DEAD_LETTER_THRESHOLD", description="dead_letter 累积告警阈值")

    # Office 文档转换配置
    office_convert_enabled: bool = Field(default=True, env="OFFICE_CONVERT_ENABLED", description="是否启用 Office 附件转换（docx/pptx→PDF, xlsx→CSV）")

    # 防锁屏保活配置
    keep_alive_enabled: bool = Field(default=False, env="KEEP_ALIVE_ENABLED", description="是否启用防锁屏保活")
    keep_alive_dim: bool = Field(default=True, env="KEEP_ALIVE_DIM", description="保活时是否调低屏幕亮度")

    # 项目周报同步（外挂模块）
    # 总开关：默认关闭。本地需 .env 设 PROJECT_PROGRESS_SYNC_ENABLED=true 才会启用。
    project_progress_sync_enabled: bool = Field(
        default=False,
        env="PROJECT_PROGRESS_SYNC_ENABLED",
        description="项目周报同步模块的总开关（CLI + 钩子）。默认关。",
    )
    project_progress_auto_sync_enabled: bool = Field(
        default=False,
        env="PROJECT_PROGRESS_AUTO_SYNC_ENABLED",
        description="new_watcher 检测到项目周报邮件后是否自动触发同步",
    )
    project_progress_sender: str = Field(
        default="",
        env="PROJECT_PROGRESS_SENDER",
        description="项目周报发件人 email（子串匹配，不区分大小写）。需在 .env 显式配置。",
    )
    project_progress_subject_pattern: str = Field(
        default="",
        env="PROJECT_PROGRESS_SUBJECT_PATTERN",
        description="项目周报邮件标题正则。需在 .env 显式配置。",
    )
    project_progress_database_id: str = Field(
        default="",
        env="PROJECT_PROGRESS_DATABASE_ID",
        description="Notion 项目进度库 ID（空则同步功能禁用）",
    )
    project_progress_filter_bu: str = Field(
        default="TPS-ENBU",
        env="PROJECT_PROGRESS_FILTER_BU",
        description="过滤保留的 BU 值",
    )

    # =========================================================================
    # LLM Agent（本地 LLM 接管 Notion Custom Agent 的 AI 字段填充）
    # 默认关闭。启用前请先到 Notion automation 暂停 Email Agent，避免双跨撞车。
    # =========================================================================
    llm_agent_enabled: bool = Field(
        default=False, env="LLM_AGENT_ENABLED",
        description="是否启用本地 LLM 处理邮件 AI 字段（取代 Notion Custom Agent）",
    )
    llm_api_base: str = Field(
        default="https://crs.chenge.ink/api", env="LLM_API_BASE",
        description="Anthropic Messages 兼容网关 base url（不含 /v1/messages）",
    )
    llm_api_key: str = Field(
        default="", env="LLM_API_KEY",
        description="Anthropic 网关 API Key（Bearer 或 x-api-key 都支持）",
    )
    llm_model: str = Field(
        default="claude-sonnet-4-6", env="LLM_MODEL",
        description="主模型名（需网关支持）。失败时按 LLM_FALLBACK_MODELS 顺序兜底。",
    )
    llm_fallback_models: str = Field(
        default="gpt-5.4,claude-opus-4-7", env="LLM_FALLBACK_MODELS",
        description=(
            "主模型不可用时按顺序 fallback 的模型名（逗号分隔；留空禁用）。"
            "Anthropic 协议（claude-*）走 /v1/messages + tool_use；"
            "OpenAI 协议（gpt-*/gemini-*/codex-*）走 /v1/chat/completions 流式 + tool_calls，"
            "由 client.py 按模型名前缀自动路由。fallback 触发条件：上一个模型抛 LLMCallError。"
        ),
    )
    llm_max_tokens: int = Field(
        default=4096, env="LLM_MAX_TOKENS", description="单次生成 max_tokens",
    )
    llm_timeout_sec: int = Field(
        default=60, env="LLM_TIMEOUT_SEC", description="LLM 请求超时（秒）",
    )
    llm_inbox_prompt_path: str = Field(
        default="prompts/email_inbox.md", env="LLM_INBOX_PROMPT_PATH",
        description="收件箱 prompt md 路径（相对工作目录或绝对路径）",
    )
    llm_sent_prompt_path: str = Field(
        default="prompts/email_sent.md", env="LLM_SENT_PROMPT_PATH",
        description="发件箱 prompt md 路径",
    )
    llm_context_page_id: str = Field(
        default="", env="LLM_CONTEXT_PAGE_ID",
        description="Email Agent Context Notion 页面 ID（留空则不拼 context）",
    )
    llm_context_cache_ttl_sec: int = Field(
        default=1800, env="LLM_CONTEXT_CACHE_TTL_SEC",
        description="context markdown 内存缓存 TTL（秒）",
    )
    llm_daily_digest_database_id: str = Field(
        default="", env="LLM_DAILY_DIGEST_DATABASE_ID",
        description="Daily Email Digests 库 ID（留空则跳过 relation 写入）",
    )
    llm_daily_digest_report_date_prop: str = Field(
        default="Report Date", env="LLM_DAILY_DIGEST_REPORT_DATE_PROP",
        description="Daily Digest 库里用于匹配归属日期的 date 字段名",
    )
    llm_max_retries: int = Field(
        default=3, env="LLM_MAX_RETRIES",
        description="LLM 调用失败重试次数（退避 60s/300s/900s）",
    )
    llm_body_max_chars: int = Field(
        default=12000, env="LLM_BODY_MAX_CHARS",
        description="邮件正文送入 LLM 的最大字符数（超过截断）",
    )
    llm_cache_enabled: bool = Field(
        default=True, env="LLM_CACHE_ENABLED",
        description=(
            "是否在 system prompt 末尾放 cache_control 断点。"
            "仅 Anthropic 协议（及兼容网关，如 crs.chenge.ink）有效；"
            "OpenAI 兼容网关应设 false，否则协议报错。"
        ),
    )
    llm_cache_ttl: str = Field(
        default="1h", env="LLM_CACHE_TTL",
        description=(
            "显式 cache TTL：'5m' / '1h'，或空串让网关决定。默认 '1h'：协议兼容性最好——"
            "走 CRS 时会被透传保留；走原生 Anthropic 端点时配合 client.py 发的 "
            "'anthropic-beta: extended-cache-ttl-2025-04-11' header 一起 1h 生效。"
            "仅当 LLM_CACHE_ENABLED=true 时生效。"
        ),
    )
    llm_prefer_sqlite_body: bool = Field(
        default=True, env="LLM_PREFER_SQLITE_BODY",
        description=(
            "LLM 处理时优先从 SQLite 读 markdown body (v4 SSoT)；miss 时回退到 "
            "正则剥 HTML。设 false 退回 Phase 1 之前的正则行为。"
        ),
    )

    # =========================================================================
    # KOS Producer (Sprint 19 M2 PR-2d) — 邮件 sync 完异步推 Jarvis KOS v2
    # 详见 docs/kos-integration-design.md §3 + frontend/SPRINT19-M2-PLAN.md §3
    # KOSClient 默认从 env 直接读 3 个 OAuth 凭据 (KOS_MCP_BASE /
    # KOS_OAUTH_CLIENT_ID / KOS_OAUTH_CLIENT_SECRET), 这里仅暴露 producer 行为
    # 开关; client 配置不重复.
    # =========================================================================
    mailagent_kos_ingest_enabled: bool = Field(
        default=False, env="MAILAGENT_KOS_INGEST_ENABLED",
        description=(
            "是否在邮件 sync 完成后异步推 KOS /ingest (PR-2d producer)。"
            "默认 false — 启用前需配 3 个 KOS_OAUTH_* env 凭据。"
        ),
    )
    kos_ingest_priority_floor: str = Field(
        default="normal", env="KOS_INGEST_PRIORITY_FLOOR",
        description=(
            "priority floor — 仅推 ai_priority ≥ floor 的邮件入 KOS, 防低优"
            "邮件 (广告/通讯录/系统通知) 污染图谱。取值: critical / urgent / "
            "important / normal / low. 默认 'normal'。"
        ),
    )
    kos_ingest_dry_run: bool = Field(
        default=False, env="KOS_INGEST_DRY_RUN",
        description=(
            "Producer dry-run mode — build payload + log 但不真发 /ingest, "
            "给上线灰度用。"
        ),
    )

    # CLI: API key 用于写命令鉴权 (RFC v2 §5.3 / PR-2)
    mailagent_cli_api_key: str = Field(
        default="", env="MAILAGENT_CLI_API_KEY",
        description=(
            "mailagent CLI 写命令所需 API key（resync / delete / cleanup 等）。"
            "留空+未设 MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true → 默认拒绝写。"
            "详见 RFC v2 §5.3。"
        ),
    )

    # v4 Phase 4: Notion uploader 改读 SQLite (架构归一)
    notion_read_from_sqlite: bool = Field(
        default=False, env="NOTION_READ_FROM_SQLITE",
        description=(
            "是否让 create_email_page_v2 优先走 SQLite SSoT 路径 (v4 P4-04)。"
            "默认 false 灰度期 —— backfill 完 + 抽样人工 diff 验证通过后再切 true。"
            "切换语义：true 且 email.internal_id + SQLite 命中 body → delegate 到"
            " create_email_page_from_sqlite；miss 自动 fallback 老路径。"
        ),
    )
    # v4 Phase 4: thread relations 切 SQLite SSoT (R-02)
    thread_relations_fallback_to_notion: bool = Field(
        default=True, env="THREAD_RELATIONS_FALLBACK_TO_NOTION",
        description=(
            "_handle_thread_relations 在 SQLite 查不到 thread members 时是否 fallback "
            "Notion API (v4 R-02 灰度期开关; historic backfill 完成后可关)。"
        ),
    )

    # =========================================================================
    # Sprint 15: SQLite SSoT inversion (email_outbox + FanoutWorker)
    # 详见 SPRINT15-HANDOFF.md §3 + .claude/plans/ultrathink-sprint-15-handoff*.md
    # =========================================================================
    mailagent_outbox_enabled: bool = Field(
        default=False, env="MAILAGENT_OUTBOX_ENABLED",
        description=(
            "是否启用 email_outbox + FanoutWorker 异步派发 (Sprint 15 SSoT inversion)。"
            "默认 false 灰度期 —— 关闭时 reverse handler 走老 AppleScript 直调路径。"
            "切 true: 前端 `mailagent email flag` / 反向 webhook → outbox → fanout "
            "异步派发到 Mail.app + Notion. 灰度切换详 SPRINT15-HANDOFF.md §3.5。"
        ),
    )
    mailagent_outbox_poll_interval_sec: int = Field(
        default=5, env="MAILAGENT_OUTBOX_POLL_INTERVAL_SEC",
        description="FanoutWorker 主循环 poll 间隔（秒），默认 5。",
    )
    mailagent_outbox_max_attempts: int = Field(
        default=5, env="MAILAGENT_OUTBOX_MAX_ATTEMPTS",
        description="单条 outbox 重试次数上限；达到后晋升 dead_letter 并飞书告警。",
    )
    mailagent_outbox_concurrency: int = Field(
        default=3, env="MAILAGENT_OUTBOX_CONCURRENCY",
        description="FanoutWorker tick 最大并发 fanout 数（gated by asyncio.Semaphore）。",
    )

    # =========================================================================
    # ping-island 灵动岛集成 (Island-Sprint 2)
    # 详见 frontend/ISLAND-PLUGIN.md。ping_island_enabled 默认开（Phase 1+2+F1-F6 已 ship）；仍需装 ping-island.app，未装则 socket fail-open
    # =========================================================================
    ping_island_enabled: bool = Field(
        default=True, env="PING_ISLAND_ENABLED",
        description="是否启用 ping-island 派发（默认开，Phase 1+2+F1-F6 已 ship）。失败 fail-open，不影响主同步。",
    )
    island_socket_path: str = Field(
        default="/tmp/island.sock", env="ISLAND_SOCKET_PATH",
        description="ping-island Swift daemon 监听的 unix domain socket 路径",
    )
    island_socket_timeout: float = Field(
        default=3.0, env="ISLAND_SOCKET_TIMEOUT",
        description="connect/sendall/recv 三阶段共享超时（秒，REVIEW-LOG H-16）",
    )
    ping_island_lang: str = Field(
        default="system", env="PING_ISLAND_LANG",
        description="envelope 标题/预览 i18n locale：system / zh-CN / en-US",
    )
    ping_island_reconnect_probe_interval: int = Field(
        default=300, env="PING_ISLAND_RECONNECT_PROBE_INTERVAL",
        description="sleep/wake 后探测 socket 文件存在的间隔（秒，H-17）",
    )
    ping_island_queue_max: int = Field(
        default=20, env="PING_ISLAND_QUEUE_MAX",
        description="发送失败 backlog queue 最大长度（deque maxlen，超出丢老的）",
    )
    island_accent: str = Field(
        default="coral", env="ISLAND_ACCENT",
        description="灵动岛主题色（前端 DESIGN.md §2.7 六色之一，envelope metadata 透传给 Swift）",
    )
    island_theme: str = Field(
        default="dark", env="ISLAND_THEME",
        description="灵动岛 light/dark mode（envelope metadata 透传，Swift 端按此切 token）",
    )

    # ---- 灵动岛 Phase 3 DailyDigest（每日巡检，默认关闭，gate by ping_island_enabled）----
    mailagent_daily_digest_enabled: bool = Field(
        default=False, env="MAILAGENT_DAILY_DIGEST_ENABLED",
        description="是否启用灵动岛每日巡检（DailyDigest）；island 开 + 此开关开才跑。默认关。",
    )
    mailagent_daily_digest_hours: str = Field(
        default="9,18", env="MAILAGENT_DAILY_DIGEST_HOURS",
        description="每日巡检触发钟点（北京时区，逗号分隔小时），默认 9,18。",
    )
    mailagent_daily_digest_window_hours: int = Field(
        default=24, env="MAILAGENT_DAILY_DIGEST_WINDOW_HOURS",
        description="巡检回看窗口小时数，默认 24（取最近 24h 邮件做汇总）。",
    )
    mailagent_daily_digest_max_emails: int = Field(
        default=50, env="MAILAGENT_DAILY_DIGEST_MAX_EMAILS",
        description="单次 digest 喂给 LLM 的邮件 brief 封数上限（按 priority/date 排序取前 N），默认 50。",
    )
    mailagent_daily_digest_max_bulk_ids: int = Field(
        default=30, env="MAILAGENT_DAILY_DIGEST_MAX_BULK_IDS",
        description="每个 bulk action 携带的 internal_id 列表上限（单次一键批量处理封数），默认 30。",
    )

    # =========================================================================
    # Sprint 16 dual-backend (2026-05): 邮件后端 single-driver 显式切换
    # AppleScript + Mail.app (FALLBACK, 默认) ⇄ DavMail IMAP/SMTP (PRIMARY)
    # 详见 plan: ~/.claude/plans/ultrathink-docs-dual-backend-*.md
    # 切换协议: 改下方 MAILAGENT_BACKEND + pm2 restart mail-sync
    # =========================================================================
    mailagent_backend: str = Field(
        default="applescript", env="MAILAGENT_BACKEND",
        description=(
            "邮件后端选择: 'applescript' (默认, Mail.app + AppleScript v3 路径) | "
            "'davmail' (DavMail IMAP/SMTP, PRIMARY when 切换). 启动时 backend factory "
            "probe 失败 → BackendStartupError + print 切换提示 + exit(1) (PM2 autorestart=false). "
            "切换是手动 single-driver, 没有自动 fallback. davmail 模式启动前确认 "
            "`pm2 ls | grep davmail-poc` online."
        ),
    )
    davmail_imap_host: str = Field(
        default="127.0.0.1", env="DAVMAIL_HOST",
        description="DavMail JVM bind 地址 (PM2 davmail-poc 默认仅 127.0.0.1, 勿暴露公网)",
    )
    davmail_imap_port: int = Field(
        default=1143, env="DAVMAIL_IMAP_PORT", description="DavMail IMAP 端口",
    )
    davmail_smtp_port: int = Field(
        default=1025, env="DAVMAIL_SMTP_PORT", description="DavMail SMTP submission 端口",
    )
    davmail_cipher_key: str = Field(
        default="", env="DAVMAIL_POC_CIPHER_KEY",
        description=(
            "DavMail StringEncryptor password (= IMAP/SMTP AUTH password). "
            "留空时若 davmail_poc_mode=True 走 fallback 默认 'mailagent-poc-shared-key' "
            "跟 davmail-poc/ 一致. 改这个值要同步清 davmail-poc/token/token.dat 重新走 "
            "OAuth manual flow. 见 davmail-poc/POC-RESULTS.md §StringEncryptor."
        ),
    )
    davmail_poc_mode: bool = Field(
        default=False, env="DAVMAIL_POC_MODE",
        description=(
            "PoC/dev 兜底: davmail_cipher_key 留空时是否 fallback 到默认 PoC key. "
            "生产 / 多用户场景必须 False (默认), 强制配置真实 cipher key 避免无声 "
            "fallback 导致 BadPaddingException."
        ),
    )
    davmail_fetch_timeout_sec: int = Field(
        default=120, env="DAVMAIL_FETCH_TIMEOUT_SEC",
        description=(
            "DavMail IMAP fetch_email_by_id 单次操作 timeout (秒). "
            "默认 120s, uid-mapper 后台并发跑时单封 fetch 偶发超时 (原 60s 过紧). "
            "极端大邮件 (~MB attachment) 可适当调大到 180s."
        ),
    )
    davmail_uid_backfill_enabled: bool = Field(
        default=True, env="DAVMAIL_UID_BACKFILL_ENABLED",
        description=(
            "是否启用 uid-mapper 后台 backfill (cutover 后给 applescript 时代邮件补 imap_uid). "
            "EWS throttling 期间可临时设 false 让 davmail 喘息. 关闭后老邮件反向 flag / "
            "fetch 仍能用 message_id 慢路径 (~1s vs ~200ms 快路径)."
        ),
    )
    davmail_uid_backfill_batch_size: int = Field(
        default=20, env="DAVMAIL_UID_BACKFILL_BATCH_SIZE",
        description=(
            "uid-mapper 单批 IMAP SEARCH HEADER 数量 (默认 20, 原 50). "
            "调小避免 davmail 端 EWS searchMessages 突发 → Microsoft throttling. "
            "20 × ~150ms = ~3s/batch, 跟正向 sync poll 不抢资源."
        ),
    )
    davmail_uid_backfill_sleep_sec: float = Field(
        default=3.0, env="DAVMAIL_UID_BACKFILL_SLEEP_SEC",
        description=(
            "uid-mapper 每批之间 sleep (秒). 给 davmail 端 EWS 调用喘息窗口, "
            "避免 throttling. 8857 封邮件 / 20 = ~443 批 × 3s = ~22min 加额外延迟 "
            "(原本 ~3min). 用速度换稳定性."
        ),
    )
    davmail_drafts_folder: str = Field(
        default="", env="DAVMAIL_DRAFTS_FOLDER",
        description=(
            "DavMail IMAP Drafts 文件夹名 (例 'INBOX/Drafts', 'Drafts', '草稿'). "
            "留空时 startup probe 通过 IMAP LIST SPECIAL-USE \\Drafts 标志自动探测. "
            "Outlook 中文环境通常是 'Drafts' 或 'INBOX/Drafts'."
        ),
    )
    davmail_archive_sent: bool = Field(
        default=False, env="DAVMAIL_ARCHIVE_SENT",
        description=(
            "SMTP 发送后是否手动 APPEND 一份到 Sent 文件夹. 默认 False — EWS/DavMail "
            "通常服务端自动归档已发送邮件; 仅当 dogfood 发现「已发送」缺失再开 "
            "(开了要防与服务端自动归档重复成双份)."
        ),
    )
    davmail_sent_folder: str = Field(
        default="", env="DAVMAIL_SENT_FOLDER",
        description=(
            "Sent 文件夹名 (例 'Sent Items', '已发送邮件'). 留空走 IMAP SPECIAL-USE "
            "\\Sent 探测 + fallback 常见名. 仅 davmail_archive_sent=True 时用."
        ),
    )
    davmail_poll_interval_sec: int = Field(
        default=30, env="DAVMAIL_POLL_INTERVAL_SEC",
        description=(
            "DavMail backend IMAP STATUS UIDNEXT 轮询间隔 (秒). 默认 30s — "
            "PoC 实测 IDLE 不推送 fallback polling, 邮件应用 minute 级 latency 够用. "
            "AppleScript backend 仍走 radar_poll_interval (默认 5s)."
        ),
    )
    davmail_caldav_port: int = Field(
        default=1080, env="DAVMAIL_CALDAV_PORT",
        description="DavMail CalDAV 端口 (Phase C.2 — LLM agent 拿日程 context)",
    )
    llm_caldav_context_enabled: bool = Field(
        default=False, env="LLM_CALDAV_CONTEXT_ENABLED",
        description=(
            "Phase C.2 — LLM agent 处理邮件时, 是否注入'今日/本周日程' context. "
            "依赖: `pip install caldav` + DavMail 1080 端口 online. 默认关闭, 启用前先"
            "试 caldav 连接是否 OK (见 davmail-poc/test_caldav.py)."
        ),
    )

    # ============================================================
    # Calendar SSoT (Phase 1, plan §1.4)
    # ============================================================
    # CalendarSyncWorker (CalDAV → SQLite calendar_event 表的增量 sync) 开关 +
    # 前端日历视图 V2 灰度开关. 详见 plan §"Phase 4 灰度策略 + Legacy 共存".
    calendar_caldav_sync_enabled: bool = Field(
        default=False, env="CALENDAR_CALDAV_SYNC_ENABLED",
        description=(
            "启用 CalendarSyncWorker (asyncio loop, mail-sync 进程内 60s 轮询 "
            "DavMail CalDAV ctag, 增量 sync 到 SQLite calendar_event 表). "
            "默认关闭灰度期开. 跟 legacy 'calendar-sync' PM2 进程并存, 用 "
            "source='caldav' 区分. 依赖: pip install caldav + DavMail 1080 端口 online."
        ),
    )
    calendar_caldav_sync_poll_interval_sec: int = Field(
        default=60, env="CALENDAR_CALDAV_SYNC_POLL_INTERVAL_SEC",
        description="CalendarSyncWorker ctag 轮询间隔 (秒). 默认 60s.",
    )
    calendar_caldav_sync_window_past_days: int = Field(
        default=30, env="CALENDAR_CALDAV_SYNC_WINDOW_PAST_DAYS",
        description="CalendarSyncWorker 全量 sync 窗口左边界 (今天 - N 天). 默认 30.",
    )
    calendar_caldav_sync_window_future_days: int = Field(
        default=180, env="CALENDAR_CALDAV_SYNC_WINDOW_FUTURE_DAYS",
        description="CalendarSyncWorker 全量 sync 窗口右边界 (今天 + N 天). 默认 180.",
    )
    # ============================================================
    # FolderSyncWorker (Archive/Drafts IMAP → SQLite folder_email 表) 开关 + 窗口.
    # davmail-only; AppleScript 模式下 worker 不启动. 详见 plan mailagent-davmail-zesty-eclipse.md.
    mailbox_folder_sync_enabled: bool = Field(
        default=False, env="MAILBOX_FOLDER_SYNC_ENABLED",
        description=(
            "启用 FolderSyncWorker (asyncio loop, mail-sync 进程内轮询 DavMail IMAP "
            "Archive/Drafts 文件夹, 增量 sync 到 SQLite folder_email 表). 默认关闭. "
            "davmail-only — MAILAGENT_BACKEND=applescript 时不启动."
        ),
    )
    folder_sync_poll_interval_sec: int = Field(
        default=60, env="FOLDER_SYNC_POLL_INTERVAL_SEC",
        description="FolderSyncWorker IMAP STATUS 轮询间隔 (秒). 默认 60s.",
    )
    archive_sync_past_days: int = Field(
        default=365, env="ARCHIVE_SYNC_PAST_DAYS",
        description="Archive 同步窗口 (最近 N 天). 越大首次同步越久 + 占空间. 默认 365.",
    )
    archive_sync_max_messages: int = Field(
        default=5000, env="ARCHIVE_SYNC_MAX_MESSAGES",
        description="Archive 同步上限封数 (防极端大邮箱). 超出按 date 降序截断. 默认 5000.",
    )
    frontend_mailbox_folders_enabled: bool = Field(
        default=False, env="FRONTEND_MAILBOX_FOLDERS_ENABLED",
        description="前端存档/草稿箱入口灰度开关 (Sidebar 显隐). 默认关闭.",
    )
    frontend_calendar_v2_enabled: bool = Field(
        default=False, env="FRONTEND_CALENDAR_V2_ENABLED",
        description=(
            "前端日历模块 V2 灰度开关. False = /calendar 路由还是显示老的 recurring "
            "invite 表 (CalendarPage.tsx); True = 切到新月/周/日/agenda 视图. "
            "灰度切换期间随时可回切. 详见 plan §Phase 4."
        ),
    )

# 全局配置实例
config = Config()
