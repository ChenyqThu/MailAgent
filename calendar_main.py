#!/usr/bin/env python3
"""
日历同步主入口
将 macOS Calendar.app 中的 Exchange 日历同步到 Notion
"""

import asyncio
import signal
import sys
from datetime import datetime
from loguru import logger

from src.config import config
from src.calendar.reader import CalendarReader
from src.calendar_notion.sync import CalendarNotionSync


def setup_logger():
    """配置日志"""
    logger.remove()
    logger.add(
        sys.stderr,
        format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{message}</cyan>",
        level=config.log_level
    )
    logger.add(
        "logs/calendar_sync.log",
        rotation="10 MB",
        retention="7 days",
        level="DEBUG"
    )


async def sync_once():
    """执行一次同步"""
    logger.info("开始日历同步...")

    # 读取日历事件
    reader = CalendarReader()
    events = reader.get_events()

    if not events:
        logger.info("没有找到日历事件")
        return

    logger.info(f"获取到 {len(events)} 个事件")

    # 同步到 Notion
    sync = CalendarNotionSync()
    stats = await sync.sync_events(events)

    logger.info(
        f"同步完成: 创建 {stats['created']}, "
        f"更新 {stats['updated']}, "
        f"跳过 {stats['skipped']}, "
        f"失败 {stats['failed']}"
    )


async def run_daemon():
    """持续运行模式"""
    logger.info("=" * 50)
    logger.info("日历同步服务启动")
    logger.info(f"目标日历: {config.calendar_name}")
    logger.info(f"同步间隔: {config.calendar_check_interval} 秒")
    logger.info(f"时间范围: 过去 {config.calendar_past_days} 天 ~ 未来 {config.calendar_future_days} 天")
    logger.info("=" * 50)

    # 处理退出信号
    stop_event = asyncio.Event()

    def signal_handler():
        logger.info("收到退出信号，正在停止...")
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, signal_handler)

    # 首次同步
    await sync_once()

    # 定期同步
    while not stop_event.is_set():
        try:
            # 等待下一次同步或退出信号
            await asyncio.wait_for(
                stop_event.wait(),
                timeout=config.calendar_check_interval
            )
        except asyncio.TimeoutError:
            # 超时表示该同步了
            await sync_once()

    logger.info("日历同步服务已停止")


def main():
    """主入口"""
    import argparse

    parser = argparse.ArgumentParser(description="日历同步到 Notion")
    parser.add_argument(
        "--once",
        action="store_true",
        help="只执行一次同步后退出"
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="持续运行模式（默认）"
    )

    args = parser.parse_args()

    setup_logger()

    if not config.calendar_database_id:
        logger.error("未配置 CALENDAR_DATABASE_ID，请在 .env 中设置")
        sys.exit(1)

    if args.once:
        asyncio.run(sync_once())
    else:
        asyncio.run(run_daemon())


if __name__ == "__main__":
    main()
