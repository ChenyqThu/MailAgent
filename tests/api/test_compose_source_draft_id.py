"""HTTP 面 sourceDraftId 解析 (D1 Bug A) — _compose_request_from_body。

wire 契约: body key "sourceDraftId" (int, 草稿行自己的 internal_id) →
ComposeRequest.source_draft_id; 非 int (含 bool) 静默置 None (对齐该函数其余
字段的宽松形状处理)。
"""

from __future__ import annotations

import pytest

from src.api.routers.email import _compose_request_from_body


def test_reads_source_draft_id():
    req = _compose_request_from_body(
        -1, {"mode": "new", "sourceDraftId": 1_000_000_001}
    )
    assert req.source_draft_id == 1_000_000_001


def test_absent_source_draft_id_defaults_none():
    req = _compose_request_from_body(-1, {"mode": "new"})
    assert req.source_draft_id is None


@pytest.mark.parametrize("bad", ["123", True, None, 1.5, [1]])
def test_rejects_non_int_source_draft_id(bad):
    req = _compose_request_from_body(-1, {"mode": "new", "sourceDraftId": bad})
    assert req.source_draft_id is None
