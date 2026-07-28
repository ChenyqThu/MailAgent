"""Wire-shape 投影 — record → dict 的单一真源 (D2a 从 CLI + API router 去重)。

``EmailMetadataRecord`` / ``EmailBodyRecord`` / ``AttachmentRecord`` → emit/HTTP 的
``data`` dict。**纯 transport-neutral**: 不 import cli / fastapi, 故 CLI 适配器
(``cli/commands/email.py`` + ``cli/commands/attachment.py``) 与 API router
(``api/routers/email.py``) 共用同一份投影 —— 消除原先「3 处手抄 wire dict」的漂移源。
``src/services/`` 的「零 cli import」不变式不受影响 (本模块也不 import cli)。

形状契约 (与 docs/cli-schema/email-*.schema.json + cli.gen.ts 锁死, 不可漂移):
  - ``meta_to_dict``: 默认 18 字段 = ``email get`` (email-get.schema.json email_record)。
    ``include_important=True`` 末尾追加 ``is_important`` (19 字段) = API ``GET /email/{id}``
    给前端 EmailDetail 的扩展形 (handlers/email.ts 消费该 SQLite 列)。
  - ``attachment_to_dict``: 默认 11 字段 = ``email get`` 内嵌附件 + API 同 (gotcha #1:
    **不含** local_path / internal_id, 绝不回显 host 路径)。``include_internal_id=True``
    在 ``id`` 之后插 ``internal_id`` (12 字段) = ``attachment list`` 形 (字节序与旧一致)。
  - ``body_summary`` / ``meta_record_to_list_item``: CLI 与 API 逐字段相同, 无参数分叉。

逐字段 parity 由 tests/cli/test_wire_parity.py (golden) 锁定。

🔴 **本模块不是 email.get 唯一的投影** —— 桌面 IPC 走
``frontend/src/electron/main/handlers/email.ts`` 的 ``shapeFullRecord`` /
``shapeNestedAttachment``, 是另一份**手写**镜像。改这里的字段集必须同步改那边,
否则该字段的 UI 会在某一端静默失效 (实测: ``is_important`` 漏投影 → 桌面 ❗ 徽标
永不渲染, 无任何报错)。跨语言对账闸 = ``tests/config/test_wire_projection_parity.py``。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from src.repository import (
        AttachmentRecord,
        EmailBodyRecord,
        EmailMetadataRecord,
    )


def meta_to_dict(
    meta: "EmailMetadataRecord", *, include_important: bool = False,
) -> dict[str, Any]:
    """EmailMetadataRecord → `email get` wire dict (不含 body / attachments)。

    默认 = CLI ``email get`` 18 字段。``include_important=True`` 末尾追加
    ``is_important`` = API ``GET /email/{id}`` 给前端 EmailDetail 的扩展形。
    """
    data: dict[str, Any] = {
        "internal_id": meta.internal_id,
        "message_id": meta.message_id,
        "thread_id": meta.thread_id,
        "subject": meta.subject,
        "sender": meta.sender,
        "sender_name": meta.sender_name,
        "to_addr": meta.to_addr,
        "cc_addr": meta.cc_addr,
        "date_received": meta.date_received,
        "mailbox": meta.mailbox,
        "is_read": meta.is_read,
        "is_flagged": meta.is_flagged,
        "sync_status": meta.sync_status,
        "notion_page_id": meta.notion_page_id,
        "notion_thread_id": meta.notion_thread_id,
        "notion_url": meta.notion_url,
        "sync_error": meta.sync_error,
        "retry_count": meta.retry_count,
    }
    if include_important:
        data["is_important"] = meta.is_important
    return data


def body_summary(body: Optional["EmailBodyRecord"]) -> Optional[dict[str, Any]]:
    """EmailBodyRecord → body SUMMARY (非内容)。CLI 与 API 逐字段相同。"""
    if body is None:
        return None
    return {
        "format": body.body_format,
        "size_bytes": body.body_size_bytes,
        "has_inline_images": body.has_inline_images,
        "fetched_at": body.fetched_at,
        "fetched_source": body.fetched_source,
        "raw_mime_sha256": body.raw_mime_sha256,
    }


def attachment_to_dict(
    att: "AttachmentRecord", *, include_internal_id: bool = False,
) -> dict[str, Any]:
    """AttachmentRecord → 附件 wire dict。

    默认 = ``email get`` 内嵌 + API 同 11 字段 (gotcha #1: **不含** local_path /
    internal_id)。``include_internal_id=True`` 在 ``id`` 之后插 ``internal_id``
    (12 字段) = ``attachment list`` 形 (保旧字节序)。
    """
    data: dict[str, Any] = {"id": att.id}
    if include_internal_id:
        data["internal_id"] = att.internal_id
    data.update({
        "filename": att.filename,
        "size_bytes": att.size_bytes,
        "content_type": att.content_type,
        "is_inline": att.is_inline,
        "content_id": att.content_id,
        "sha256": att.sha256,
        "derived_from": att.derived_from,
        "derived_format": att.derived_format,
        "notion_file_id": att.notion_file_id,
        "notion_block_id": att.notion_block_id,
    })
    return data


def meta_record_to_list_item(meta: "EmailMetadataRecord") -> dict[str, Any]:
    """EmailMetadataRecord → `email list` item。CLI 与 API 逐字段相同。

    比 meta_to_dict 窄 (无 to/cc/sync_error/retry_count), 但含 notion_url。
    """
    page_id = meta.notion_page_id
    notion_url = (
        f"https://www.notion.so/{page_id.replace('-', '')}" if page_id else None
    )
    return {
        "internal_id": meta.internal_id,
        "message_id": meta.message_id,
        "thread_id": meta.thread_id,
        "subject": meta.subject,
        "sender": meta.sender,
        "sender_name": meta.sender_name,
        "date_received": meta.date_received,
        "mailbox": meta.mailbox,
        "is_read": meta.is_read,
        "is_flagged": meta.is_flagged,
        "sync_status": meta.sync_status,
        "notion_page_id": page_id,
        "notion_url": notion_url,
    }
