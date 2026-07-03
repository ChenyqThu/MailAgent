"""PUT /api/email/compose-attachment + compose body attachments 解析 — prd 07-04 D1.

上传端点: raw octet-stream → staging (tmp 目录, 经 monkeypatch get_service_ctx),
断言 envelope data 形状 {stage_id, filename, size, mime} / cap 400 / 路径穿越
sanitize / 空 body 400。compose /draft /send 的 attachments 解析: snake_case
canonical + camelCase 容忍 / local_path 拒 (HTTP 信任边界) / 判别式非法 400
(校验早于 service 构造) / send-approved 显式拒 (审批 hash 不覆盖附件)。
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Optional

import pytest

import src.api.routers.email as email_router
import src.services.mail_write as mail_write
from src.services.compose_staging import staging_root
from src.services.mail_write import ComposeDraftResult, ComposeSendResult

from tests.api.conftest import EMAIL_ID


@pytest.fixture()
def staging_cfg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """把 upload 端点的 get_service_ctx 指到 tmp staging 根 (不碰真实 data/)。"""
    cfg = SimpleNamespace(sync_store_db_path=str(tmp_path / "sync_store.db"))
    monkeypatch.setattr(
        email_router, "get_service_ctx", lambda: SimpleNamespace(config=cfg)
    )
    return cfg


# ---------------------------------------------------------------------------
# 上传端点
# ---------------------------------------------------------------------------


def test_upload_success_envelope_shape(client, staging_cfg):
    r = client.put(
        "/api/email/compose-attachment",
        params={"filename": "report.pdf"},
        content=b"%PDF-fake-bytes",
        headers={"Content-Type": "application/octet-stream"},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert set(data) == {"stage_id", "filename", "size", "mime"}
    assert data["filename"] == "report.pdf"
    assert data["size"] == len(b"%PDF-fake-bytes")
    assert data["mime"] == "application/pdf"
    staged = staging_root(staging_cfg) / data["stage_id"] / "report.pdf"
    assert staged.is_file()
    assert staged.read_bytes() == b"%PDF-fake-bytes"


def test_upload_traversal_filename_sanitized(client, staging_cfg):
    r = client.put(
        "/api/email/compose-attachment",
        params={"filename": "../../etc/passwd"},
        content=b"x",
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert "/" not in data["filename"] and ".." not in Path(data["filename"]).parts
    staged = staging_root(staging_cfg) / data["stage_id"] / data["filename"]
    assert staged.is_file()
    assert staged.resolve().is_relative_to(staging_root(staging_cfg).resolve())


def test_upload_over_cap_400(client, staging_cfg, monkeypatch):
    monkeypatch.setattr(mail_write, "MAX_COMPOSE_ATTACH_BYTES", 10)
    r = client.put(
        "/api/email/compose-attachment",
        params={"filename": "big.bin"},
        content=b"x" * 11,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert not staging_root(staging_cfg).exists()  # 未落任何暂存


def test_upload_empty_body_400(client, staging_cfg):
    r = client.put(
        "/api/email/compose-attachment", params={"filename": "a.txt"}, content=b""
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_upload_missing_filename_validation_envelope(client, staging_cfg):
    r = client.put("/api/email/compose-attachment", content=b"x")
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_upload_unknown_ext_falls_back_octet_stream(client, staging_cfg):
    r = client.put(
        "/api/email/compose-attachment",
        params={"filename": "weird.zzz123"},
        content=b"x",
    )
    assert r.json()["data"]["mime"] == "application/octet-stream"


# ---------------------------------------------------------------------------
# compose body attachments 解析 (spy: 只record compose_draft/send 的 request)
# ---------------------------------------------------------------------------


class _ComposeSpy:
    instances: list["_ComposeSpy"] = []

    def __init__(self, ctx=None):
        self.requests: list = []
        _ComposeSpy.instances.append(self)

    def compose_draft(self, request, *, actor):
        self.requests.append(request)
        return ComposeDraftResult(
            internal_id=request.internal_id, drafts_folder="Drafts",
            appended_uid=7, method="imap_append", mode=request.mode,
            to_count=1, cc_count=0, attachments=len(request.attachments or []),
            warnings=[],
        )

    def send(self, request, *, actor, confirmed):
        self.requests.append(request)
        return ComposeSendResult(
            internal_id=request.internal_id, mode=request.mode,
            message_id="<m@x>", archived_to_sent=False, method="smtp",
            to_count=1, cc_count=0,
            attachments=len(request.attachments or []), warnings=[],
        )


@pytest.fixture()
def compose_spy(monkeypatch):
    _ComposeSpy.instances = []
    monkeypatch.setattr(email_router, "MailWriteService", _ComposeSpy)
    return _ComposeSpy


def _last_request(spy) -> Optional[object]:
    assert spy.instances and spy.instances[-1].requests
    return spy.instances[-1].requests[-1]


def test_draft_attachments_snake_case_canonical(client, compose_spy):
    r = client.post(
        "/api/email/draft",
        json={
            "internalId": EMAIL_ID, "mode": "reply", "bodyHtml": "<p>x</p>",
            "attachments": [{"stage_id": "a" * 32}, {"attachment_id": 7}],
        },
    )
    assert r.status_code == 200, r.text
    req = _last_request(compose_spy)
    assert req.attachments == [{"stage_id": "a" * 32}, {"attachment_id": 7}]
    assert r.json()["data"]["attachments"] == 2


def test_send_attachments_camel_case_tolerated(client, compose_spy):
    r = client.post(
        "/api/email/send",
        json={
            "internalId": EMAIL_ID, "mode": "reply", "bodyHtml": "<p>x</p>",
            "attachments": [{"stageId": "b" * 32}, {"attachmentId": 9}],
        },
    )
    assert r.status_code == 200, r.text
    req = _last_request(compose_spy)
    # camelCase 镜像归一成 canonical snake_case 再进 service
    assert req.attachments == [{"stage_id": "b" * 32}, {"attachment_id": 9}]


def test_attachments_key_absent_is_none(client, compose_spy):
    client.post(
        "/api/email/draft",
        json={"internalId": EMAIL_ID, "mode": "forward", "bodyHtml": "<p>x</p>",
              "to": ["x@y.com"]},
    )
    assert _last_request(compose_spy).attachments is None


def test_attachments_empty_list_is_explicit_empty(client, compose_spy):
    client.post(
        "/api/email/draft",
        json={"internalId": EMAIL_ID, "mode": "forward", "bodyHtml": "<p>x</p>",
              "to": ["x@y.com"], "attachments": []},
    )
    assert _last_request(compose_spy).attachments == []


def test_attachments_local_path_rejected_400(client, compose_spy):
    # local_path 是 CLI in-process 专用形态 — HTTP 面拒 (信任边界)
    r = client.post(
        "/api/email/draft",
        json={
            "internalId": EMAIL_ID, "mode": "reply", "bodyHtml": "<p>x</p>",
            "attachments": [{"local_path": "/etc/passwd"}],
        },
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert compose_spy.instances == []  # 校验早于 service 构造


@pytest.mark.parametrize(
    "bad",
    [
        [{"stage_id": "x", "attachment_id": 1}],   # 两键同给
        [{"stage_id": ""}],                        # 空串
        [{"attachment_id": "7"}],                  # 非 int
        [{"attachment_id": True}],                 # bool 不是合法 id
        ["not-an-object"],                         # 非 dict 项
        "not-a-list",                              # 非 list
    ],
)
def test_attachments_invalid_shapes_400(client, compose_spy, bad):
    r = client.post(
        "/api/email/draft",
        json={"internalId": EMAIL_ID, "mode": "reply", "bodyHtml": "<p>x</p>",
              "attachments": bad},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_INVALID_ARG"
    assert compose_spy.instances == []


def test_send_approved_rejects_attachments(client):
    # prd D3: 审批 hash (to/cc/bcc/subject/body) 不覆盖附件 → fail-closed 拒绝,
    # 早于 hash guard (无需合法 token 即可断言)。
    r = client.post(
        "/api/email/send-approved",
        json={
            "to": ["x@y.com"], "subject": "S", "bodyText": "hi",
            "attachments": [{"stage_id": "a" * 32}],
            "contentHash": "h", "idempotencyKey": "k",
            "approvalToken": "t", "expiresAt": 1,
        },
    )
    assert r.status_code == 400
    assert "attachments" in r.json()["error"]["message"]
