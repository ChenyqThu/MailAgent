"""Web API 配置。继承主项目 pydantic_settings 模式。"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class WebConfig(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # 服务
    web_api_port: int = Field(default=8200, env="WEB_API_PORT")
    web_api_token: str = Field(default="", env="WEB_API_TOKEN")

    # 数据库（只读）
    sync_store_db_path: str = Field(
        default="data/sync_store.db", env="SYNC_STORE_DB_PATH"
    )
    web_body_cache_db: str = Field(
        default="data/body_cache.db", env="WEB_BODY_CACHE_DB"
    )

    # Redis
    redis_url: str = Field(default="redis://localhost:6379", env="REDIS_URL")
    redis_db: int = Field(default=2, env="REDIS_DB")

    # Notion (用于构造链接)
    email_database_id: str = Field(default="", env="EMAIL_DATABASE_ID")


web_config = WebConfig()
