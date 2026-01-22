import asyncio
import sys
from pathlib import Path

from loguru import logger
from src.config import config
from src.mail.watcher import MailWatcher
from src.notion.sync import NotionSync
from src.utils.logger import setup_logger

# 设置日志
setup_logger(config.log_level, config.log_file)

class EmailNotionSyncApp:
    """邮件同步应用主类"""

    def __init__(self):
        self.notion_sync = NotionSync()
        self.watcher = MailWatcher(on_new_email_callback=self.handle_new_email)

    async def handle_new_email(self, email):
        """
        处理新邮件的回调函数

        Args:
            email: Email 对象
        """
        logger.info(f"📬 New email received: {email.subject}")

        try:
            # 同步到 Notion
            success = await self.notion_sync.sync_email(email)

            if success:
                logger.info(f"✅ Successfully synced: {email.subject}")
            else:
                logger.error(f"❌ Failed to sync: {email.subject}")

        except Exception as e:
            logger.error(f"Error handling email: {e}")

    async def sync_existing_unread_emails(self):
        """同步所有现有的未读邮件"""
        logger.info("=" * 60)
        logger.info("Syncing existing unread emails...")
        logger.info("=" * 60)

        from src.mail.reader import EmailReader

        try:
            reader = EmailReader()
            # 获取所有未读邮件
            emails = reader.get_unread_emails(limit=config.max_batch_size)

            if not emails:
                logger.info("No unread emails found")
                return

            logger.info(f"Found {len(emails)} unread emails")

            # 同步每封邮件
            synced_count = 0
            skipped_count = 0
            failed_count = 0

            for i, email in enumerate(emails, 1):
                logger.info(f"[{i}/{len(emails)}] Processing: {email.subject}")

                try:
                    success = await self.notion_sync.sync_email(email)

                    if success:
                        synced_count += 1
                        # 标记为已同步（避免监听器重复处理）
                        self.watcher.mark_as_synced(email.message_id)
                    else:
                        skipped_count += 1
                        logger.info(f"  → Skipped (already synced)")

                except Exception as e:
                    failed_count += 1
                    logger.error(f"  → Failed: {e}")

            logger.info("=" * 60)
            logger.info(f"Initial sync completed:")
            logger.info(f"  ✅ Synced: {synced_count}")
            logger.info(f"  ⏭  Skipped: {skipped_count}")
            logger.info(f"  ❌ Failed: {failed_count}")
            logger.info("=" * 60)

        except Exception as e:
            logger.error(f"Failed to sync existing emails: {e}")

    async def start(self):
        """启动应用"""
        logger.info("=" * 60)
        logger.info("Email to Notion Sync Service")
        logger.info("=" * 60)
        logger.info(f"User: {config.user_email}")
        logger.info(f"Check interval: {config.check_interval} seconds")
        logger.info(f"Sync existing unread: {config.sync_existing_unread}")
        logger.info(f"Log level: {config.log_level}")
        logger.info("=" * 60)

        try:
            # 如果配置启用，先同步所有现有未读邮件
            if config.sync_existing_unread:
                await self.sync_existing_unread_emails()

            # 启动邮件监听器
            await self.watcher.start()

        except KeyboardInterrupt:
            logger.info("Shutting down gracefully...")
        except Exception as e:
            logger.error(f"Fatal error: {e}")
            sys.exit(1)

async def main():
    """主函数"""
    app = EmailNotionSyncApp()
    await app.start()

if __name__ == "__main__":
    asyncio.run(main())
