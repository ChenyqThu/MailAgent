import asyncio
import signal
import sys

from loguru import logger
from src.config import config
from src.utils.logger import setup_logger

# 设置日志
setup_logger(config.log_level, config.log_file)

class EmailNotionSyncApp:
    """邮件同步应用主类"""

    def __init__(self):
        from src.mail.new_watcher import NewWatcher
        logger.info("Using NewWatcher (SQLite Radar + AppleScript Arm)")

        # 解析邮箱列表
        mailboxes = [mb.strip() for mb in config.sync_mailboxes.split(',') if mb.strip()]
        if not mailboxes:
            mailboxes = ["收件箱"]

        self.watcher = NewWatcher(
            mailboxes=mailboxes,
            poll_interval=config.radar_poll_interval,
            sync_store_path=config.sync_store_db_path
        )
        self._shutdown_event = asyncio.Event()

    def _handle_signal(self, signum, frame):
        """处理系统信号"""
        sig_name = signal.Signals(signum).name
        logger.info(f"Received signal {sig_name}, initiating graceful shutdown...")
        self._shutdown_event.set()

    async def start(self):
        """启动应用"""
        logger.info("=" * 60)
        logger.info("Email to Notion Sync Service")
        logger.info("=" * 60)
        logger.info(f"User: {config.user_email}")
        logger.info(f"Poll interval: {config.radar_poll_interval}s")
        logger.info(f"Log level: {config.log_level}")
        logger.info("=" * 60)

        # 注册信号处理器
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)

        try:
            # 启动邮件监听器（在后台任务中运行）
            watcher_task = asyncio.create_task(self.watcher.start())

            # 等待关闭信号
            await self._shutdown_event.wait()

            # 停止监听器
            logger.info("Stopping watcher...")
            await self.watcher.stop()

            # 等待监听器完成当前操作
            watcher_task.cancel()
            try:
                await watcher_task
            except asyncio.CancelledError:
                pass

            # 打印最终统计
            stats = self.watcher.get_stats()
            logger.info(f"Final stats: synced={stats.get('emails_synced', 0)}, errors={stats.get('errors', 0)}")
            logger.info("Shutdown complete")

        except Exception as e:
            logger.error(f"Fatal error: {e}")
            sys.exit(1)

async def main():
    """主函数"""
    app = EmailNotionSyncApp()
    await app.start()

if __name__ == "__main__":
    asyncio.run(main())
