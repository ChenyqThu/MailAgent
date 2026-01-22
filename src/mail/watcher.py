import asyncio
from typing import Set
from loguru import logger

from src.mail.reader import EmailReader
from src.config import config

class MailWatcher:
    """邮件监听器"""

    def __init__(self, on_new_email_callback):
        """
        初始化

        Args:
            on_new_email_callback: 新邮件回调函数，接收 Email 对象
        """
        self.reader = EmailReader()
        self.on_new_email = on_new_email_callback
        self.synced_message_ids: Set[str] = set()
        self.check_interval = config.check_interval

    async def start(self):
        """开始监听"""
        logger.info("Mail watcher started")
        logger.info(f"Check interval: {self.check_interval} seconds")

        # 如果没有启用同步现有邮件，则初始化已知邮件列表
        # （避免重复同步启动前就存在的邮件）
        if not config.sync_existing_unread:
            await self._initialize_known_emails()
        else:
            logger.info("Sync existing unread enabled, skipping initialization")

        # 开始监听循环
        while True:
            try:
                await self._check_new_emails()
                await asyncio.sleep(self.check_interval)
            except KeyboardInterrupt:
                logger.info("Mail watcher stopped by user")
                break
            except Exception as e:
                logger.error(f"Error in mail watcher: {e}")
                await asyncio.sleep(self.check_interval)

    async def _initialize_known_emails(self):
        """初始化已知邮件（避免启动时同步所有历史未读邮件）"""
        logger.info("Initializing known emails...")

        try:
            emails = self.reader.get_unread_emails(limit=100)
            self.synced_message_ids = {email.message_id for email in emails}
            logger.info(f"Initialized with {len(self.synced_message_ids)} known emails")
        except Exception as e:
            logger.error(f"Failed to initialize known emails: {e}")

    async def _check_new_emails(self):
        """检查新邮件"""
        try:
            # 获取未读邮件
            emails = self.reader.get_unread_emails()

            # 筛选出新邮件（不在已知列表中）
            new_emails = [
                email for email in emails
                if email.message_id not in self.synced_message_ids
            ]

            if not new_emails:
                return

            logger.info(f"Found {len(new_emails)} new emails")

            # 处理新邮件
            for email in new_emails:
                try:
                    # 调用回调函数
                    await self.on_new_email(email)

                    # 标记为已知
                    self.synced_message_ids.add(email.message_id)

                except Exception as e:
                    logger.error(f"Failed to process email {email.message_id}: {e}")

        except Exception as e:
            logger.error(f"Failed to check new emails: {e}")

    def mark_as_synced(self, message_id: str):
        """手动标记邮件为已同步"""
        self.synced_message_ids.add(message_id)
