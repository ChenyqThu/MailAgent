"""Attachment list + binary download/inline + the path-traversal 403 guard.

Security-critical: the download/inline endpoints resolve `local_path` and MUST
reject any path that escapes the AttachmentStore base dir (REMOTE-ACCESS §9 /
implementation-spec gotcha #1). The fixture seeds an attachment whose local_path
points outside the temp store; we assert 403 E_AUTH_FAILED.
"""

from __future__ import annotations

from tests.api.conftest import (
    ATT_ESCAPE_ID,
    ATT_NOPATH_ID,
    ATT_NORMAL_ID,
    EMAIL_ID,
    MISSING_ID,
)


# ---------------------------------------------------------------------------
# GET /api/attachment/list/{internal_id}
# ---------------------------------------------------------------------------


def test_attachment_list_strips_local_path(client):
    r = client.get(f"/api/attachment/list/{EMAIL_ID}")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "success"
    assert body["error"] is None
    assert body["meta"]["source"] == "sqlite"

    items = body["data"]
    assert len(items) == 3
    for a in items:
        # gotcha #1: host path NEVER on the wire.
        assert "local_path" not in a
        assert "created_at" not in a
    assert body["meta"]["count"] == 3
    assert body["meta"]["internal_id"] == EMAIL_ID


def test_attachment_list_unknown_email_404(client):
    r = client.get(f"/api/attachment/list/{MISSING_ID}")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# ---------------------------------------------------------------------------
# GET /api/attachment/{att_id}/download
# ---------------------------------------------------------------------------


def test_attachment_download_ok(client):
    r = client.get(f"/api/attachment/{ATT_NORMAL_ID}/download")
    assert r.status_code == 200
    assert r.content == b"%PDF-1.4 fake pdf bytes"
    assert r.headers["content-type"].startswith("application/pdf")
    cd = r.headers["content-disposition"]
    assert cd.startswith("attachment;")
    assert "report.pdf" in cd
    assert r.headers["accept-ranges"] == "bytes"


def test_attachment_download_range_206(client):
    r = client.get(
        f"/api/attachment/{ATT_NORMAL_ID}/download",
        headers={"Range": "bytes=0-3"},
    )
    assert r.status_code == 206
    assert r.content == b"%PDF"
    assert r.headers["content-range"] == "bytes 0-3/23"
    assert r.headers["content-length"] == "4"


def test_attachment_download_range_unsatisfiable_416(client):
    r = client.get(
        f"/api/attachment/{ATT_NORMAL_ID}/download",
        headers={"Range": "bytes=9999-10000"},
    )
    assert r.status_code == 416
    assert r.json()["error"]["code"] == "E_INVALID_ARG"


def test_attachment_inline_disposition(client):
    r = client.get(f"/api/attachment/{ATT_NORMAL_ID}/inline")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("inline;")


# ---------------------------------------------------------------------------
# Path-traversal guard — THE security assertion
# ---------------------------------------------------------------------------


def test_attachment_download_path_traversal_403(client):
    """local_path escaping the store base dir → 403 E_AUTH_FAILED, no bytes."""
    r = client.get(f"/api/attachment/{ATT_ESCAPE_ID}/download")
    assert r.status_code == 403
    body = r.json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "E_AUTH_FAILED"
    assert body["data"] is None
    # The escaping host path must not leak into the error message/hint.
    assert "secret.env" not in (body["error"].get("hint") or "")


def test_attachment_inline_path_traversal_403(client):
    r = client.get(f"/api/attachment/{ATT_ESCAPE_ID}/inline")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_AUTH_FAILED"


def test_attachment_download_no_local_path_404(client):
    r = client.get(f"/api/attachment/{ATT_NOPATH_ID}/download")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_attachment_download_unknown_id_404(client):
    r = client.get("/api/attachment/424242/download")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"
