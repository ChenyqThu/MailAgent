"""LibreOffice (soffice) headless 桥。

**当前唯一用途**：老 Office 二进制格式（.doc/.ppt/.xls）在 anydoc 之外的兜底 ——
`converter/attachment_text.py::_extract_legacy_office` 用它转成 docx/pptx/xlsx 再抽文本。

原先本模块还负责「Notion 派生附件」（docx/pptx→PDF、xlsx→CSV 作为额外附件上传到
Notion）。派生已于 2026-08 整体退役（Notion 侧有沙盒电脑可直接读 office 文件），
`convert_office_attachment` / `is_convertible` / `convert_to_pdf` / `convert_to_csv`
连同 `backfill derivatives` CLI 一并删除；pandas 依赖也随之从本模块消失。

🔴 LibreOffice **没有打进 .app**，是未声明的系统依赖。缺失时 `_run_soffice_convert`
返回 False（不抛），老格式附件 graceful 落 unsupported。anydoc 的 legacy lane 默认开着，
实测存量 45 条 .doc 全部由 anydoc 接管、本桥一次都没被用到 —— 它现在纯粹是兜底。
"""

import subprocess
import tempfile
import shutil
from pathlib import Path
from typing import Optional

from loguru import logger

# soffice 可执行文件搜索路径
_SOFFICE_PATHS = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/bin/soffice",
]


def _find_soffice() -> Optional[str]:
    """查找 soffice 可执行文件路径"""
    path = shutil.which("soffice")
    if path:
        return path

    for p in _SOFFICE_PATHS:
        if Path(p).exists():
            return p

    return None


def _run_soffice_convert(input_path: str, output_dir: str, format: str = "pdf", timeout: int = 120) -> bool:
    """调用 soffice --headless 执行转换

    使用独立的 UserInstallation 目录避免并发冲突。

    Args:
        input_path: 输入文件路径
        output_dir: 输出目录
        format: 输出格式
        timeout: 超时时间（秒）

    Returns:
        是否成功
    """
    soffice = _find_soffice()
    if not soffice:
        logger.warning("soffice not found, skipping office document conversion")
        return False

    try:
        # 每次转换使用独立的 user profile，避免并发时 profile 锁冲突
        with tempfile.TemporaryDirectory(prefix="lo_profile_") as user_dir:
            cmd = [
                soffice,
                f"-env:UserInstallation=file://{user_dir}",
                "--headless",
                "--convert-to", format,
                "--outdir", output_dir,
                input_path,
            ]
            logger.debug(f"Running: {' '.join(cmd)}")

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
            )

            if result.returncode == 0:
                return True

            logger.error(f"soffice failed (rc={result.returncode}): {result.stderr.strip()}")
            return False

    except subprocess.TimeoutExpired:
        logger.error(f"soffice timed out after {timeout}s for {input_path}")
        return False
    except FileNotFoundError:
        logger.error(f"soffice executable not found: {soffice}")
        return False
    except Exception as e:
        logger.error(f"soffice error: {e}")
        return False


def check_soffice_available() -> bool:
    """检查 LibreOffice soffice 是否可用（启动时调用，输出诊断信息）"""
    soffice = _find_soffice()
    if not soffice:
        logger.warning(
            "Office → PDF conversion disabled: soffice not found. "
            "Install with: brew install --cask libreoffice"
        )
        return False

    try:
        result = subprocess.run(
            [soffice, "--headless", "--version"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            version = result.stdout.strip()
            logger.info(f"LibreOffice available for Office → PDF conversion: {version}")
            return True
    except Exception as e:
        logger.warning(f"soffice check failed: {e}")

    return False
