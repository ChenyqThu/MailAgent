#!/usr/bin/env python3
"""
日历同步主入口
将 macOS Calendar.app 中的 Exchange 日历同步到 Notion

支持两种模式：
1. eventkit_watcher (推荐): 事件驱动，日历变化时自动同步
2. eventkit_polling: 定时轮询模式
"""

import asyncio
import signal
import sys
from datetime import datetime
from loguru import logger

from src.config import config
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


def get_calendar_reader():
    """获取日历读取器（用于轮询模式）"""
    if config.calendar_sync_mode == "applescript":
        from src.calendar.applescript_reader import CalendarAppleScriptReader
        return CalendarAppleScriptReader()
    else:
        from src.calendar.reader import CalendarReader
        return CalendarReader()


async def sync_events(reader=None):
    """执行一次同步"""
    if reader is None:
        reader = get_calendar_reader()

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


async def sync_once():
    """执行一次同步（用于 --once 参数）"""
    logger.info("开始日历同步...")
    await sync_events()


async def run_watcher_mode():
    """事件驱动模式（推荐）"""
    from src.calendar.eventkit_watcher import EventKitWatcher

    logger.info("=" * 50)
    logger.info("日历同步服务启动 (事件驱动模式)")
    logger.info(f"目标日历: {config.calendar_name}")
    logger.info(f"健康检查间隔: {config.health_check_interval} 秒")
    logger.info(f"时间范围: 过去 {config.calendar_past_days} 天 ~ 未来 {config.calendar_future_days} 天")
    logger.info("=" * 50)

    watcher = EventKitWatcher()

    # 处理退出信号
    stop_event = asyncio.Event()

    def signal_handler():
        logger.info("收到退出信号，正在停止...")
        watcher.stop_watching()
        stop_event.set()

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, signal_handler)

    # 同步回调
    async def on_calendar_changed():
        logger.info("检测到日历变化，开始同步...")
        await sync_events(watcher)

    # 启动监听
    try:
        await watcher.start_watching(on_calendar_changed)
    except asyncio.CancelledError:
        pass

    logger.info("日历同步服务已停止")


async def run_polling_mode():
    """轮询模式"""
    logger.info("=" * 50)
    logger.info("日历同步服务启动 (轮询模式)")
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
            await asyncio.wait_for(
                stop_event.wait(),
                timeout=config.calendar_check_interval
            )
        except asyncio.TimeoutError:
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
        "--mode",
        choices=["watcher", "polling"],
        default="watcher",
        help="运行模式: watcher (事件驱动，推荐) / polling (轮询)"
    )

    args = parser.parse_args()

    setup_logger()

    if not config.calendar_database_id:
        logger.error("未配置 CALENDAR_DATABASE_ID，请在 .env 中设置")
        sys.exit(1)

    if args.once:
        asyncio.run(sync_once())
    elif args.mode == "watcher":
        asyncio.run(run_watcher_mode())
    else:
        asyncio.run(run_polling_mode())


if __name__ == "__main__":
    main()
