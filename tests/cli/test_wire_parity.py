"""D2a parity: src/services/wire.py 投影 == 旧 CLI + API router 手抄 wire dict 的 golden。

D2a 把 ``_meta_to_dict`` / ``_body_summary`` / ``_attachment_to_dict`` /
``_meta_record_to_list_item`` 从 3 处手抄 (cli/commands/email.py + cli/commands/
attachment.py + api/routers/email.py) 收编到单一真源 ``src.services.wire``。本测试锁死:

1. **golden 字面量 + 字节序**: wire 投影逐字段 == 旧 helper 形状, 且 ``list(d.keys())``
   顺序一致 (emit/HTTP JSON 字节序不可漂移)。
2. **两端参数分叉是「故意差异」而非手抄漂移**:
   - ``meta_to_dict``: 默认 18 字段 (CLI email get) ；``include_important=True`` 末尾
     追加 ``is_important`` = 19 字段 (API GET /email/{id} 给前端 EmailDetail)。
   - ``attachment_to_dict``: 默认 11 字段 (email get 内嵌 + API, gotcha #1 无 internal_id)；
     ``include_internal_id=True`` 在 ``id`` 之后插 ``internal_id`` = 12 字段 (attachment list)。

与 docs/cli-schema/email-*.schema.json + cli.gen.ts 锁死的 data 形状一致。
"""

from __future__ import annotations

from src.repository.email_repository import (
    AttachmentRecord,
    EmailBodyRecord,
    EmailMetadataRecord,
)
from src.services import wire


def _make_meta() -> EmailMetadataRecord:
    return EmailMetadataRecord(
        internal_id=12345,
        message_id="<msg-12345@example.com>",
        thread_id="<thread-1@example.com>",
        subject="Hello D2a",
        sender="alice@example.com",
        sender_name="Alice",
        to_addr="bob@example.com",
        cc_addr="carol@example.com",
        date_received="2026-06-04 10:00:00",
        mailbox="收件箱",
        is_read=True,
        is_flagged=False,
        sync_status="synced",
        notion_page_id="31a15375830d81798e75fcfce933808b",
        notion_thread_id="thread-page-id",
        sync_error=None,
        retry_count=0,
        next_retry_at=None,
        created_at=1.0,
        updated_at=2.0,
        is_important=True,
    )


def _make_body() -> EmailBodyRecord:
    return EmailBodyRecord(
        internal_id=12345,
        message_id="<msg-12345@example.com>",
        html="<p>x</p>",
        markdown="x",
        body_format="html",
        body_size_bytes=8,
        has_inline_images=False,
        raw_mime_sha256="deadbeef",
        fetched_at=3.0,
        fetched_source="applescript",
    )


def _make_attachment() -> AttachmentRecord:
    return AttachmentRecord(
        id=7,
        internal_id=12345,
        filename="report.pdf",
        content_type="application/pdf",
        size_bytes=1024,
        is_inline=False,
        content_id=None,
        local_path="data/attachments/12345/report.pdf",  # 绝不能出现在 wire dict
        sha256="cafef00d",
        derived_from=None,
        derived_format=None,
        notion_file_id="nf-1",
        notion_block_id="nb-1",
        created_at=4.0,
    )


# ============================================================
# meta_to_dict — CLI email get (18) vs API GET /email/{id} (19)
# ============================================================

def test_meta_to_dict_default_18_fields_golden():
    meta = _make_meta()
    data = wire.meta_to_dict(meta)
    # 与旧 cli/commands/email.py::_meta_to_dict 逐字段相同 (含 notion_url property)。
    assert data == {
        "internal_id": 12345,
        "message_id": "<msg-12345@example.com>",
        "thread_id": "<thread-1@example.com>",
        "subject": "Hello D2a",
        "sender": "alice@example.com",
        "sender_name": "Alice",
        "to_addr": "bob@example.com",
        "cc_addr": "carol@example.com",
        "date_received": "2026-06-04 10:00:00",
        "mailbox": "收件箱",
        "is_read": True,
        "is_flagged": False,
        "sync_status": "synced",
        "notion_page_id": "31a15375830d81798e75fcfce933808b",
        "notion_thread_id": "thread-page-id",
        "notion_url": "https://www.notion.so/31a15375830d81798e75fcfce933808b",
        "sync_error": None,
        "retry_count": 0,
    }
    # 字节序锁定 (CLI email get 默认无 is_important)。
    assert "is_important" not in data
    assert list(data.keys())[-1] == "retry_count"


def test_meta_to_dict_include_important_appends_field():
    meta = _make_meta()
    data = wire.meta_to_dict(meta, include_important=True)
    # 与旧 api/routers/email.py::_meta_to_dict 逐字段相同 (末尾追加 is_important)。
    assert data["is_important"] is True
    assert list(data.keys())[-1] == "is_important"


def test_meta_to_dict_routers_is_cli_plus_important():
    """API 形 (19) == CLI 形 (18) key 序 + 末尾 is_important —— 故意差异, 非手抄漂移。"""
    meta = _make_meta()
    cli_keys = list(wire.meta_to_dict(meta).keys())
    api_keys = list(wire.meta_to_dict(meta, include_important=True).keys())
    assert api_keys == cli_keys + ["is_important"]


# ============================================================
# body_summary — CLI 与 API 逐字段相同
# ============================================================

def test_body_summary_golden():
    data = wire.body_summary(_make_body())
    assert data == {
        "format": "html",
        "size_bytes": 8,
        "has_inline_images": False,
        "fetched_at": 3.0,
        "fetched_source": "applescript",
        "raw_mime_sha256": "deadbeef",
    }


def test_body_summary_none():
    assert wire.body_summary(None) is None


# ============================================================
# attachment_to_dict — email get 内嵌 (11) vs attachment list (12)
# ============================================================

def test_attachment_to_dict_default_no_internal_id_golden():
    data = wire.attachment_to_dict(_make_attachment())
    # 与旧 email.py/routers email.py 内嵌附件逐字段相同 (gotcha #1: 无 internal_id / local_path)。
    assert data == {
        "id": 7,
        "filename": "report.pdf",
        "size_bytes": 1024,
        "content_type": "application/pdf",
        "is_inline": False,
        "content_id": None,
        "sha256": "cafef00d",
        "derived_from": None,
        "derived_format": None,
        "notion_file_id": "nf-1",
        "notion_block_id": "nb-1",
    }
    # gotcha #1: 绝不回显 host 路径 / internal_id。
    assert "local_path" not in data
    assert "internal_id" not in data


def test_attachment_to_dict_include_internal_id_after_id():
    """attachment list 形 (12): internal_id 紧跟 id (保旧 cli/commands/attachment.py 字节序)。"""
    data = wire.attachment_to_dict(_make_attachment(), include_internal_id=True)
    keys = list(data.keys())
    assert keys[0] == "id"
    assert keys[1] == "internal_id"  # 字节序断点: id 之后、filename 之前
    assert data["internal_id"] == 12345
    assert "local_path" not in data
    # 其余字段与默认形一致 (仅多 internal_id)。
    default_keys = list(wire.attachment_to_dict(_make_attachment()).keys())
    assert keys == ["id", "internal_id"] + default_keys[1:]


# ============================================================
# meta_record_to_list_item — CLI list 与 API list 逐字段相同
# ============================================================

def test_meta_record_to_list_item_golden():
    data = wire.meta_record_to_list_item(_make_meta())
    assert data == {
        "internal_id": 12345,
        "message_id": "<msg-12345@example.com>",
        "thread_id": "<thread-1@example.com>",
        "subject": "Hello D2a",
        "sender": "alice@example.com",
        "sender_name": "Alice",
        "date_received": "2026-06-04 10:00:00",
        "mailbox": "收件箱",
        "is_read": True,
        "is_flagged": False,
        "sync_status": "synced",
        "notion_page_id": "31a15375830d81798e75fcfce933808b",
        "notion_url": "https://www.notion.so/31a15375830d81798e75fcfce933808b",
    }


def test_meta_record_to_list_item_no_page_id_null_url():
    meta = _make_meta()
    meta.notion_page_id = None
    data = wire.meta_record_to_list_item(meta)
    assert data["notion_page_id"] is None
    assert data["notion_url"] is None
