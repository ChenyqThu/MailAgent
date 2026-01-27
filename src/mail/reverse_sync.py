"""
反向同步模块: Notion -> Mail.app

当 AI 审核完邮件后，将操作同步回 Mail.app。
支持的操作:
- Mark Read: 标记已读
- Flag Important: 设置旗标
- Mark Read and Flag: 标记已读并设置旗标
- Archive: 归档（当前实现为标记已读）

Usage:
    from src.mail.reverse_sync import NotionToMailSync
    from src.notion.sync import NotionSync
    from src.mail.applescript_arm import AppleScriptArm

    # 初始化
    reverse_sync = NotionToMailSync()

    # 或者使用自定义组件
    notion_sync = NotionSync()
    arm = AppleScriptArm(account_name="Exchange", inbox_name="收件箱")
    reverse_sync = NotionToMailSync(notion_sync=notion_sync, arm=arm)

    # 检查并同步
    stats = await reverse_sync.check_and_sync()
    print(f"Synced: {stats['synced']}, Failed: {stats['failed']}")
"""

from datetime import datetime
from typing import Dict, List, Optional
from loguru import logger

from src.mail.applescript_arm import AppleScriptArm
from src.notion.sync import NotionSync


class NotionToMailSync:
    """反向同步: Notion -> Mail.app

    当 AI 审核完邮件后，将操作同步回 Mail.app
    """

    # 支持的 AI Action 类型
    ACTION_MARK_READ = "Mark Read"
    ACTION_FLAG_IMPORTANT = "Flag Important"
    ACTION_MARK_READ_AND_FLAG = "Mark Read and Flag"
    ACTION_ARCHIVE = "Archive"

    def __init__(
        self,
        notion_sync: NotionSync = None,
        arm: AppleScriptArm = None
    ):
        """初始化反向同步器

        Args:
            notion_sync: NotionSync 实例，用于查询和更新 Notion 页面
            arm: AppleScriptArm 实例，用于操作 Mail.app
        """
        self.notion_sync = notion_sync or NotionSync()
        self.arm = arm or AppleScriptArm()
        self.last_check: Optional[datetime] = None
        self.sync_count = 0
        self.error_count = 0

        logger.info("NotionToMailSync initialized")

    async def check_and_sync(self) -> Dict[str, int]:
        """检查 Notion 状态变更并同步到 Mail.app

        查询条件:
        - AI Review Status = "Reviewed"
        - Synced to Mail = False

        Returns:
            统计信息: {synced: int, failed: int, skipped: int}
        """
        stats = {"synced": 0, "failed": 0, "skipped": 0}

        try:
            # 查询需要处理的页面
            pages = await self.notion_sync.query_pages_for_reverse_sync()

            if not pages:
                logger.debug("No pages need reverse sync")
                self.last_check = datetime.now()
                return stats

            logger.info(f"Found {len(pages)} pages for reverse sync")

            for page in pages:
                try:
                    success = await self.sync_single_page(page)
                    if success:
                        stats["synced"] += 1
                    else:
                        stats["skipped"] += 1
                except Exception as e:
                    page_id = page.get("page_id", "unknown")
                    logger.error(f"Failed to sync page {page_id}: {e}")
                    stats["failed"] += 1

            # 更新统计
            self.sync_count += stats["synced"]
            self.error_count += stats["failed"]

            logger.info(
                f"Reverse sync completed: "
                f"synced={stats['synced']}, "
                f"failed={stats['failed']}, "
                f"skipped={stats['skipped']}"
            )

        except Exception as e:
            logger.error(f"Reverse sync check failed: {e}")

        self.last_check = datetime.now()
        return stats

    async def sync_single_page(self, page: Dict) -> bool:
        """同步单个 Notion 页面到 Mail.app

        Args:
            page: 包含 page_id, message_id, ai_action 的字典

        Returns:
            是否成功
        """
        page_id = page.get("page_id")
        message_id = page.get("message_id")
        ai_action = page.get("ai_action")

        # 验证 message_id
        if not message_id:
            logger.warning(f"Page {page_id} has no Message ID, skipping")
            return False

        # 截断 message_id 用于日志显示
        message_id_short = message_id[:40] + "..." if len(message_id) > 40 else message_id

        logger.info(f"Syncing to Mail: {message_id_short} action={ai_action}")

        success = False

        # 根据 AI Action 执行对应操作
        if ai_action == self.ACTION_MARK_READ:
            success = self._execute_mark_read(message_id)

        elif ai_action == self.ACTION_FLAG_IMPORTANT:
            success = self._execute_flag(message_id)

        elif ai_action == self.ACTION_MARK_READ_AND_FLAG:
            success = self._execute_mark_read_and_flag(message_id)

        elif ai_action == self.ACTION_ARCHIVE:
            # 暂时只标记已读，Archive 功能可后续添加
            success = self._execute_mark_read(message_id)
            if success:
                logger.info("Archive action: marked as read (move not implemented)")

        else:
            # 未知操作或空操作: 默认标记已读
            if ai_action:
                logger.warning(f"Unknown action '{ai_action}', defaulting to mark as read")
            success = self._execute_mark_read(message_id)

        # 更新 Notion 状态
        if success:
            try:
                await self.notion_sync.update_page_mail_sync_status(page_id, synced=True)
                logger.info(f"Reverse sync completed for {message_id_short}")
            except Exception as e:
                logger.error(f"Failed to update Notion sync status: {e}")
                # 虽然 Notion 更新失败，但 Mail.app 操作已成功
                # 返回 False 以便下次重试
                return False
        else:
            logger.error(f"Failed to execute action on Mail.app: {message_id_short}")

        return success

    def _execute_mark_read(self, message_id: str) -> bool:
        """执行标记已读操作

        Args:
            message_id: 邮件的 Message-ID

        Returns:
            是否成功
        """
        try:
            return self.arm.mark_as_read(message_id, True)
        except Exception as e:
            logger.error(f"mark_as_read failed: {e}")
            return False

    def _execute_flag(self, message_id: str) -> bool:
        """执行设置旗标操作

        Args:
            message_id: 邮件的 Message-ID

        Returns:
            是否成功
        """
        try:
            return self.arm.set_flag(message_id, True)
        except Exception as e:
            logger.error(f"set_flag failed: {e}")
            return False

    def _execute_mark_read_and_flag(self, message_id: str) -> bool:
        """执行标记已读并设置旗标操作

        Args:
            message_id: 邮件的 Message-ID

        Returns:
            是否成功（两个操作都成功才返回 True）
        """
        try:
            read_success = self.arm.mark_as_read(message_id, True)
            if not read_success:
                logger.warning("mark_as_read failed, skipping set_flag")
                return False

            flag_success = self.arm.set_flag(message_id, True)
            return flag_success
        except Exception as e:
            logger.error(f"mark_read_and_flag failed: {e}")
            return False

    def get_stats(self) -> Dict:
        """获取同步统计

        Returns:
            统计信息字典:
            - last_check: 上次检查时间 (ISO format)
            - total_synced: 总成功同步数
            - total_errors: 总错误数
        """
        return {
            "last_check": self.last_check.isoformat() if self.last_check else None,
            "total_synced": self.sync_count,
            "total_errors": self.error_count
        }

    def reset_stats(self):
        """重置统计计数器"""
        self.sync_count = 0
        self.error_count = 0
        logger.info("Reverse sync stats reset")
