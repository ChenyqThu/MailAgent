import os

from pydantic_settings import BaseSettings
from pydantic import AliasChoices, Field, ConfigDict

# =============================================================================
# DATA_ROOT 路径解析（P0 packaging：Python 侧路径解耦 / 绝对化）
# 详见 docs/reference/packaging/01-architecture-analysis.md §3.4 + 02-landing-plan.md P0
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

    # 🔴 pydantic v2 忽略 Field(env=)；env 别名必须用 validation_alias（2026-06-30 修 9 flag env 链断 bug）。新增带 MAILAGENT_ 前缀且字段名≠env 的 flag 一律用 validation_alias。
    model_config = ConfigDict(
        env_file=_resolve_env_file(),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Notion 配置（task 07-12 P3b 方案 C：可选化 —— 空 = Notion 面停用，邮件走本地-only
    # 同步 mark_synced_local。运行时判定统一走模块级 notion_enabled() /
    # calendar_notion_enabled()，勿在消费点各自 if config.notion_token 漂移）
    notion_token: str = Field(default="", env="NOTION_TOKEN")
    email_database_id: str = Field(default="", env="EMAIL_DATABASE_ID")

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

    # v4: SQLite SSoT 配置（邮件正文 + 附件元数据进 SQLite，详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md）
    body_dual_write_enabled: bool = Field(
        default=True, env="BODY_DUAL_WRITE_ENABLED",
        description="是否在 Notion sync 前把邮件正文 + 附件双写到 SQLite（v4 架构）。失败仅 warning，不阻断主流程"
    )
    attachment_storage_dir: str = Field(
        default_factory=lambda: _under_data_root("data/attachments"), env="ATTACHMENT_STORAGE_DIR",
        description="附件本地落盘目录（按 internal_id 分子目录），与 sync_store.db 同 DATA_ROOT/data/ 同级便于统一备份 + 前端 attachment.ts dirname(dirname(dbPath)) 倒推"
    )

    # 附件文本抽取 worker（PR0：修复 email_attachment_text 队列停摆）。登记侧一直正常
    # 但长驻服务从未实现消费者 —— 唯一消费者是手动 CLI `mailagent attachment extract`。
    # 默认开；off = 不 spawn worker，回纯手动 CLI 现状。消费循环体与 CLI 共享单一真源
    # src/mail/attachment_text_worker.py。next_retry_at 指数退避由 repo 层已实现。
    mailagent_attachment_text_worker_enabled: bool = Field(
        default=True, env="MAILAGENT_ATTACHMENT_TEXT_WORKER_ENABLED",
        description="是否启用附件文本抽取后台 worker（PDF/docx/pptx/xlsx → FTS5 索引）。默认开；显式 false 回纯手动 CLI 现状。",
    )
    mailagent_attachment_text_worker_limit_per_cycle: int = Field(
        default=25, env="MAILAGENT_ATTACHMENT_TEXT_WORKER_LIMIT_PER_CYCLE",
        description="附件文本 worker 每轮最多处理多少 attachment，默认 25。",
    )
    mailagent_attachment_text_worker_poll_interval_sec: int = Field(
        default=60, env="MAILAGENT_ATTACHMENT_TEXT_WORKER_POLL_INTERVAL_SEC",
        description="附件文本 worker 主循环 poll 间隔（秒），默认 60。空闲无 pending 即 sleep 此值。",
    )

    # 附件 OCR（批次4 PR-G）：图片附件 + 无文本层扫描件 PDF 经 macOS Vision（pyobjc）
    # 识别中英文本 → FTS5。功能性 extractor 扩展、无网络出口、本地 Vision。默认开；
    # 显式 false = 图片 / 扫描件 PDF 行为与现状逐字节一致（unsupported / failed 老文案）。
    # 懒 import：缺 pyobjc 时软着陆维持 unsupported。详见 v4-ssot-ops.md「附件 FTS5 全文搜索」。
    mailagent_attachment_ocr_enabled: bool = Field(
        default=True, env="MAILAGENT_ATTACHMENT_OCR_ENABLED",
        description="是否启用附件 OCR（macOS Vision，图片 + 扫描件 PDF）。默认开；显式 false 回现状（图片/扫描件维持 unsupported/failed）。",
    )

    # anydoc 文档提取（task 08-10 WP2）：docx/pptx/xlsx/老 .doc → 带结构的 GFM markdown。
    # 纯本地 Rust 解析器（`firecrawl-anydoc`，import 名 `anydoc`），零网络零 key。
    # 收的是实测缺陷：python-docx 的 paragraph.text 丢 hyperlink 内的 run（真丢字）、
    # docx/xlsx 表格缺 |---| 分隔行（不是合法 GFM）、老 .doc 依赖未打包的 LibreOffice。
    # **默认开（2026-08-10 owner 拍板 cutover，全量用户直切）**；显式 false 应急回退 =
    # extract_text() 走原生 extractor、字节级等价（有测试断言）。
    # 有意偏离本仓「新功能 ship-off 灰度」惯例的理由：原生链路在 docx 上**会丢字**
    # （python-docx 的 paragraph.text 不含超链接内的 run），off 等于 bug 继续存在；
    # 且任何失败都自动回落原生 extractor，最坏情况是「没变好」而不是「变坏」。
    # 详见 src/converter/anydoc_extract.py 模块 docstring。
    mailagent_anydoc_enabled: bool = Field(
        default=True, env="MAILAGENT_ANYDOC_ENABLED",
        description="是否用 anydoc 提取文档附件文本（docx/pptx/xlsx/老 .doc → GFM markdown）。默认开；显式 false 应急回退到原生 extractor。失败自动回落。",
    )
    # 🔴 `pdf` 有意不在默认值里：25 份真实 PDF 实测 20 份与 pypdf 持平、3 份回归，其中
    # 「伪粗体重复抽取」既不抛异常也不返回空 ⇒ 无判据可拦，会静默把垃圾写进 FTS 与 AI
    # context。收益≈0、风险明确。要开 PDF 就写成 "office,legacy,pdf"。
    mailagent_anydoc_lanes: str = Field(
        default="office,legacy", env="MAILAGENT_ANYDOC_LANES",
        description="anydoc 生效的 lane（逗号分隔，可选 office/legacy/pdf）。默认 office,legacy —— pdf 因实测回归有意不含。",
    )

    # 日历同步配置
    calendar_database_id: str = Field(default="", env="CALENDAR_DATABASE_ID")
    calendar_name: str = Field(default="日历", env="CALENDAR_NAME")
    calendar_past_days: int = Field(default=7, env="CALENDAR_PAST_DAYS")
    calendar_future_days: int = Field(default=90, env="CALENDAR_FUTURE_DAYS")
    calendar_sync_mode: str = Field(
        default="applescript",
        env="CALENDAR_SYNC_MODE",
        description="日历同步模式: applescript (更稳定，推荐) / eventkit (更快但可能丢失权限)"
    )

    # 混合同步模式配置
    # 🔴 sync_mode 目前**零消费者** —— 全仓（不限后缀）除本行外无任何读点，且 git log -S 显示
    # 它诞生于 v2 架构重构 15193f10 时就没有实现（同 commit 加入的 calendar_sync_mode 当场
    # 就有读点，它没有）。2026-07-27 已删掉它的 Settings 控件与两份受管键白名单 —— 那是纯
    # 止损：留着 UI 等于让用户以为自己能控制一件其实控制不了的事（改了、提示重启、重启后
    # 什么都不发生）。**字段有意保留**：删它等于替 owner 回答「这个同步模式到底还要不要」，
    # 那是语义决策不是清理。留着不显示，零成本零风险。要接实现或要彻底删，都需 owner 拍板。
    sync_mode: str = Field(default="hybrid", env="SYNC_MODE", description="同步模式: hybrid / applescript_only（当前无消费者，见上方注释）")
    radar_poll_interval: int = Field(default=5, env="RADAR_POLL_INTERVAL", description="雷达轮询间隔(秒)")
    reverse_sync_interval: int = Field(default=30, env="REVERSE_SYNC_INTERVAL", description="反向同步间隔(秒)")
    sync_date_mode: str = Field(default="relative", env="SYNC_DATE_MODE", description="日期模式: fixed / relative")
    sync_start_date: str = Field(default="2026-01-01", env="SYNC_START_DATE", description="fixed模式: 只同步此日期之后的邮件")
    sync_lookback_days: int = Field(default=14, env="SYNC_LOOKBACK_DAYS", description="relative模式: 只同步最近N天的邮件")
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
    # 草稿箱同步（davmail-only）：Exchange Drafts → email_metadata (mailbox='草稿箱')
    drafts_sync_enabled: bool = Field(
        default=True,
        env="DRAFTS_SYNC_ENABLED",
        description="同步 Exchange 草稿箱到本地（davmail-only，AppleScript 模式不激活）。"
                    "草稿仅入本地 SQLite（列表/数量/正文/FTS），不进 Notion / LLM / 飞书 / KOS。"
                    "全量 UID 对账（非增量）：编辑/发送/删除导致的草稿消失会同步删除本地行。",
    )

    # 入向已读回收（davmail-only，issue #58）：Outlook/OWA 等外部客户端标已读后把本地
    # is_read 单向收敛为 True（走 outbox→notion，绝不直调）。独立低频周期，绝不挂 5s
    # radar poll（未配 folderSizeLimit 的大邮箱 UID SEARCH 会触发 EWS 全量枚举，issue #46）。
    # 🔴 字段名 inbound_read_reconcile_* ≠ env MAILAGENT_INBOUND_READ_RECONCILE_* → 必须
    #    validation_alias（pydantic v2 忽略 Field(env=)，见本类顶 model_config 注释）。
    inbound_read_reconcile_enabled: bool = Field(
        default=False,
        validation_alias="MAILAGENT_INBOUND_READ_RECONCILE_ENABLED",
        description="是否启用入向「未读→已读」单向回收（davmail-only，AppleScript 模式不激活）。"
                    "默认关（灰度：同步核心 + EWS 限流雷区，dogfood 验证后再考虑翻默认）。"
                    "只做未读→已读单向（已读→未读 / flagged 不碰），只收件箱，恒走 outbox 派发。",
    )
    inbound_read_reconcile_interval_sec: int = Field(
        default=300,
        validation_alias="MAILAGENT_INBOUND_READ_RECONCILE_INTERVAL_SEC",
        description="入向已读回收的独立低频周期（秒），默认 300。与 5s radar poll 解耦，"
                    "避免每轮 UID SEARCH UNSEEN 重现 EWS 全量枚举限流事故。",
    )

    # 收件箱对账兜底（2026-08-11 丢邮件事故 · 方案 C）
    inbox_reconcile_enabled: bool = Field(
        default=False,
        validation_alias="MAILAGENT_INBOX_RECONCILE_ENABLED",
        description="是否启用收件箱对账兜底（davmail-only）。按 Message-ID 比对服务器与"
                    "本地，补抓漏掉的邮件。与漏抓成因无关，兜住增量链路的任何缺口"
                    "（含 UID 重编号这类未知成因）。默认关（灰度，ship-off → dogfood → "
                    "cutover）；false = 字节级 inert，不发任何 IMAP 命令。",
    )
    inbox_reconcile_interval_sec: int = Field(
        default=1800,
        validation_alias="MAILAGENT_INBOX_RECONCILE_INTERVAL_SEC",
        description="收件箱对账的独立低频周期（秒），默认 1800（30min）。"
                    "🔴 绝不挂 5s radar poll —— UID SEARCH 在大邮箱会重现 EWS 全量枚举"
                    "限流（issue #46）。",
    )
    inbox_reconcile_window_days: int = Field(
        default=2,
        validation_alias="MAILAGENT_INBOX_RECONCILE_WINDOW_DAYS",
        description="对账回看窗口（天），默认 2。漏抓只发生在增量边界附近，不需要全量。"
                    "🔴 上限受 DAVMAIL_FOLDER_SIZE_LIMIT 截断视图约束：实测 500 封视图下"
                    "14 天窗口即撞顶（窗口更老的邮件在 IMAP 层根本不可见），建议 ≤7 天。"
                    "撞顶时对账会记 incomplete 并告警，不会静默假装查全了。",
    )
    reconcile_notify_max_age_sec: int = Field(
        default=7200,
        validation_alias="MAILAGENT_RECONCILE_NOTIFY_MAX_AGE_SEC",
        description="对账补抓邮件的飞书通知年龄上限（秒），默认 7200（2h）。超龄只入库不推送。"
                    "🔴 只对 ingest_reason='inbox_reconcile' 的邮件生效 —— 正常增量路径"
                    "（含服务停机后补上的积压）不受此门约束，那些**应该**通知。",
    )

    # 飞书通知配置
    feishu_app_id: str = Field(default="", env="FEISHU_APP_ID", description="飞书应用 App ID")
    feishu_app_secret: str = Field(default="", env="FEISHU_APP_SECRET", description="飞书应用 App Secret")
    feishu_chat_id: str = Field(default="", env="FEISHU_CHAT_ID", description="飞书群聊 chat_id")
    feishu_webhook_url: str = Field(default="", env="FEISHU_WEBHOOK_URL", description="飞书自定义机器人 webhook URL（备用）")
    feishu_webhook_secret: str = Field(default="", env="FEISHU_WEBHOOK_SECRET", description="飞书 webhook 签名密钥（可选）")
    feishu_notify_enabled: bool = Field(default=False, env="FEISHU_NOTIFY_ENABLED", description="是否启用飞书通知")

    # =========================================================================
    # IM 对话 — 飞书（08-01 阶段 2 PR-2）。🔴 与上面的**通知** bot 完全隔离
    # （grill Q21=B）：独立自建应用 / 独立凭证 / 独立长连接，通知链一个字节不动。
    # 🔴 字段名 im_feishu_enabled ≠ env MAILAGENT_IM_FEISHU → 必须 validation_alias
    #    （pydantic v2 忽略 Field(env=)，见本类顶 model_config 注释）。
    # =========================================================================
    im_feishu_enabled: bool = Field(
        default=True, validation_alias="MAILAGENT_IM_FEISHU",
        description=(
            "飞书对话 bot 总闸。默认开（cutover 2026-08-04，owner dogfood 通过）；env 显式 "
            "false = 应急回退 → serve 进程不 spawn im_feishu worker、不建立任何长连接，"
            "gateway 侧工具面字节级回退。**双载体** —— 本 pydantic 字段（serve，翻开关需重启 "
            "serve）+ Node envBool（gateway，翻开关需重启 app），两侧默认必须同为 true。"
        ),
    )
    feishu_im_app_id: str = Field(
        default="", validation_alias="FEISHU_IM_APP_ID",
        description=(
            "飞书**对话** bot 的自建应用 App ID。🔴 仅作 external_credential"
            "（namespace='im:feishu'）的**首次 seed 默认** —— 行落地后行权威，改这里不再影响运行时"
            "（镜像 llm provider registry 先例）。🔴 勿复用通知 bot 的 FEISHU_APP_ID。"
        ),
    )
    feishu_im_app_secret: str = Field(
        default="", validation_alias="FEISHU_IM_APP_SECRET",
        description=(
            "飞书**对话** bot 的自建应用 App Secret。同 FEISHU_IM_APP_ID：仅首次 seed，"
            "之后密文存 agent_config.db 的 external_credential（Fernet + Keychain master key）。"
        ),
    )

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
    # task 07-14: 状态型告警 episode 化。🔴 字段名 ≠ env 键 → 必须 validation_alias
    # (pydantic v2 忽略 Field(env=)，见本类顶 model_config 注释)。
    alert_episode_enabled: bool = Field(
        default=True, validation_alias="MAILAGENT_ALERT_EPISODE",
        description=(
            "状态型告警（判据成立后不会自行消失：死信/不健康/雷达/outbox 积压/"
            "davmail token age）的 episode 语义总开关。on（默认）= 进入异常态告一次 → 中间"
            "静默 → 值翻倍才再告 → 恢复时告一次并复位，状态落 sync_state['alert.*']（跨"
            "进程重启存活，且告警**投递成功**才落）。env 显式 false = 应急回退，判据成立"
            "就告（仅剩 Alerter 的 ALERT_COOLDOWN 内存冷却兜底），字节级回到 episode 化"
            "之前的行为。注：restart_frequency 不受本开关管辖 —— 它自带 24h 持久冷却。"
        ),
    )
    # E4 WP2: outbox 积压告警 — 行龄 ≥5min 仍 pending 的条目数超过该值触发 warning
    alert_outbox_backlog_threshold: int = Field(default=100, env="ALERT_OUTBOX_BACKLOG_THRESHOLD", description="outbox 积压告警阈值（行龄≥5min 的 pending 条数）")

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
    task_identity_docs_enabled: bool = Field(
        default=True, env="TASK_IDENTITY_DOCS_ENABLED",
        description=(
            "把 Standing Context 身份文档（soul/user）注入 reports / LLM 邮件分类 / 灵动岛"
            "总结等后台任务的 system prompt（issue #31/#32 Part2 增量1）——让 Part1 去硬编码后的"
            "通用「用户」措辞被用户真实身份 grounding。默认开；off 时字节级回退通用表述。"
        ),
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
    tavily_api_key: str = Field(
        default="", env="TAVILY_API_KEY",
        description=(
            "Tavily 搜索 API Key（agent 的 web_search 工具走 Tavily 而非 DuckDuckGo —— "
            "DDG 国内被 GFW 阻断）。支持逗号分隔多 key（tvly-a,tvly-b），某 key 额度用尽自动"
            "切下一个；留空则回落 DuckDuckGo。web.py 热读 .env 为准（_resolve_tavily_key，"
            "保存即生效无需重启）+ 本冻结单例兜底；非 os.getenv。"
        ),
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
        description=(
            "Email Agent Context Notion 页面 ID。task 07-21 起语义收窄："
            "仅当预处理「参考上下文源」= notion_context 时被拼进分类 system prompt；"
            "不再注入 chat（chat 由 Standing Context 单源承担）。留空 = 不拼 notion context。"
        ),
    )
    llm_preprocess_context_source: str = Field(
        default="", env="LLM_PREPROCESS_CONTEXT_SOURCE",
        description=(
            "预处理分类 system prompt 的参考上下文源二选一（task 07-21 引入，07-22 迁行存储）："
            "'standing_docs' = 注入身份文档（沿用预处理行 context_docs 勾选）、不注入 notion；"
            "'notion_context' = 注入 LLM_CONTEXT_PAGE_ID 页面、不注入身份文档。"
            "🔴 task 07-22 起**运行时权威已迁 report_agent.context_source 行**（保存即生效，抽屉改值"
            "无需重启）—— 本 env 键仅作 v38 migration **首次 seed 默认**（显式合法值 → 写入行；"
            "留空/非法 → 按 LLM_CONTEXT_PAGE_ID 有无派生）；行落地后行权威，改此 env 不再影响运行时。"
        ),
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
    # ---- LLM 多 Provider 化（task 07-12；默认 on，2026-07-13 cutover）----
    # 🔴 字段名 llm_provider_registry_enabled ≠ env MAILAGENT_LLM_PROVIDER_REGISTRY → 必须
    #    validation_alias（pydantic v2 忽略 Field(env=)，见本类顶 model_config 注释）。
    llm_provider_registry_enabled: bool = Field(
        default=True, validation_alias="MAILAGENT_LLM_PROVIDER_REGISTRY",
        description=(
            "LLM 上游多 provider 体系总开关（agent_config.db 的 llm_provider/llm_model 表，"
            "prd 07-12）。on（默认，2026-07-13 cutover；删键 = on）= /chat/config "
            "enabledModels 聚合双表（default provider 输出裸 model id 保持兼容，其余输出 "
            "'providerId:modelId'）+ Python protocol 路由（provider_routing）；env 显式 "
            "false 应急回退 = 现状 .env LLM_ENABLED_MODELS 热读 + 前缀路由，字节级不变。"
            "Node gateway 侧读同名 env（main-env-only，同语义：显式 false 才 off）。"
        ),
    )
    memory_capture_model: str = Field(
        default="claude-haiku-4-5", validation_alias="MEMORY_CAPTURE_MODEL",
        description=(
            "M1 mem0 自动抽取记忆用的 LLM 模型名（经 CRS 的 anthropic 腿 /v1/messages，"
            "claude 标准格式）。默认 claude-haiku-4-5（便宜快，抽取每轮对话调一次）；"
            "MEMORY_CAPTURE_MODEL env 可覆盖。仅 MAILAGENT_MEM0_CAPTURE 开时生效。"
        ),
    )
    memory_md_budget_chars: int = Field(
        default=5000, validation_alias="MEMORY_MD_BUDGET_CHARS",
        description=(
            "memory.md 硬字符预算（Hermes 式有界记忆）。auto-capture 每轮把持久事实合并进 "
            "memory.md，超预算则同 memory_capture_model 斟酌淘汰最不重要/过时的条目压回。"
            "memory.md 恒注入每轮 system prompt（MAILAGENT_MEM0_RETRIEVAL 开时），故预算越大 "
            "= 每轮 token 成本越高。MEMORY_MD_BUDGET_CHARS env 可覆盖。"
        ),
    )
    mem0_explicit_edit_cooldown_s: int = Field(
        default=1800, validation_alias="MEM0_EXPLICIT_EDIT_COOLDOWN_S",
        description=(
            "07-15 harness-chat lane C — capture ↔显式编辑互斥冷却窗口（秒）。capture_turn 落库前 "
            "检查 memory.md 当前版本：updated_by ∈ {user, agent_proposed}（Settings 手编 / 已批准 "
            "的 agent_memory_update・agent_profile_restore 工具写）且距上次写入 < 本值 → 跳过本轮 "
            "auto-capture 合并（不烧 LLM、不落库，仅 loguru log）——防 haiku 后台改写管线在用户/"
            "agent 刚显式写入后的 ~20-25s 内又悄悄浓缩/改写它。updated_by='mem0'（capture 自己写的）"
            "不受影响，恒照常合并。MEM0_EXPLICIT_EDIT_COOLDOWN_S env 可覆盖；≤0 关闭冷却（每轮照常）。"
        ),
    )
    # 🔴 字段名 memory_layers_enabled ≠ env MAILAGENT_MEMORY_LAYERS → 必须 validation_alias
    #    （pydantic v2 忽略 Field(env=)，见本类顶 model_config 注释）。
    memory_layers_enabled: bool = Field(
        default=False, validation_alias="MAILAGENT_MEMORY_LAYERS",
        description=(
            "阶段 0.5-③ 记忆分层（PR-1，harness 扩展 epic）。on = memory.md auto-capture 走分层"
            "抽取：固定 5 个 h2 层（identity/preference/context/activity/experience）+ unsorted "
            "兜底节，tool schema 五字段承载、Python 确定性拼装/解析固定 h2、按层预算确定性截断"
            "（单层超预算只在本层内淘汰——修「activity/项目类稳定吃掉 identity/people 类」的生产"
            "实证事故）；首轮对未分节旧文档走一次性迁移模式（heuristic 预分桶 + LLM 重排）。"
            "off（默认）= 现有单预算全文重写路径字节级不变（应急回退零数据迁移——分节文档在旧"
            "路径仍是合法 markdown）。仅 capture 写侧；层预算是代码常量不 env 化。由 config.py "
            "pydantic 读：翻需重启 serve-api。"
        ),
    )
    user_md_compile_enabled: bool = Field(
        default=True, validation_alias="MAILAGENT_USER_MD_COMPILE",
        description=(
            "M3 user.md 偏好编译总开关。开时 Settings「从记忆编译偏好」按钮可见 + "
            "/api/chat/memory/compile-user-md 端点放行（load memory.md → LLM 合并现有 user.md "
            "→ 仅 changed 时 set_profile_doc('user', agent_proposed)）。默认开（2026-07 cutover）；"
            "显式设 false 时端点返回 E_DISABLED、按钮不渲染（M3c 起经 /chat/config 暴露 flag 态）。"
            "无 hot-path（手动触发）。"
        ),
    )
    standing_docs_editor_enabled: bool = Field(
        default=True, validation_alias="MAILAGENT_STANDING_DOCS_EDITOR",
        description=(
            "Settings 身份文档编辑器总开关（默认开）。开时 AI tab 出现「身份文档 / Standing Context」"
            "section，列出 SOUL/AGENT/RULES/USER 4 个文档，支持查看 + 手动编辑 + 版本历史/rollback。"
            "flag-off → section 字节级不渲染（DOM 无此区块）。singleton 读 —— 翻 flag 需重启 serve-api。"
        ),
    )

    # =========================================================================
    # KOS Producer (Sprint 19 M2 PR-2d) — 邮件 sync 完异步推 Jarvis KOS v2
    # 详见 docs/reference/llm-agent/kos-integration-design.md §3 + frontend/archive/2026-05/SPRINT19-M2-PLAN.md §3
    # KOSClient 默认从 env 直接读 3 个 OAuth 凭据 (KOS_MCP_BASE /
    # KOS_OAUTH_CLIENT_ID / KOS_OAUTH_CLIENT_SECRET), 这里仅暴露 producer 行为
    # 开关 + client 超时; 凭据不重复.
    # =========================================================================
    kos_timeout_seconds: float = Field(
        default=30.0, env="KOS_TIMEOUT_SECONDS",
        description=(
            "KOSClient 单次 HTTP 请求超时 (秒), 罩 POST /token 与 POST /mcp "
            "(tools/call: query / search / get_page / put_page ...)。issue #69: "
            "此前是 client.py 里 10.0 的硬编码, 本键是**无人读取**的孤儿 —— 2 万页"
            "自部署 gbrain (PGLite 单实例) 上单次 query 实测平均 9.1s, 10s 余量只剩"
            "10%, 已开始规律性超时。默认 30 (远程 MCP + 向量检索, 不是本地 SQLite)。"
            "🔴 GET /health 探活**不**受此值管辖 —— 它走独立短超时 "
            "(client.py _DEFAULT_HEALTH_TIMEOUT=5s), 因为 new_watcher 第 6c 步的"
            "「探活失败整段跳过」语义依赖它快速判死, 不能让 tick 挂 30s。"
        ),
    )
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
    kos_require_labeled: bool = Field(
        default=False, env="KOS_REQUIRE_LABELED",
        description=(
            "issue #49 — 「AI 从未标注优先级」是独立于优先级枚举的第三态, 默认被"
            "隐式并入 normal 后由 priority_floor 放行 (从未跑过 LLM 的历史邮件"
            "会大批混进知识库)。true = 未标注直接跳过, 不落 floor 的默认放行分支; "
            "增量 producer 与 bulk_ingest 两处过滤点同时生效。默认 false = 现状"
            "行为不变。bulk 侧可用 --require-labeled 覆盖。"
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
    # MCP Connector (08-01 阶段 1 PR1) — serve-api 持 MCP client 连外部服务
    # (Notion / Atlassian)。凭证走 agent_config.db external_credential (Fernet)。
    # 🔴 字段名 mcp_connectors_enabled ≠ env MAILAGENT_MCP_CONNECTORS → 必须
    #    validation_alias (pydantic v2 忽略 Field(env=), 见本类顶 model_config 注释)。
    # =========================================================================
    mcp_connectors_enabled: bool = Field(
        default=False, validation_alias="MAILAGENT_MCP_CONNECTORS",
        description=(
            "MCP connector 总闸 (灰度, 沿用 island ship-off→dogfood→cutover 模式): "
            "off 时 /api/connector/* 除 oauth/callback 外全部 409, 工具注入 (PR2) "
            "整体不激活。callback 永远只认 state 能力令牌 (off 时无活 rendezvous, "
            "天然 404)。pydantic 载体 = 翻开关需重启 serve-api。"
        ),
    )
    connector_timeout_seconds: float = Field(
        default=30.0,
        description=(
            "ConnectorClient 单次 HTTP 请求超时 (秒), 罩 OAuth metadata/token 端点与 "
            "MCP streamable http 全部请求 (issue #69 纪律: 超时报错带实际耗时)。"
            "🔴 唯一落点 = httpx2.AsyncClient(timeout=) — SDK provider 层没有生效的"
            "超时参数 (v1 的 timeout= 从未 bound 任何东西, v2 已删)。等浏览器 OAuth "
            "回调**不**受此值管辖 (client.py OAUTH_CALLBACK_TIMEOUT_SECONDS=300s)。"
        ),
    )
    # issue #59 KOS 入库可靠性: 推送失败落台账 (kos_ingest_log, DB v41) 后由
    # new_watcher 低频重试补偿。字段名 kos_retry_* ≠ env MAILAGENT_KOS_RETRY_* →
    # 必须 validation_alias (pydantic v2 忽略 Field(env=), 见本类顶 model_config 注释)。
    kos_retry_enabled: bool = Field(
        default=True,
        validation_alias="MAILAGENT_KOS_RETRY_ENABLED",
        description=(
            "KOS 推送失败重试扫描 (issue #59)。默认**开** (D1, 有意偏离新功能默认关"
            "惯例): 重试是纯补偿逻辑, 只重推本该推、且因 put_page 覆盖写而幂等的内容; "
            "MAILAGENT_KOS_INGEST_ENABLED=false 时整条链路本就不激活, 默认关的重试"
            "等于没修。显式 false 应急回退 (只推不补, 回 #59 修复前行为)。"
        ),
    )
    kos_retry_interval_sec: int = Field(
        default=300,
        validation_alias="MAILAGENT_KOS_RETRY_INTERVAL_SEC",
        description=(
            "KOS 健康探活失败后的冷却窗口 (秒), 默认 300。重试本体是主 tick 第 6c 步"
            "队列驱动 (3 封/tick, next_retry_at 排程, 镜像 LLM 重试队列); 本值只管"
            "探活失败后多久内不再探活/扫描, 防对着倒掉的 KOS 每 5s tick 空转。"
        ),
    )
    kos_retry_max_attempts: int = Field(
        default=5,
        validation_alias="MAILAGENT_KOS_RETRY_MAX_ATTEMPTS",
        description=(
            "单封邮件的 KOS 重试上限, 默认 5 (退避 1min/5min/15min/1h/6h)。"
            "超限转 dead (Dashboard 警示 + 手动 bulk --retry-failed 可捞)。"
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
    kos_consumer_enabled: bool = Field(
        default=False, validation_alias="MAILAGENT_KOS_CONSUMER_ENABLED",
        description=(
            "KOS consumer 面开关。/chat/config 的 kosConfigured = 本开关 AND OAuth 凭据"
            "齐全 (判据在 src/api/routers/chat.py), 它 gate 的是 KOS 使用指南块是否注入 "
            "system prompt。gateway 的 6 个 KOS 只读工具 (kos_query + issue #57 新增的 "
            "kos_search / kos_get_page / kos_find_experts / kos_list_pages / "
            "kos_get_backlinks) **恒注册**、不受此 gate; 未对接时调用返回 "
            "E_KOS_NOT_CONFIGURED 工具错误。"
        ),
    )
    kos_l1_hot_block_enabled: bool = Field(
        default=False, validation_alias="MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED",
        description="L1 hot block: chat start 按发件人预取 KOS people digest 注入 system prompt。",
    )
    kos_time_decay_enabled: bool = Field(
        default=True, validation_alias="MAILAGENT_KOS_TIME_DECAY_ENABLED",
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
        default=True, env="NOTION_READ_FROM_SQLITE",
        description=(
            "是否让 create_email_page_v2 优先走 SQLite SSoT 路径 (v4 P4-04)。"
            "默认 true (2026-07-11 生产观察窗口拍板：2026-07-05~07-11 263 hit / "
            "0 fallback_miss / 0 fallback_error)；`.env` 显式 false 应急回退老路径。"
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
    # T7: CJK 中文分词 (并行 trigram 表)
    # Phase A G-A6 (2026-06): 默认翻 True —— 中文为主用户的默认痛点 (裸搜「产品」命中不了
    # 「本周产品评审」内部) 是 review 头号缺口 (NS-1/PLANNED-B)。FTS5 trigram 内置零依赖、
    # 桌面规模成本可控 (R5 行业裁定支持默认 ON)。需 DB v24 迁移已建表 (本仓 DB v26 已含)。
    # 回滚: 置 False 即逐字节回到 trigram 引入前的 unicode61 fast-path。
    search_trigram_enabled: bool = Field(
        default=True, env="SEARCH_TRIGRAM_ENABLED",
        description=(
            "是否启用 CJK 中文子串搜索 (DB v24 并行 trigram 表 email_body_fts_trigram)。"
            "Phase A 起默认 True —— 中文子串召回是中文为主用户的默认期望。置 False 时搜索行为"
            "与 trigram 引入前逐字节一致 (走 email_body_fts unicode61 + smart_query_transform "
            "字符级 AND fallback)。开启后裸全文 query 的中文 term 走 trigram 路由: >=3 字 MATCH "
            "/ =2 字 trigram 表 LIKE 兜底 / 1 字拦截 + warning; 中英混合按 term 拆 (英文 "
            "unicode61 候选 ∩ 中文 trigram 候选)。英文/列级 FTS/附件融合不受影响。需先跑 DB "
            "v24 迁移建表 (CREATE ... IF NOT EXISTS + 幂等回填)。"
        ),
    )
    # 搜索批次 1 PR2 (2026-07-22): 含 CJK 混合 query 的拉丁 token 双 lane。
    # pydantic v2 按字段名映射 env → SEARCH_LATIN_TRIGRAM_ENABLED。
    search_latin_trigram_enabled: bool = Field(
        default=True,
        description=(
            "含 CJK 的裸全文 query 中, >=3 字符拉丁/数字 token 是否在 unicode61 整词 MATCH "
            "之外并行查 email_body_fts_trigram 子串 (组内并集, RRF 融合, 整词命中双 lane 叠加"
            "天然排前)。修复连写文档漏召回: 正文 'Omada固件升级' (无空格) 被 unicode61 切成"
            "单 token → query 'Omada 固件升级' 的 MATCH Omada 零命中 → AND 交集清空整查询。"
            "默认 True; 显式 false 应急回退 = 拉丁 token 回单 unicode lane (PR2 前行为, 逐字节)。"
            "仅影响 SEARCH_TRIGRAM_ENABLED=true 且 query 含 CJK 的裸查路径; 纯英文裸查 / "
            "parsed / raw / recipient 路径不受影响。SEARCH_TRIGRAM_ENABLED=false 时整个 "
            "trigram 路由不存在, 本开关无意义。"
        ),
    )

    # =========================================================================
    # Sprint 15: SQLite SSoT inversion (email_outbox + FanoutWorker)
    # E2-B (2026-07): outbox 灰度永久化 —— FanoutWorker 恒启用, 总开关
    # MAILAGENT_OUTBOX_ENABLED 退役 (model_config extra='ignore' 使 .env 残留键
    # 无害)。灰度依据: serve-api 写面 (mail_write.set_flags) 从来恒入队不受门控,
    # off 安装态下条目无人消费 = 半坏; 详 e2-subtraction-sprint.md §3。
    # =========================================================================
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
    # 详见 docs/reference/architecture/backend-service-migration-matrix.md C1 + plan §C1。
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
    island_mail_notify_scope: str = Field(
        default="important", env="ISLAND_MAIL_NOTIFY_SCOPE",
        description="邮件通知上岛范围。important（默认）= 仅 AI 判定重要及以上级别弹卡："
                    "MailReceived 一律静默（该时点无 priority），LLMReviewed(Urgent) 仅"
                    "🔴 紧急 / 🟡 重要发。all = 每封新邮件 + 全部 LLM 结果都弹（旧行为回退开关）。"
                    "非邮件卡（日历 / DeadLetter / agent 审批等）不受影响。",
    )
    # ---- 灵动岛 harness agent 上岛（Part B，默认开，完全离岛 gateway 服务端 resume）----
    # 🔴 字段名 island_agent_enabled ≠ env MAILAGENT_ISLAND_AGENT_ENABLED → 必须 validation_alias
    #    (pydantic v2 忽略 Field(env=)，见本类顶 model_config 注释)。默认开（E3 cutover，
    #    2026-07-06，owner 终拍）→ serve-api /api/island/agent/announce 正常登记 + 发卡；
    #    无岛（Ping Island 未装/未跑）时 announce 是 fail-open no-op（socket send 失败仅 debug
    #    日志，不抛、不重试、不入队，有直接单测），非报错。env 显式 false = 应急回退。
    island_agent_enabled: bool = Field(
        default=True, validation_alias="MAILAGENT_ISLAND_AGENT_ENABLED",
        description="是否启用 harness agent(前端 chat)审批上灵动岛（Part B）。gated by ping_island_enabled；"
                    "开时 AI SDK Gateway 需审批的写工具会把审批卡推上岛，岛上点批准经解耦 ack 通道触发"
                    "gateway 服务端 resume（用户完全离开 app 也能执行）。默认开（E3 cutover 2026-07-06，"
                    "owner 终拍）；无岛时 fail-open 静默 no-op（有单测），env 显式 false 应急回退。",
    )

    # ---- 灵动岛 Phase 3 DailyDigest（每日巡检，默认关闭，gate by ping_island_enabled）----
    mailagent_daily_digest_enabled: bool = Field(
        default=False, env="MAILAGENT_DAILY_DIGEST_ENABLED",
        description="是否启用灵动岛每日巡检（DailyDigest）；island 开 + 此开关开才跑。默认关。",
    )
    mailagent_daily_digest_hours: str = Field(
        default="9,18", env="MAILAGENT_DAILY_DIGEST_HOURS",
        description="每日巡检触发钟点（本机系统时区，逗号分隔小时），默认 9,18。",
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

    # ---- Custom Agent 内核（S4, src/agents；默认关，flag-off 字节级不变）----
    # 🔴 字段名 custom_agents_enabled ≠ env MAILAGENT_CUSTOM_AGENTS_ENABLED → 必须 validation_alias
    custom_agents_enabled: bool = Field(
        default=True, validation_alias="MAILAGENT_CUSTOM_AGENTS_ENABLED",
        description=(
            "Custom Agent 内核总开关（S4：cron/email_filter 触发 → gateway headless run）。"
            "默认开（E3 cutover，2026-07-06；v1.4.0 dogfood 全 flag-on 通过 R1-R5）；env 显式 false "
            "= 应急回退 → new_watcher 第 5 hook 不 fire、AgentTriggerWorker 不启、"
            "agent_run 触发/入队全灭（字节级回 S3 终态）。per-agent 仍需 report_agent.enabled + type='custom' "
            "才真正激活某个 agent（on 但不配 grant/规则 = 恒 HITL，per-agent opt-in 是天然开关）。"
        ),
    )
    # 🔴 字段名 internal_agent_tools_enabled ≠ env MAILAGENT_INTERNAL_AGENT_TOOLS → 必须 validation_alias
    internal_agent_tools_enabled: bool = Field(
        default=True,
        validation_alias="MAILAGENT_INTERNAL_AGENT_TOOLS",
        description=(
            "内建 agent 工具面（task 08-14）：主 agent 可 list/get/update `report_agent` 表里"
            "**非 custom** 的四类内建 agent（report / search / preprocess / project_progress），"
            "外加事项跟进配置的逐条读写。**默认开**（有意偏离 ship-off 惯例：它修的是「主 agent "
            "对自己的 agent 全盲」—— owner 库里零 custom 行，custom_agent_list 恒返回空列表；"
            "off = 痛点依旧。manual-only（class capability_change）+ 写工具恒 ask 已是安全地板，"
            "同 P0 plan_tool 先例）。env 显式 false = 应急回退 → 三件套与 matter_followup_mutate "
            "都不注册，ToolSet 字节级回 08-14 前。"
            "🔴 双载体：本 pydantic 字段（serve-api，翻需重启后端）+ Node envBool"
            "（ai_gateway_lifecycle.ts，main-env-only 不加 vite define，翻需重启 app）——"
            "两侧默认必须同为 true，回退也一起翻。"
        ),
    )
    matters_enabled: bool = Field(
        default=True,
        validation_alias="MAILAGENT_MATTERS_ENABLED",
        description=(
            "Matters/事项工作台总闸（一级导航「事项」+ /api/matters/* + matter 工具家族）。"
            "默认开（2026-08-12 owner 拍板：事项是核心功能，一级导航默认显示）；env 显式 false "
            "= 应急回退 → 导航项不渲染、matters router 全 403、gateway matter 工具家族不注册。"
            "🔴 与 MAILAGENT_MATTER_AGENT_ENABLED 是两件事：跟进 Agent（无人值守 + 有网络出口）"
            "仍默认关，本 flag 翻默认不带它一起翻。Restart required after changing it."
        ),
    )
    matter_agent_enabled: bool = Field(
        default=False,
        validation_alias="MAILAGENT_MATTER_AGENT_ENABLED",
        description=(
            "Matter 跟进 Agent (P4) feature flag：runs/propose 端点 + matter_followup "
            "worker 分派 + spec assembler。语义 AND：MAILAGENT_MATTERS_ENABLED off 时"
            "本 flag 无意义（matters router 全 403 在前）。off 时 updates/review REST "
            "仍可用（清账既有 pending 提案）。Restart required after changing it."
        ),
    )

    # =========================================================================
    # 通讯录 Contact Directory (task 08-13 WP1)
    # 🔴 字段名 contacts_enabled ≠ env MAILAGENT_CONTACTS_ENABLED → 必须
    #    validation_alias（pydantic v2 忽略 Field(env=)，见本类顶 model_config 注释）。
    # =========================================================================
    contacts_enabled: bool = Field(
        default=False,
        validation_alias="MAILAGENT_CONTACTS_ENABLED",
        description=(
            "通讯录总闸（灰度默认关，ship-off → dogfood → cutover）。on = new_watcher "
            "挂 L0+L1 提取扫描独立低频节拍（email_metadata → contact 三表账本/聚合）；"
            "off = 字节级 inert（零 SQL 零 tick，CLI contact backfill 亦拒绝）。"
            "schema (v54 三表) 与本 flag 解耦——表恒在，开关只管运行时行为。"
            "Restart required after changing it."
        ),
    )
    contact_extract_interval_sec: int = Field(
        default=120,
        validation_alias="MAILAGENT_CONTACT_EXTRACT_INTERVAL_SEC",
        description=(
            "通讯录 L0+L1 扫描的独立低频周期（秒），默认 120。🔴 绝不挂 5s radar "
            "poll（镜像 inbox_reconcile 的节拍纪律）；每 tick 有界批（500 封/批 + "
            "墙钟预算），积压时单 tick 多消化几批、追平后回低频。"
        ),
    )
    self_emails: str = Field(
        default="",
        validation_alias="MAILAGENT_SELF_EMAILS",
        description=(
            "owner 历史自有地址集（逗号分隔，Q8 拍板 env 起步）。与 USER_EMAIL 一起"
            "构成自有地址集：发出的邮件按出向计 sent_to_count（双向性判据）、compose "
            "收件人补全里排除自己。🔴 task 08-14 WP-3 起**降级为兜底** —— 自有地址"
            "照常建通讯录行，权威源是库里 is_self=1 那条联系人名下的全部锚点（往「我」"
            "里合并旧邮箱即可，无需在此配置）；本键也**不参与**「我」的自动引导（引导"
            "只认 USER_EMAIL，防同名误标）。改动后建议 `mailagent contact backfill "
            "--rescan` 重扫收敛历史口径。"
        ),
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
            "邮件后端选择: 'applescript' (默认, Mail.app + AppleScript v3 路径, mac-only) | "
            "'davmail' (DavMail IMAP/SMTP, PRIMARY when 切换) | "
            "'outlook_com' (task 08-12, Windows-only: 本机 classic Outlook COM 自动化, "
            "非 win32 平台 factory 直接 raise). 启动时 backend factory "
            "probe 失败 → BackendStartupError + print 切换提示 + exit(1) (PM2 autorestart=false). "
            "切换是手动 single-driver, 没有自动 fallback. davmail 模式启动前确认 "
            "`pm2 ls | grep davmail-poc` online. "
            "🔴 值域被前端手抄 (onboarding/ipc.ts BackendKind), 改值域两边同步."
        ),
    )
    mailagent_marker_backend_guard: bool = Field(
        default=True, validation_alias="MAILAGENT_MARKER_BACKEND_GUARD",
        description=(
            "issue #34: 切 backend 时防 last_max_row_id (marker) id-space 混用。marker 在 "
            "applescript 是 Mail.app ROWID (~10^5)、在 davmail 是 IMAP UID (~10^5-10^6 稀疏)，"
            "跨切换复用会让 get_new_emails 发 `UID {外来marker+1}:*` → 要么静默跳过整段未取"
            "区间 (丢数据) 要么超时重刷巨量 (卡死)。on (默认): 启动时若当前 backend 与写下 "
            "marker 的 backend 不符 → 把 marker 重 baseline 到当前 backend 的 max (等同 "
            "first-run，只向前不回捞；历史 gap 由 backfill 兜)；本 guard 首次"
            "部署遇既有 marker = 认领不重置 (不扰动存量稳态用户)。off = 回退旧行为 (跨切换"
            "直接复用 marker，即 #34 的 bug)。仅启动时判定一次。"
        ),
    )
    davmail_imap_host: str = Field(
        default="127.0.0.1", validation_alias="DAVMAIL_HOST",
        description="DavMail JVM bind 地址 (PM2 davmail-poc 默认仅 127.0.0.1, 勿暴露公网)",
    )
    davmail_root: str = Field(
        default="", env="DAVMAIL_ROOT",
        description=(
            "davmail-poc 部署目录绝对路径 (watchdog 读 token/token.dat mtime + "
            "logs/davmail.log)。留空 = 仓库根/davmail-poc (pm2 dev 模式 OK); "
            "打包 .app 里 _REPO_ROOT 解析进 site-packages 找不到 token → 看板 "
            "token 状态恒'未知', 必须在 userData .env 配绝对路径。"
        ),
    )
    davmail_imap_port: int = Field(
        default=1143, env="DAVMAIL_IMAP_PORT", description="DavMail IMAP 端口",
    )
    davmail_smtp_port: int = Field(
        default=1025, env="DAVMAIL_SMTP_PORT", description="DavMail SMTP submission 端口",
    )
    davmail_cipher_key: str = Field(
        default="",
        # issue #52: 老用户 .env 是 DAVMAIL_CIPHER_KEY（旧文档/报错曾用此名），只认
        # POC 键会让升级后 serve 静默罢工 —— 双名兼容，POC 键优先（现行为不变）。
        validation_alias=AliasChoices("DAVMAIL_POC_CIPHER_KEY", "DAVMAIL_CIPHER_KEY"),
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
    davmail_status_timeout_sec: int = Field(
        default=30, env="DAVMAIL_STATUS_TIMEOUT_SEC",
        description=(
            "DavMail INBOX STATUS(UIDNEXT) 查询 timeout (秒), 默认 30. "
            "超大 INBOX (7万+) 的 STATUS 偶发慢过 30s → 查询失败 (raise "
            "MarkerUnavailableError, 不再塌成 marker 0, 见 task 07-14 L3); "
            "大邮箱可调到 90. check_for_changes 每轮同步阻塞调用此查询, "
            "故默认保守 30 不拖慢全体轮询, 由大邮箱部署按需上调."
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
    davmail_folder_size_limit: int = Field(
        default=500, env="DAVMAIL_FOLDER_SIZE_LIMIT",
        description=(
            "DavMail IMAP 文件夹视图只保留最近 N 封 (写进 davmail.properties 的 "
            "davmail.folderSizeLimit)。>10k 的大邮箱不配这项时, 每次 SELECT/STATUS 都让 "
            "DavMail 经 EWS 全量枚举 → 超时、同步停摆 (2026-07-24 事故: 10617 封收件箱, "
            "裸 IMAP greeting 16.7s)。mail-sync 启动时 (仅 davmail 模式) 同步进 "
            "<DAVMAIL_ROOT>/config/davmail.properties, **需重启 davmail 桥才生效**; "
            "找不到该文件 = 不生效 (状态落 sync_state davmail.folder_size_limit.*, "
            "Settings 面如实显示)。0 = MailAgent 不管理该键, DavMail 用自身配置。"
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
    davmail_login_probe_enabled: bool = Field(
        default=True, env="DAVMAIL_LOGIN_PROBE_ENABLED",
        description=(
            "watchdog 每轮 (60s) 在 IMAP TCP 可达时做一次真实 IMAP LOGIN 探测 — 抓"
            "「端口活 / SMTP 正常但 IMAP LOGIN 持续失败」的 token 劣化形态 "
            "(2026-06-12 事故特征, 纯 TCP probe 抓不到)。显式 false = 回退 "
            "TCP/token 年龄/日志三信号老行为 (应急)。"
        ),
    )
    davmail_login_probe_timeout_sec: int = Field(
        default=15, env="DAVMAIL_LOGIN_PROBE_TIMEOUT_SEC",
        description="IMAP LOGIN 健康探测超时 (秒)。",
    )
    davmail_login_fail_threshold: int = Field(
        default=3, env="DAVMAIL_LOGIN_FAIL_THRESHOLD",
        description=(
            "连续 LOGIN 失败达此阈值 → level critical + 飞书告警 (login degraded)。"
            "watchdog 每轮把生效值经 sync_state davmail.login_fail_threshold 传播到"
            "展示端 (admin router / electron), 四个健康读面读同一值, 改非默认值不再漂移。"
        ),
    )
    davmail_auto_restart_enabled: bool = Field(
        default=False, env="DAVMAIL_AUTO_RESTART_ENABLED",
        description=(
            "L2b: LOGIN 连续失败达阈值后是否自动 `pm2 restart davmail-poc` 自愈。"
            "默认关 (重启中断在途 IMAP 会话, 破坏性动作保守默认), owner 显式开。"
            "关 = watchdog 仅告警。开着但 pm2 解析不到 (纯 .app 无 node bin) 时 "
            "callback 自身降级为仅告警, 不误伤。"
        ),
    )
    davmail_auto_restart_cooldown_sec: int = Field(
        default=600, env="DAVMAIL_AUTO_RESTART_COOLDOWN_SEC",
        description="两次自动重启最小间隔 (秒), 防 flap; 重启成败都进冷却。",
    )
    davmail_auto_restart_max_per_day: int = Field(
        default=6, env="DAVMAIL_AUTO_RESTART_MAX_PER_DAY",
        description=(
            "24h 滚动窗口内自动重启上限。达上限 → 停自动重启 + critical 告警 "
            "(镜像 supervise crashloop_stopped 语义: 反复重启说明根因未解须人工), "
            "窗口滚出后自动恢复。"
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
    calendar_reminder_lead_minutes: int = Field(
        default=10, env="CALENDAR_REMINDER_LEAD_MINUTES",
        description=(
            "会前灵动岛提醒提前量 (分钟, epic 阶段2·2.5). 挂 CalendarSyncWorker "
            "60s poll 顺路检查, 同 occurrence 只提醒一次; PING_ISLAND_ENABLED 关 / "
            "无岛时静默 fail-open."
        ),
    )
    caldav_op_timeout_seconds: int = Field(
        default=60, env="CALDAV_OP_TIMEOUT_SECONDS",
        description=(
            "CalDAV 单次操作 per-op 超时 (秒, task 07-15 / #37 最小修). caldav lib "
            "的 timeout=30 保护不到响应 body 读 (niquests 裸 sock.recv), EWS 节流"
            "窗口内写操作会盲挂数分钟; 超过此值抛 CalDAVTimeoutError. 被放弃线程"
            "可能事后完成操作, 错误文案为「可能仍在执行」. EWS 慢时合法操作数秒~"
            "数十秒, 60s 之外几乎必是节流挂死."
        ),
    )

# 全局配置实例
config = Config()


# =============================================================================
# Notion 可选化判定（task 07-12 P3b 方案 C）—— 四面共用的单一判据 helper，
# 防止 watcher / service / meeting_sync / hooks 各自 `if config.notion_token` 漂移。
# cfg 参数供测试注入；缺省读全局单例（call-time 取值，import 顺序无关）。
# =============================================================================


def notion_enabled(cfg: "Config | None" = None) -> bool:
    """邮件镜像面是否启用：NOTION_TOKEN 与 EMAIL_DATABASE_ID 双非空。

    False = 本地-only 模式：new_watcher 主链跳过 Notion 页创建（mark_synced_local）、
    reverse sync loop / 项目周报不启动；LLM 分类等钩子照跑（SQLite 腿不受影响）。
    """
    c = cfg if cfg is not None else config
    return bool(
        (c.notion_token or "").strip() and (c.email_database_id or "").strip()
    )


def calendar_notion_enabled(cfg: "Config | None" = None) -> bool:
    """日历 Notion 面是否启用：NOTION_TOKEN 与 CALENDAR_DATABASE_ID 双非空。

    False = 会议邀请→Notion 日程同步 + meeting expansion loop 跳过（本地邮件同步不受影响）。
    """
    c = cfg if cfg is not None else config
    return bool(
        (c.notion_token or "").strip() and (c.calendar_database_id or "").strip()
    )
