"""Storage payload builder - 把已构建的 Email 对象转为 SQLite payload（v4 架构）.

接受 reader 已经解析好的 Email 对象 + 可选 raw MIME 源，输出:
    - BodyPayload (html 已重写 cid → 本地相对路径, markdown 已生成)
    - list[AttachmentPayload]（内容已从 path 读出）

不动现有 reader / MIME 解析链路，仅做"翻译 + 打包"。
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Optional

from loguru import logger

from src.models import Attachment, Email
from src.repository.attachment_store import AttachmentStore
from src.repository.email_repository import AttachmentPayload, BodyPayload
from src.converter.html_to_markdown import html_to_markdown


def build_storage_payloads(
    email_obj: Email,
    internal_id: int,
    *,
    raw_mime_source: Optional[str] = None,
    attachment_store: Optional[AttachmentStore] = None,
) -> tuple[BodyPayload, list[AttachmentPayload]]:
    """从 Email 对象 + raw MIME 源构造 SQLite 入库 payload.

    Args:
        email_obj: reader 已解析好的 Email 对象
        internal_id: SQLite ROWID / AppleScript id；用于 cid 重写路径
        raw_mime_source: 可选 raw MIME 字符串；用于算 sha256（不入库本身）
        attachment_store: 用于 sanitize_filename 与计算相对路径；不传则用默认

    Returns:
        (body_payload, attachment_payloads)

    Notes:
        - 常规附件 path 读不到内容时跳过（不入 SQLite，不阻断主流程）
        - HTML 为空时 body_format='text-only'，content 当 plaintext 处理
    """
    store = attachment_store or AttachmentStore()

    # 1. 读所有附件 bytes、算 sha256、记录 cid → 实际 filename 的映射
    attachment_payloads: list[AttachmentPayload] = []
    cid_to_filename: dict[str, str] = {}  # MIME cid → sanitized filename，给 HTML 重写用

    for att in email_obj.attachments:
        content_bytes = _read_attachment_bytes(att)
        if content_bytes is None:
            logger.warning(
                f"Skipping attachment {att.filename!r} for internal_id={internal_id}: "
                f"file missing at {att.path}"
            )
            continue

        sanitized = store.sanitize_filename(att.filename)
        if att.content_id:
            cid_to_filename[att.content_id] = sanitized

        attachment_payloads.append(
            AttachmentPayload(
                filename=att.filename,           # repo.commit 会再 sanitize 一次
                content=content_bytes,
                content_type=att.content_type,
                content_id=att.content_id,
                is_inline=att.is_inline,
                derived_from_filename=getattr(att, "derived_from_filename", None),
                derived_format=getattr(att, "derived_format", None),
            )
        )

    # 2. 提取 HTML / plaintext
    is_html = (email_obj.content_type or "").lower() == "text/html"
    html_raw = email_obj.content if is_html else None
    plaintext_raw = email_obj.content if not is_html else None

    # 3. HTML 里 cid: 改写为 attachments/{internal_id}/{filename} 相对路径
    has_inline = False
    if html_raw and cid_to_filename:
        html_rewritten, has_inline = _rewrite_cid_to_local(
            html_raw, internal_id, cid_to_filename
        )
    else:
        html_rewritten = html_raw
        has_inline = any(a.is_inline for a in email_obj.attachments)

    # 4. HTML → Markdown
    if html_rewritten:
        body_markdown = html_to_markdown(html_rewritten)
        body_format = "html"
    elif plaintext_raw:
        # 邮件本身就是 plaintext，markdown 等同于 plaintext
        body_markdown = plaintext_raw
        body_format = "text-only"
    else:
        body_markdown = ""
        body_format = "empty"

    # 5. raw MIME sha256
    raw_sha256 = None
    if raw_mime_source:
        raw_sha256 = hashlib.sha256(raw_mime_source.encode("utf-8", errors="replace")).hexdigest()

    body = BodyPayload(
        html=html_rewritten,
        markdown=body_markdown,
        body_format=body_format,
        has_inline_images=has_inline,
        raw_mime_sha256=raw_sha256,
        fetched_source="applescript",
    )

    return body, attachment_payloads


# ============================================================
# Helpers
# ============================================================

def _read_attachment_bytes(att: Attachment) -> Optional[bytes]:
    """从 attachment.path 读 bytes；不存在返回 None."""
    if not att.path:
        return None
    p = Path(att.path)
    if not p.is_file():
        return None
    try:
        return p.read_bytes()
    except OSError as e:
        logger.warning(f"Failed to read attachment {att.path}: {e}")
        return None


# 匹配 src="cid:xxx" 或 src='cid:xxx'（cid 可能含 @ 和 .）
# Outlook 有时把 cid 包成 "cid:xxx@domain"，所以 cid 内容用宽松字符集
_CID_REF_RE = re.compile(
    r"""(?P<attr>src|href)\s*=\s*(?P<quote>["'])cid:(?P<cid>[^"']+)(?P=quote)""",
    re.IGNORECASE,
)


def _rewrite_cid_to_local(
    html: str,
    internal_id: int,
    cid_to_filename: dict[str, str],
) -> tuple[str, bool]:
    """把 HTML 里 cid:xxx 改写为相对路径 attachments/{internal_id}/{filename}.

    Returns:
        (rewritten_html, had_inline_image_rewrites)
    """
    matched_any = False

    def repl(m: re.Match) -> str:
        nonlocal matched_any
        cid = m.group("cid")
        filename = cid_to_filename.get(cid)
        if not filename:
            # 找不到映射，保持原样（防止破坏未知 cid）
            return m.group(0)
        matched_any = True
        new_src = f"attachments/{internal_id}/{filename}"
        return f"{m.group('attr')}={m.group('quote')}{new_src}{m.group('quote')}"

    rewritten = _CID_REF_RE.sub(repl, html)
    return rewritten, matched_any
