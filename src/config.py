from pydantic_settings import BaseSettings
from pydantic import Field, ConfigDict
from typing import List

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

    # 多邮箱同步配置
    sync_mailboxes: str = Field(
        default="收件箱",
        env="SYNC_MAILBOXES",
        description="要同步的邮箱列表，逗号分隔。例如: 收件箱,已发送"
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

    # 初始化同步配置
    init_batch_size: int = Field(default=100, env="INIT_BATCH_SIZE", description="初始化时每批获取邮件数量")
    applescript_timeout: int = Field(default=200, env="APPLESCRIPT_TIMEOUT", description="AppleScript超时时间(秒)")

    # 看板统计上报配置
    stats_report_url: str = Field(default="", env="STATS_REPORT_URL", description="看板统计上报 URL（如 https://mailagent.chenge.ink/api/stats/report）")
    stats_report_interval: int = Field(default=60, env="STATS_REPORT_INTERVAL", description="统计上报间隔(秒)")
    stats_report_token: str = Field(default="", env="STATS_REPORT_TOKEN", description="上报认证 token（默认复用 WEBHOOK_SECRET）")

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

    # Evelyn 周项目同步（外挂模块）
    # 总开关：默认关闭，防止其他协作者拉取代码后意外执行（他们没有对应 Notion 权限）。
    # 本地需手动在 .env 设 EVELYN_SYNC_ENABLED=true 才能启用 CLI 或钩子。
    evelyn_sync_enabled: bool = Field(
        default=False,
        env="EVELYN_SYNC_ENABLED",
        description="Evelyn 周项目同步模块的总开关（CLI + 钩子）。默认关。",
    )
    evelyn_auto_sync_enabled: bool = Field(
        default=False,
        env="EVELYN_AUTO_SYNC_ENABLED",
        description="new_watcher 检测到 Evelyn 周项目邮件后是否自动触发同步（需同时打开 EVELYN_SYNC_ENABLED）",
    )
    evelyn_sender: str = Field(
        default="evelyn.wei@tp-link.com",
        env="EVELYN_SENDER",
        description="Evelyn 发件人 email（包含即匹配）",
    )
    evelyn_subject_pattern: str = Field(
        default=r"【项目进度】项目deadline汇报.*市场产品",
        env="EVELYN_SUBJECT_PATTERN",
        description="Evelyn 周项目邮件标题正则",
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

# 全局配置实例
config = Config()
