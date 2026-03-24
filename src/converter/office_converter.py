"""Office 文档转换器

将 docx/pptx 转为 PDF，xlsx 转为 CSV，作为额外附件上传到 Notion。

依赖：
- docx/pptx → PDF: LibreOffice headless (soffice --headless --convert-to pdf)
- xlsx → CSV: pandas + python-calamine (Rust 引擎，高性能)
"""

import subprocess
import tempfile
import shutil
from pathlib import Path
from typing import Optional, List

from loguru import logger

# xlsx → csv 转换所需
try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False

# 支持转换的扩展名映射
OFFICE_TO_PDF_EXTENSIONS = {'.docx', '.pptx'}
EXCEL_TO_CSV_EXTENSIONS = {'.xlsx'}
ALL_CONVERTIBLE_EXTENSIONS = OFFICE_TO_PDF_EXTENSIONS | EXCEL_TO_CSV_EXTENSIONS

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


def convert_to_pdf(input_path: str, output_dir: str) -> Optional[str]:
    """将 docx/pptx 转换为 PDF

    Args:
        input_path: 输入文件路径
        output_dir: 输出目录

    Returns:
        PDF 文件路径，失败返回 None
    """
    inp = Path(input_path)
    if inp.suffix.lower() not in OFFICE_TO_PDF_EXTENSIONS:
        return None

    expected_output = Path(output_dir) / f"{inp.stem}.pdf"

    logger.info(f"Converting {inp.name} → PDF...")
    if _run_soffice_convert(input_path, output_dir):
        if expected_output.exists() and expected_output.stat().st_size > 0:
            logger.info(f"Converted: {inp.name} → {expected_output.name} ({expected_output.stat().st_size} bytes)")
            return str(expected_output)

    logger.warning(f"Failed to convert {inp.name} to PDF")
    return None


def convert_to_csv(input_path: str, output_dir: str) -> List[str]:
    """将 xlsx 转换为 CSV（支持多 sheet）

    Args:
        input_path: 输入文件路径
        output_dir: 输出目录

    Returns:
        CSV 文件路径列表，失败返回空列表
    """
    inp = Path(input_path)
    if inp.suffix.lower() not in EXCEL_TO_CSV_EXTENSIONS:
        return []

    if not HAS_PANDAS:
        logger.warning("pandas not installed, skipping xlsx → csv conversion")
        return []

    try:
        logger.info(f"Converting {inp.name} → CSV...")

        # 优先使用 calamine 引擎（Rust，4-18x 更快）
        try:
            sheets = pd.read_excel(input_path, sheet_name=None, engine="calamine")
        except ImportError:
            logger.debug("python-calamine not available, falling back to openpyxl")
            sheets = pd.read_excel(input_path, sheet_name=None, engine="openpyxl")

        csv_paths = []
        for sheet_name, df in sheets.items():
            # 跳过空 sheet
            if df.empty:
                continue

            # 安全的文件名
            safe_name = str(sheet_name).replace("/", "_").replace("\\", "_").replace(":", "_")

            if len(sheets) == 1:
                csv_filename = f"{inp.stem}.csv"
            else:
                csv_filename = f"{inp.stem}_{safe_name}.csv"

            csv_path = str(Path(output_dir) / csv_filename)
            # utf-8-sig (BOM) 确保 Excel/Notion 打开 CJK 不乱码
            df.to_csv(csv_path, index=False, encoding="utf-8-sig")

            file_size = Path(csv_path).stat().st_size
            logger.info(f"Converted: {inp.name} [sheet: {sheet_name}] → {csv_filename} ({file_size} bytes)")
            csv_paths.append(csv_path)

        return csv_paths

    except Exception as e:
        logger.error(f"Failed to convert {inp.name} to CSV: {e}")
        return []


def convert_office_attachment(input_path: str, output_dir: str) -> List[str]:
    """统一入口：根据扩展名自动选择转换方式

    Args:
        input_path: 输入文件路径
        output_dir: 输出目录

    Returns:
        转换后的文件路径列表
    """
    ext = Path(input_path).suffix.lower()

    if ext in OFFICE_TO_PDF_EXTENSIONS:
        result = convert_to_pdf(input_path, output_dir)
        return [result] if result else []

    elif ext in EXCEL_TO_CSV_EXTENSIONS:
        return convert_to_csv(input_path, output_dir)

    return []


def is_convertible(filename: str) -> bool:
    """判断文件是否支持转换"""
    return Path(filename).suffix.lower() in ALL_CONVERTIBLE_EXTENSIONS


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
