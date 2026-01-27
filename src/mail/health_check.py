"""
SyncHealthCheck - 同步健康检查模块

定期全量对比 SQLite 和 Notion，找出遗漏的邮件。
"""

from datetime import datetime
from typing import List, Optional, Set

from loguru import logger

from src.mail.sqlite_radar import SQLiteRadar
from src.notion.sync import NotionSync


class SyncHealthCheck:
    """同步健康检查 - 定期全量对比找遗漏的邮件"""

    DEFAULT_CHECK_INTERVAL = 3600  # 每小时检查一次

    def __init__(
        self,
        radar: SQLiteRadar,
        notion_sync: NotionSync,
        check_interval: int = None
    ):
        self.radar = radar
        self.notion_sync = notion_sync
        self.check_interval = check_interval or self.DEFAULT_CHECK_INTERVAL
        self.last_check: Optional[datetime] = None
        self.last_missing_count: int = 0

    async def check(self) -> List[int]:
        """对比 SQLite 和 Notion，返回遗漏的 row_id 列表

        1. 获取 SQLite 中所有符合条件的 row_id
        2. 获取 Notion 中所有已同步的 row_id
        3. 返回差集（遗漏的邮件）
        """
        logger.info("Starting health check...")

        # 1. 从 SQLite 获取所有有效 row_id
        sqlite_row_ids = self.radar.get_all_valid_row_ids()
        logger.debug(f"SQLite has {len(sqlite_row_ids)} valid emails")

        # 2. 从 Notion 获取已同步的 row_id
        notion_row_ids = await self.notion_sync.query_all_row_ids()
        logger.debug(f"Notion has {len(notion_row_ids)} synced emails")

        # 3. 计算差集
        missing = sqlite_row_ids - notion_row_ids

        self.last_check = datetime.now()
        self.last_missing_count = len(missing)

        if missing:
            logger.warning(f"Health check found {len(missing)} missing emails")
        else:
            logger.info("Health check passed: no missing emails")

        return sorted(list(missing), reverse=True)  # 最新的在前

    def should_check(self) -> bool:
        """是否应该进行健康检查"""
        if self.last_check is None:
            return True
        elapsed = (datetime.now() - self.last_check).total_seconds()
        return elapsed >= self.check_interval

    def get_status(self) -> dict:
        """获取健康检查状态"""
        return {
            "last_check": self.last_check.isoformat() if self.last_check else None,
            "last_missing_count": self.last_missing_count,
            "check_interval": self.check_interval,
            "next_check_in": self._get_next_check_seconds()
        }

    def _get_next_check_seconds(self) -> Optional[int]:
        """获取距离下次检查的秒数"""
        if self.last_check is None:
            return 0
        elapsed = (datetime.now() - self.last_check).total_seconds()
        remaining = self.check_interval - elapsed
        return max(0, int(remaining))

    def force_check_on_next_call(self):
        """强制下次调用时执行检查"""
        self.last_check = None
