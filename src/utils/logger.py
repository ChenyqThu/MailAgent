import sys
from pathlib import Path
from loguru import logger

def setup_logger(log_level: str = "INFO", log_file: str = "logs/sync.log"):
    """
    配置日志

    Args:
        log_level: 日志级别
        log_file: 日志文件路径
    """
    # 移除默认处理器
    logger.remove()

    # 添加控制台输出（带颜色）
    logger.add(
        sys.stdout,
        level=log_level,
        format="<green>{time:YYYY-MM-DD HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>",
        colorize=True
    )

    # 添加文件输出
    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    logger.add(
        log_file,
        level=log_level,
        format="{time:YYYY-MM-DD HH:mm:ss} | {level: <8} | {name}:{function}:{line} - {message}",
        rotation="10 MB",  # 文件大小超过 10MB 时轮转
        retention="7 days",  # 保留 7 天
        compression="zip"  # 压缩旧日志
    )

    logger.info(f"Logger initialized - Level: {log_level}")
