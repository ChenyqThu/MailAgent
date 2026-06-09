import os

from pydantic_settings import BaseSettings
from pydantic import Field, ConfigDict

# =============================================================================
# DATA_ROOT 路径解析（P0 packaging：Python 侧路径解耦 / 绝对化）
# 详见 docs/packaging/01-architecture-analysis.md §3.4 + 02-landing-plan.md P0
#
# 目的：让所有数据/文件路径不再依赖进程 cwd —— 打包后（或任何 cwd ≠ 项目根的
# 场景）`Config()` 都能正确解析，不在必填字段阶段因相对路径 ValidationError。
#
# 最高优先级向后兼容约束：MAILAGENT_DATA_ROOT 未设时，DATA_ROOT 默认 = 仓库根
# (= dirname(dirname(__file__)))。生产 mail-sync (PM2 cwd=项目根) 下:
#   - 旧行为: 相对路径 'data/sync_store.db' 解析为 <cwd>/data/sync_store.db
#             == <项目根>/data/sync_store.db
#   - 新行为: DATA_ROOT(=项目根)/data/sync_store.db
# 两者逐字节一致 —— 正在跑的生产实例零改变。
#
# 注意：env / CLI flag 显式提供的路径（无论相对还是绝对）一律原样透传，不被
# DATA_ROOT 前缀 —— 因为这些 helper 只用于计算 Field 的 default 值；pydantic
# 在有 env/flag 值时不会用 default。（见 tests/cli/test_config_factory.py）
# =============================================================================


def _resolve_data_root() -> str:
    """统一 DATA_ROOT 解析入口。

    优先 MAILAGENT_DATA_ROOT 环境变量；未设时默认 = 仓库根，等价于旧的
    「相对项目根 cwd」行为（向后兼容硬约束）。返回绝对路径。
    """
    env_root = os.environ.get("MAILAGENT_DATA_ROOT")
    if env_root:
        return os.path.abspath(os.path.expanduser(env_root))
    # 仓库根 = src/ 的父目录 = dirname(dirname(此文件))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _under_data_root(rel: str) -> str:
    """把一个相对项目根的旧默认路径锚定到 DATA_ROOT 下的绝对路径。

    旧默认值（如 'data/sync_store.db'）原样传入，返回 DATA_ROOT/<rel> 的绝对
    路径。DATA_ROOT 默认 = 仓库根时与旧的相对解析逐字节一致。
    """
    return os.path.join(_resolve_data_root(), rel)


def _resolve_env_file() -> str:
    """env_file 路径解析：优先 MAILAGENT_ENV_FILE，默认 DATA_ROOT/.env。

    不再依赖进程 cwd（旧 env_file='.env' 是相对 cwd）。DATA_ROOT 默认 = 仓库根
    时 == <项目根>/.env，与旧行为一致。
    """
    env_file = os.environ.get("MAILAGENT_ENV_FILE")
    if env_file:
        return os.path.abspath(os.path.expanduser(env_file))
    return os.path.join(_resolve_data_root(), ".env")


# 模块导入期固定一次（与旧 env_file='.env' 在 class 定义期固定的时机一致）。
DATA_ROOT = _resolve_data_root()


class Config(BaseSettings):
    """配置类"""

    model_config = ConfigDict(
        env_file=_resolve_env_file(),
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
    log_file: str = Field(default_factory=lambda: _under_data_root("logs/sync.log"), env="LOG_FILE")

    # 附件配置
    max_attachment_size: int = Field(default=20971520, env="MAX_ATTACHMENT_SIZE")  # 20MB (Notion limit)

    # v4: SQLite SSoT 配置（邮件正文 + 附件元数据进 SQLite，详见 docs/architecture_v4_sqlite_ssot.md）
    body_dual_write_enabled: bool = Field(
        default=True, env="BODY_DUAL_WRITE_ENABLED",
        description="是否在 Notion sync 前把邮件正文 + 附件双写到 SQLite（v4 架构）。失败仅 warning，不阻断主流程"
    )
    attachment_storage_dir: str = Field(
        default_factory=lambda: _under_data_root("data/attachments"), env="ATTACHMENT_STORAGE_DIR",
        description="附件本地落盘目录（按 internal_id 分子目录），与 sync_store.db 同 DATA_ROOT/data/ 同级便于统一备份 + 前端 attachment.ts dirname(dirname(dbPath)) 倒推"
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
    sync_store_db_path: str = Field(default_factory=lambda: _under_data_root("data/sync_store.db"), env="SYNC_STORE_DB_PATH", description="同步状态存储SQLite数据库路径（DATA_ROOT/data/ 下，与 attachments 同级）")

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

    # 多文件夹同步（davmail-only）：自定义 Exchange 文件夹白名单，邮件接入 email_metadata 主链路
    sync_folders: str = Field(
        default="",
        env="SYNC_FOLDERS",
        description="额外同步的自定义文件夹白名单（davmail-only）。存 IMAP 原始名"
                    '(modified-UTF7, ASCII)，**JSON 数组**格式 ["Notion","&W,mL3VOGU,KLsF9V-"]'
                    "（modified-UTF7 中文名含逗号，不能用逗号分隔；旧 CSV 简单名仍兼容）。"
                    "空=不同步任何自定义文件夹(默认, 零激活)。收件箱/发件箱由 SYNC_MAILBOXES 管。",
    )
    folder_sync_past_days: int = Field(
        default=90, env="FOLDER_SYNC_PAST_DAYS",
        description="自定义文件夹首次同步窗口（最近 N 天）。防大文件夹历史邮件灌爆。",
    )
    folder_sync_max_messages: int = Field(
        default=2000, env="FOLDER_SYNC_MAX_MESSAGES",
        description="单个自定义文件夹单次拉取上限（取最新 N 封）。0=不限。"
                    "注意截断语义：首次回填超上限时只取最新 N 封，被截掉的更旧邮件后续不会补拉（marker 已推进）。",
    )
    # L2/L3 per-folder gate（按 mailbox 显示名匹配，JSON 数组；PRD §2.3 分层）
    folder_notify_enabled: str = Field(
        default="",
        env="FOLDER_NOTIFY_ENABLED",
        description='自定义文件夹**默认不触发飞书通知**（L3 降噪）；仅此白名单内的文件夹通知。'
                    '存 mailbox 显示名（如 ["Jira"]），JSON 数组。空=所有自定义文件夹都不通知。',
    )
    folder_llm_disabled: str = Field(
        default="",
        env="FOLDER_LLM_DISABLED",
        description='自定义文件夹**默认跑 LLM 分类**（L2）；此黑名单内的文件夹跳过 LLM（省成本去噪）。'
                    '存 mailbox 显示名（如 ["Jira","Bugzilla"]），JSON 数组。空=所有自定义文件夹都分类。',
    )

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
        default=64000, env="LLM_MAX_TOKENS",
        description="单次生成 max output tokens（默认 64k = Claude Sonnet 4.x 上限；仅上限不强制，按需输出）",
    )
    llm_timeout_sec: int = Field(
        default=60, env="LLM_TIMEOUT_SEC", description="LLM 请求超时（秒）",
    )
    llm_inbox_prompt_path: str = Field(
        default_factory=lambda: _under_data_root("prompts/email_inbox.md"), env="LLM_INBOX_PROMPT_PATH",
        description="收件箱 prompt md 路径（默认 DATA_ROOT/prompts/ 下；env 显式值原样透传，相对或绝对皆可）",
    )
    llm_sent_prompt_path: str = Field(
        default_factory=lambda: _under_data_root("prompts/email_sent.md"), env="LLM_SENT_PROMPT_PATH",
        description="发件箱 prompt md 路径（默认 DATA_ROOT/prompts/ 下）",
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
            "显式 cache TTL：'5m' / '1h'，或空串使用 Anthropic 默认 5m。"
            "CRS Sonnet 上不再搭配 anthropic-beta 头，避免触发账号级限流锁。"
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

    # =========================================================================
    # Chat Agent Harness 配置 (V2.1 阶段 3c — serve-api GET /api/chat/config 暴露给
    # renderer chat 引擎 HttpChatPlatform 的运行配置快照)。
    #
    # 🔴 env 名 + 默认值必须与 frontend/src/electron/main/chat/config.ts 的 getter
    #    逐一对齐: cutover 前 electron dispatcher 直读 process.env, cutover 后 (3c-4
    #    删 chat/config.ts) serve-api 是 chat 配置的唯一真源。读 .env 经 pydantic
    #    env_file (robust, 不依赖 serve-api 进程 load_dotenv — serve_api() 不 load)。
    # =========================================================================
    agent_max_iter: int = Field(
        default=8, env="AGENT_MAX_ITER",
        description="harness 每条用户消息最大迭代次数 (backend.stream 调用数硬上限)。",
    )
    agent_max_cost_usd: float = Field(
        default=0.5, env="AGENT_MAX_COST_USD",
        description="harness 每轮成本上限 USD (累加 usage.costUsd, 超出 emit E_COST_BUDGET)。",
    )
    agent_harness_enabled: bool = Field(
        default=True, env="MAILAGENT_AGENT_HARNESS",
        description="多轮 agent harness 总开关。false → dispatcher 走 legacy 单遍 (应急回退)。",
    )
    kos_consumer_enabled: bool = Field(
        default=False, env="MAILAGENT_KOS_CONSUMER_ENABLED",
        description=(
            "KOS consumer chat 工具 (kos_query / kos_digest 等 9 个) 是否注册 + KOS "
            "使用指南块是否注入 system prompt。/chat/config 的 kosConfigured 即此值 "
            "(对齐 electron kosConfig().configured = isKosConsumerEnabled(), 决定 "
            "createBuiltinTools 是否 push 9 个 KOS 工具 —— **非** OAuth 凭据齐)。"
        ),
    )
    kos_l1_hot_block_enabled: bool = Field(
        default=False, env="MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED",
        description="L1 hot block: chat start 按发件人预取 KOS people digest 注入 system prompt。",
    )
    kos_time_decay_enabled: bool = Field(
        default=True, env="MAILAGENT_KOS_TIME_DECAY_ENABLED",
        description="kos_query 命中按 14d 半衰期时间衰减 rerank (false → 纯服务端 bm25 序)。",
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

    # C1: async_jobs 子系统 —— 长任务 (batch resync / backfill) 走统一 daemon API。
    # POST /api/jobs enqueue → serve 进程内 JobWorker 串行 claim + 执行 (复用
    # LongTaskContext checkpoint/熔断) + SSE job.progress 进度。默认关闭灰度期。
    # 详见 docs/backend-service-migration-matrix.md C1 + plan §C1。
    mailagent_async_jobs_enabled: bool = Field(
        default=False, env="MAILAGENT_ASYNC_JOBS_ENABLED",
        description=(
            "是否启用 async_jobs 长任务子系统 (serve 进程内 JobWorker)。默认 false 灰度期 —— "
            "关闭时 POST /api/jobs 仍可 enqueue 但无 worker 执行 (行保持 queued)。"
            "CLI 长任务 (email resync --range / backfill) 不受影响, 仍走 LongTaskContext 直跑。"
        ),
    )
    mailagent_async_jobs_poll_interval_sec: int = Field(
        default=5, env="MAILAGENT_ASYNC_JOBS_POLL_INTERVAL_SEC",
        description="JobWorker 主循环 poll 间隔（秒），默认 5。空闲时 claim 不到 job 即 sleep 此值。",
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

    # ---- 报告 Agent 系统（v18, src/reports；默认关）----
    mailagent_report_agent_enabled: bool = Field(
        default=False, env="MAILAGENT_REPORT_AGENT_ENABLED",
        description="报告 Agent 总开关（日/周/月报 report_worker tick_loop）。默认关；per-agent 还需 report_agent.enabled。",
    )
    mailagent_report_max_emails: int = Field(
        default=0, env="MAILAGENT_REPORT_MAX_EMAILS",
        description="单次报告喂给 LLM 的邮件 brief 封数上限（按 priority/date 排序取前 N）。≤0 = 不限制（取窗口内全部邮件），默认 0 不限制。",
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
