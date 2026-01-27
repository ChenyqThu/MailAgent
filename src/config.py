from pydantic_settings import BaseSettings
from pydantic import Field, field_validator
from typing import List

class Config(BaseSettings):
    """配置类"""

    # Notion 配置
    notion_token: str = Field(..., env="NOTION_TOKEN")
    email_database_id: str = Field(..., env="EMAIL_DATABASE_ID")

    # 用户配置
    user_email: str = Field(..., env="USER_EMAIL")
    mail_account_name: str = Field(default="Exchange", env="MAIL_ACCOUNT_NAME")
    mail_inbox_name: str = Field(default="收件箱", env="MAIL_INBOX_NAME")

    # 日志配置
    log_level: str = Field(default="INFO", env="LOG_LEVEL")
    log_file: str = Field(default="logs/sync.log", env="LOG_FILE")

    # 附件配置
    max_attachment_size: int = Field(default=20971520, env="MAX_ATTACHMENT_SIZE")  # 20MB (Notion limit)
    allowed_attachment_types: str = Field(
        default=".pdf,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.docx,.xlsx,.pptx,.csv,.txt,.zip,.rar,.7z,.mp4,.mov,.avi,.eml",
        env="ALLOWED_ATTACHMENT_TYPES"
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

    # 多邮箱同步配置
    sync_mailboxes: str = Field(
        default="收件箱",
        env="SYNC_MAILBOXES",
        description="要同步的邮箱列表，逗号分隔。例如: 收件箱,已发送"
    )
    mail_sent_name: str = Field(default="已发送", env="MAIL_SENT_NAME", description="发件箱名称（AppleScript用）")

    # 初始化同步配置
    init_batch_size: int = Field(default=100, env="INIT_BATCH_SIZE", description="初始化时每批获取邮件数量")
    applescript_timeout: int = Field(default=200, env="APPLESCRIPT_TIMEOUT", description="AppleScript超时时间(秒)")

    @field_validator('allowed_attachment_types')
    @classmethod
    def parse_allowed_types(cls, v):
        """将逗号分隔的字符串转换为列表"""
        if isinstance(v, str):
            return [ext.strip() for ext in v.split(',')]
        return v

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"  # 忽略 .env 中未定义的额外变量

# 全局配置实例
config = Config()
