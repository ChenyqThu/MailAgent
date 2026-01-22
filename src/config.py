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

    # 同步配置
    check_interval: int = Field(default=5, env="CHECK_INTERVAL")
    max_batch_size: int = Field(default=10, env="MAX_BATCH_SIZE")
    sync_existing_unread: bool = Field(default=True, env="SYNC_EXISTING_UNREAD")

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

# 全局配置实例
config = Config()
