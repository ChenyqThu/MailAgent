"""按需抽取 → ``library_text``（design §3 / §1.2）。

抽取器**直接复用** ``src/converter/attachment_text.py::extract_text``（纯函数零 DB 依赖；anydoc lane
优先、失败恒回落原生 extractor、256 KB 上限）。本模块只补三件事：

1. ``kind_for_filename``：扩展名 → ``KINDS`` 词表（前端图标 / 预览矩阵 / 是否抽取都按它分派）；
2. ``.markdown`` / ``.json`` / ``.yaml`` 这类 ``extract_text`` 不认的纯文本，与 ``.html``（经 ``html_to_markdown``），
   在它返回 ``unsupported`` 时就地读文本 —— 它们在 agent 写面白名单里，写进来的东西必须可检索；
3. ``ensure_text``：``library_text.source_hash != 当前 content_hash`` 即重抽；``kind='placeholder'`` 不抽。

P1 只做「打开 / 搜索时 pending → 触发」；低速后台队列留 P2/P3。
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any, Mapping, Optional

from loguru import logger

from src.converter.attachment_text import (
    LEGACY_OFFICE_EXTENSIONS,
    OCR_IMAGE_EXTENSIONS,
    ExtractResult,
    extract_text,
)
from src.library.constants import EXTRACT_MAX_BYTES

_MARKDOWN_EXTS = frozenset({".md", ".markdown"})
_HTML_EXTS = frozenset({".html", ".htm"})
_PDF_EXTS = frozenset({".pdf"})
_OFFICE_EXTS = frozenset({".docx", ".pptx", ".xlsx"}) | frozenset(LEGACY_OFFICE_EXTENSIONS)
_TEXT_EXTS = frozenset({".txt", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml"})
_PLACEHOLDER_EXTS = frozenset({".icloud"})

#: 会进抽取队列的 kind；其余登记时直接 ``unsupported``。
EXTRACTABLE_KINDS = frozenset({"markdown", "html", "pdf", "office", "image", "text"})


def kind_for_filename(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in _PLACEHOLDER_EXTS:
        return "placeholder"
    if ext in _MARKDOWN_EXTS:
        return "markdown"
    if ext in _HTML_EXTS:
        return "html"
    if ext in _PDF_EXTS:
        return "pdf"
    if ext in _OFFICE_EXTS:
        return "office"
    if ext in OCR_IMAGE_EXTENSIONS:
        return "image"
    if ext in _TEXT_EXTS:
        return "text"
    return "other"


def initial_text_status(kind: str) -> str:
    return "pending" if kind in EXTRACTABLE_KINDS else "unsupported"


def _truncate(text: str) -> tuple[str, bool]:
    encoded = text.encode("utf-8")
    if len(encoded) <= EXTRACT_MAX_BYTES:
        return text, False
    return encoded[:EXTRACT_MAX_BYTES].decode("utf-8", errors="ignore"), True


def _read_text_fallback(path: Path, kind: str) -> Optional[ExtractResult]:
    """``extract_text`` 报 unsupported 但按 kind 应当有文本的两类：纯文本变体与 html。"""
    if kind not in ("markdown", "text", "html"):
        return None
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return ExtractResult(text="", extractor="none", status="failed", error_message=str(exc))
    extractor = "plaintext"
    if kind == "html":
        from src.converter.html_to_markdown import html_to_markdown

        raw = html_to_markdown(raw) or ""
        extractor = "html"
    text, truncated = _truncate(raw)
    return ExtractResult(text=text, extractor=extractor, status="extracted", truncated=truncated)


def extract_file(abs_path: str, filename: str, kind: str) -> ExtractResult:
    """单文件抽取（同步、阻塞）。``placeholder`` 恒 unsupported，不碰磁盘。"""
    if kind == "placeholder":
        return ExtractResult(text="", extractor="none", status="unsupported", error_message="icloud placeholder")
    result = extract_text(abs_path, filename=filename)
    if result.status == "unsupported":
        fallback = _read_text_fallback(Path(abs_path), kind)
        if fallback is not None:
            return fallback
    return result


def ensure_text(
    repo: Any,
    conn: sqlite3.Connection,
    file_row: Mapping[str, Any],
    abs_path: str,
) -> Optional[dict[str, Any]]:
    """返回与当前 ``content_hash`` 匹配的 ``library_text`` 行；过期 / 缺失就地抽取并落库。

    抽取失败 → ``text_status='failed'``，旧文本行（若有）保留 —— 它的 ``source_hash`` 会说明自己过期。
    """
    file_id = int(file_row["id"])
    content_hash = file_row.get("content_hash")
    if file_row.get("kind") == "placeholder" or file_row.get("status") != "present":
        return None
    existing = repo.get_text(conn, file_id)
    if existing is not None and content_hash and existing["source_hash"] == content_hash:
        return existing
    result = extract_file(abs_path, str(file_row["filename"]), str(file_row["kind"]))
    if result.status == "extracted" and content_hash:
        repo.upsert_text(
            conn,
            file_id,
            filename=str(file_row["filename"]),
            text=result.text,
            extractor=result.extractor,
            source_hash=content_hash,
            truncated=result.truncated,
        )
        repo.update_file(conn, file_id, text_status="extracted", updated_at=time.time())
        return repo.get_text(conn, file_id)
    status = result.status if result.status in ("failed", "unsupported") else "failed"
    if status == "failed":
        logger.warning(f"[library] extract failed for file {file_id} ({file_row.get('rel_path')}): {result.error_message}")
    repo.update_file(conn, file_id, text_status=status, updated_at=time.time())
    return existing
