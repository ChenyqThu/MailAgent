"""macOS Vision OCR —— 图片附件 + 无文本层 PDF 的文本抽取（批次4 PR-G）。

补齐 `attachment_text.py` 的 OCR 盲区：图片附件（png/jpg/…）与扫描件 PDF
（pypdf 抽不到文本层）经系统 Vision.framework 识别中英文本 → 进 FTS5。

**懒 import**：顶层不 import Vision/Quartz。所有 pyobjc 调用在 `_load_vision()`
内 try-import，缺失（打包漏依赖 / 非 macOS）→ 返回 None + module 级一次性
warning；调用方据此维持附件 `unsupported`/`failed` 现状语义，**打包漏依赖不崩**。

依赖：`pyobjc-framework-Vision`（连带 core/Cocoa/Quartz/CoreML ≈7.1MB）。
识别在系统 Vision.framework 本地跑（无网络出口，Apple Silicon Neural Engine）。

**护栏**（Vision 无法安全 kill，只做规模型护栏、不做超时包装）：
- `OCR_PDF_MAX_PAGES`：PDF 逐页 OCR 页数上限（超出只 OCR 前 N 页，truncated=True）
- `OCR_IMAGE_MAX_BYTES`：单图片文件字节上限（超出由调用方降级 unsupported）
- `OCR_RENDER_MAX_DIM`：PDF 页渲染位图长边像素上限（Quartz 缩放）

OCR 输出文本仍由调用方（`attachment_text._truncate`）走 256KB 字节上限，机制不变。
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from loguru import logger

# 护栏常量（集中定义可调）。
OCR_PDF_MAX_PAGES = 20                    # PDF 逐页 OCR 页数上限
OCR_IMAGE_MAX_BYTES = 15 * 1024 * 1024   # 15 MB —— 超大图片跳过（避免渲染/OCR 卡死）
OCR_RENDER_MAX_DIM = 4096                # PDF 页渲染位图长边像素上限

# 识别语言 + 参数（中英，accurate 级别）。
_OCR_LANGUAGES = ["zh-Hans", "en-US"]

# PDF 页渲染的目标放大倍数（≈144 DPI，长边超 OCR_RENDER_MAX_DIM 时收缩）。
_PDF_RENDER_SCALE = 2.0

# module 级一次性 warning flag，防每封附件刷屏。
_warned_unavailable = False


def _warn_unavailable_once(exc: Exception) -> None:
    global _warned_unavailable
    if not _warned_unavailable:
        logger.warning(
            "[vision-ocr] pyobjc Vision/Quartz 不可用，OCR 降级跳过 "
            f"(图片/扫描件 PDF 维持 unsupported/failed 现状): {exc}"
        )
        _warned_unavailable = True


def _load_vision():
    """try-import Vision + Quartz + Foundation.NSURL。

    缺失（ImportError / dylib 缺失 / 非 macOS）→ `(None, None, None)` + 一次性 warning。
    Python 已缓存模块，重复调用零成本。
    """
    try:
        import Vision
        import Quartz
        from Foundation import NSURL

        return Vision, Quartz, NSURL
    except Exception as e:  # noqa: BLE001 — ImportError 或底层 dylib 缺失都要软着陆
        _warn_unavailable_once(e)
        return None, None, None


def ocr_available() -> bool:
    """Vision/Quartz 能否 import（打包环境探测入口）。"""
    vision, _, _ = _load_vision()
    return vision is not None


def _recognize(vision, handler) -> str:
    """对已建好的 VNImageRequestHandler 跑一次 accurate 中英文本识别，拼接每行。"""
    request = vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLanguages_(_OCR_LANGUAGES)
    request.setUsesLanguageCorrection_(True)
    request.setRecognitionLevel_(vision.VNRequestTextRecognitionLevelAccurate)
    success, _error = handler.performRequests_error_([request], None)
    if not success:
        return ""
    lines: list[str] = []
    for obs in request.results() or []:
        top = obs.topCandidates_(1)
        if top and len(top):
            lines.append(top[0].string())
    return "\n".join(lines)


def ocr_image_file(path: Path | str) -> Optional[str]:
    """OCR 单张图片文件。

    Returns:
        识别文本（可能为空串 = OCR 跑通但无文字）；OCR 不可用 / 异常 → None
        （调用方据 None 维持 unsupported 现状语义）。
    """
    vision, _quartz, nsurl = _load_vision()
    if vision is None:
        return None
    try:
        url = nsurl.fileURLWithPath_(str(path))
        handler = vision.VNImageRequestHandler.alloc().initWithURL_options_(url, None)
        return _recognize(vision, handler)
    except Exception as e:  # noqa: BLE001 — 单张失败不炸整轮
        logger.warning(f"[vision-ocr] image OCR failed for {Path(path).name}: {e}")
        return None


def _compute_render_scale(width: float, height: float) -> float:
    """PDF 页渲染放大倍数：默认 `_PDF_RENDER_SCALE`，长边超 `OCR_RENDER_MAX_DIM` 时收缩。"""
    long_edge = max(width, height)
    if long_edge <= 0:
        return _PDF_RENDER_SCALE
    if long_edge * _PDF_RENDER_SCALE > OCR_RENDER_MAX_DIM:
        return OCR_RENDER_MAX_DIM / long_edge
    return _PDF_RENDER_SCALE


def _render_pdf_page(quartz, doc, page_number: int):
    """Quartz 把 PDF 单页渲染为白底 RGB 位图 CGImage；长边 ≤ `OCR_RENDER_MAX_DIM`。"""
    page = quartz.CGPDFDocumentGetPage(doc, page_number)
    if page is None:
        return None
    rect = quartz.CGPDFPageGetBoxRect(page, quartz.kCGPDFMediaBox)
    width = float(rect.size.width)
    height = float(rect.size.height)
    if width <= 0 or height <= 0:
        return None
    scale = _compute_render_scale(width, height)
    pixel_w = max(1, int(width * scale))
    pixel_h = max(1, int(height * scale))
    color_space = quartz.CGColorSpaceCreateDeviceRGB()
    ctx = quartz.CGBitmapContextCreate(
        None, pixel_w, pixel_h, 8, 0, color_space, quartz.kCGImageAlphaPremultipliedLast
    )
    if ctx is None:
        return None
    # 白底（扫描件通常白纸黑字，透明底会让 OCR 抓不到边界）。
    quartz.CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0)
    quartz.CGContextFillRect(ctx, quartz.CGRectMake(0, 0, pixel_w, pixel_h))
    quartz.CGContextScaleCTM(ctx, scale, scale)
    quartz.CGContextDrawPDFPage(ctx, page)
    return quartz.CGBitmapContextCreateImage(ctx)


def _ocr_cgimage(vision, cgimage) -> str:
    """对渲染出的 CGImage 建 handler 并跑识别（抽出便于 mock 页级 OCR）。"""
    handler = vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cgimage, None)
    return _recognize(vision, handler)


def ocr_pdf_file(path: Path | str) -> Optional[tuple[str, bool]]:
    """逐页渲染无文本层 PDF 为位图 → Vision OCR 拼接。

    Returns:
        `(text, truncated)`：truncated=True 表示页数超 `OCR_PDF_MAX_PAGES` 被截断
        （只 OCR 前 N 页）。text 可能为空串（OCR 跑通但无文字 / 逐页渲染全失败，
        调用方据空文本维持 failed 现状文案）。
        OCR 不可用 / 打不开 PDF / 零页 / 异常 → None（调用方同样维持 failed 现状文案）。
    """
    vision, quartz, nsurl = _load_vision()
    if vision is None:
        return None
    try:
        url = nsurl.fileURLWithPath_(str(path))
        doc = quartz.CGPDFDocumentCreateWithURL(url)
        if doc is None:
            return None
        total_pages = quartz.CGPDFDocumentGetNumberOfPages(doc)
        if total_pages <= 0:
            return None
        truncated = total_pages > OCR_PDF_MAX_PAGES
        page_count = min(total_pages, OCR_PDF_MAX_PAGES)
        parts: list[str] = []
        for page_number in range(1, page_count + 1):
            cgimage = _render_pdf_page(quartz, doc, page_number)
            if cgimage is None:
                continue
            text = _ocr_cgimage(vision, cgimage)
            if text.strip():
                parts.append(text)
        return "\n\n".join(parts), truncated
    except Exception as e:  # noqa: BLE001 — 渲染/OCR 失败软着陆
        logger.warning(f"[vision-ocr] pdf OCR failed for {Path(path).name}: {e}")
        return None
