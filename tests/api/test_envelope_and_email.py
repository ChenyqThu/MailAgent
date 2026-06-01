"""Read-endpoint envelope conformance + email list/get/body/search happy paths.

Covers REMOTE-ACCESS §3.4 envelope (status / schema_version / data / error /
meta) for the repo-backed read endpoints, plus the core email read contracts
from BACKEND-INTERFACES §2.4 against the temp-DB fixture.
"""

from __future__ import annotations

from tests.api.conftest import (
    EMAIL_ID,
    EMAIL_NO_BODY_ID,
    MISSING_ID,
)


def _assert_success_envelope(payload: dict) -> None:
    """Every success read response MUST carry the §3.4 five-key envelope."""
    assert payload["status"] == "success"
    assert payload["schema_version"] == 1
    assert "data" in payload
    assert payload["error"] is None  # §3.4: error present-but-null on success
    meta = payload["meta"]
    assert meta["source"] == "sqlite"
    assert isinstance(meta["duration_ms"], int) and meta["duration_ms"] >= 0


def _assert_error_envelope(payload: dict, *, code: str) -> None:
    assert payload["status"] == "error"
    assert payload["schema_version"] == 1
    assert payload["data"] is None
    assert payload["error"]["code"] == code
    assert isinstance(payload["error"]["message"], str) and payload["error"]["message"]
    assert payload["meta"]["duration_ms"] >= 0


# ---------------------------------------------------------------------------
# /api/health (unauthenticated liveness)
# ---------------------------------------------------------------------------


def test_liveness_ok(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "schema_version": 1}


# ---------------------------------------------------------------------------
# GET /api/email/list
# ---------------------------------------------------------------------------


def test_email_list_envelope_and_pagination(client):
    r = client.get("/api/email/list")
    assert r.status_code == 200
    body = r.json()
    _assert_success_envelope(body)

    data = body["data"]
    assert isinstance(data, list)
    # Both seeded emails present.
    ids = {row["internal_id"] for row in data}
    assert {EMAIL_ID, EMAIL_NO_BODY_ID}.issubset(ids)

    # list_item shape: has notion_url, NOT to_addr/sync_error (narrower than get).
    item = next(row for row in data if row["internal_id"] == EMAIL_ID)
    assert "notion_url" in item
    assert "to_addr" not in item
    assert item["notion_url"].startswith("https://www.notion.so/")

    # meta pagination keys mirror CLI email-list.schema.json.
    meta = body["meta"]
    assert meta["total"] >= 2
    assert meta["limit"] == 50
    assert meta["offset"] == 0
    assert meta["count"] == len(data)


def test_email_list_filter_mailbox_and_flag(client):
    # F2: the router now binds the camelCase ListOpts keys from types.ts
    # (isFlagged), matching the frontend contract. The snake_case form is no
    # longer a query alias (see test_email_list_snakecase_isflagged_is_ignored).
    r = client.get("/api/email/list", params={"mailbox": "收件箱", "isFlagged": "true"})
    assert r.status_code == 200
    data = r.json()["data"]
    # Only EMAIL_ID is flagged.
    assert [row["internal_id"] for row in data] == [EMAIL_ID]


def test_email_list_camelcase_isflagged_filters(client):
    """F2: camelCase ListOpts keys (isFlagged/hasNotion/sinceDate/...) now bind.

    Previously the router only aliased `from`; isRead/isFlagged/hasNotion/since/
    until were bound by snake_case names, so a frontend sending the documented
    camelCase `isFlagged` got it silently dropped (FastAPI ignores unknown query
    params) → unfiltered results. F2 added the camelCase aliases; the filter now
    applies as the frontend contract intends.
    """
    r = client.get("/api/email/list", params={"isFlagged": "true"})
    assert r.status_code == 200
    ids = {row["internal_id"] for row in r.json()["data"]}
    # camelCase honored → only the flagged email comes back.
    assert ids == {EMAIL_ID}


def test_email_list_snakecase_isflagged_is_ignored(client):
    """F2 corollary: the snake_case key is no longer an alias → silently ignored.

    After F2 the query contract is the camelCase ListOpts shape. A stray
    snake_case `is_flagged` param (the pre-fix binding) is now an unknown query
    param and FastAPI drops it, so BOTH emails come back (no filter applied).
    Guards against accidentally re-introducing dual snake/camel binding.
    """
    r = client.get("/api/email/list", params={"is_flagged": "true"})
    assert r.status_code == 200
    ids = {row["internal_id"] for row in r.json()["data"]}
    assert {EMAIL_ID, EMAIL_NO_BODY_ID}.issubset(ids)


def test_email_list_invalid_status_400(client):
    r = client.get("/api/email/list", params={"status": "bogus"})
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")


def test_email_list_limit_out_of_range_422(client):
    # limit le=500 is enforced by FastAPI Query validation → 422 (not our envelope).
    r = client.get("/api/email/list", params={"limit": 9999})
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/email/{id}
# ---------------------------------------------------------------------------


def test_email_get_metadata_only(client):
    r = client.get(f"/api/email/{EMAIL_ID}")
    assert r.status_code == 200
    body = r.json()
    _assert_success_envelope(body)
    data = body["data"]
    assert data["internal_id"] == EMAIL_ID
    assert data["subject"] == "Quarterly redis timeout review"
    # is_important is the types.ts EmailDetail extension the router promises.
    assert data["is_important"] is True
    # No include → body null, attachments empty.
    assert data["body"] is None
    assert data["attachments"] == []


def test_email_get_with_body_and_attachments(client):
    r = client.get(f"/api/email/{EMAIL_ID}", params={"include": "body,attachments"})
    assert r.status_code == 200
    data = r.json()["data"]

    # body is a SUMMARY object (NOT the content) per email-get.schema.json.
    body_summary = data["body"]
    assert body_summary is not None
    assert set(body_summary) == {
        "format", "size_bytes", "has_inline_images",
        "fetched_at", "fetched_source", "raw_mime_sha256",
    }
    assert "content" not in body_summary  # content lives on /body, not here.

    # attachments embedded; local_path / internal_id stripped (gotcha #1).
    atts = data["attachments"]
    assert len(atts) == 3
    for a in atts:
        assert "local_path" not in a
        assert "internal_id" not in a
        assert "id" in a and "filename" in a


def test_email_get_include_all_expands(client):
    r = client.get(f"/api/email/{EMAIL_ID}", params={"include": "all"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["body"] is not None
    assert len(data["attachments"]) == 3


def test_email_get_missing_404(client):
    r = client.get(f"/api/email/{MISSING_ID}")
    assert r.status_code == 404
    _assert_error_envelope(r.json(), code="E_NOT_FOUND")


def test_email_get_invalid_include_400(client):
    r = client.get(f"/api/email/{EMAIL_ID}", params={"include": "garbage"})
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")


# ---------------------------------------------------------------------------
# GET /api/email/{id}/body
# ---------------------------------------------------------------------------


def test_email_body_markdown_default(client):
    r = client.get(f"/api/email/{EMAIL_ID}/body")
    assert r.status_code == 200
    body = r.json()
    _assert_success_envelope(body)
    data = body["data"]
    assert data["internal_id"] == EMAIL_ID
    assert data["format"] == "markdown"
    assert data["content"] == "Hello **redis** timeout body"
    assert data["fetched_source"] == "davmail"


def test_email_body_html(client):
    r = client.get(f"/api/email/{EMAIL_ID}/body", params={"format": "html"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["format"] == "html"
    assert "<b>redis</b>" in data["content"]


def test_email_body_raw_returns_hash(client):
    r = client.get(f"/api/email/{EMAIL_ID}/body", params={"format": "raw"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["format"] == "raw"
    # raw → content is the raw_mime_sha256 (64 hex chars), size_bytes = len(hash).
    assert data["content"] == "a" * 64
    assert data["size_bytes"] == 64


def test_email_body_invalid_format_400(client):
    r = client.get(f"/api/email/{EMAIL_ID}/body", params={"format": "pdf"})
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")


def test_email_body_no_body_row_404(client):
    r = client.get(f"/api/email/{EMAIL_NO_BODY_ID}/body")
    assert r.status_code == 404
    _assert_error_envelope(r.json(), code="E_NOT_FOUND")


# ---------------------------------------------------------------------------
# GET /api/email/search
# ---------------------------------------------------------------------------


def test_email_search_smart_default(client):
    r = client.get("/api/email/search", params={"q": "redis timeout"})
    assert r.status_code == 200
    body = r.json()
    _assert_success_envelope(body)

    data = body["data"]
    # SearchResult shape: items + total_indexed + mode (+ transformed_query?).
    assert "items" in data
    assert data["mode"] == "smart"
    assert data["total_indexed"] >= 1
    # "redis timeout" → smart rewrite to "redis AND timeout" → transformed_query present.
    assert data.get("transformed_query") == "redis AND timeout"

    hits = data["items"]
    assert len(hits) >= 1
    hit = hits[0]
    assert hit["internal_id"] == EMAIL_ID
    assert "<mark>" in hit["snippet"]  # FTS snippet highlight.
    assert isinstance(hit["rank"], float)

    meta = body["meta"]
    assert meta["query"] == "redis timeout"
    assert meta["mode"] == "smart"
    assert meta["total_hits"] == len(hits)
    assert meta["total_indexed"] >= 1


def test_email_search_raw_mode(client):
    r = client.get("/api/email/search", params={"q": "redis", "raw": "true"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["mode"] == "raw"
    # raw mode never sets transformed_query.
    assert "transformed_query" not in data
    assert any(h["internal_id"] == EMAIL_ID for h in data["items"])


def test_email_search_no_match_empty(client):
    r = client.get("/api/email/search", params={"q": "zzzznonexistentzzzz"})
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["items"] == []
    assert r.json()["meta"]["total_hits"] == 0


def test_email_search_invalid_fts_syntax_empty_not_500(client):
    # Unbalanced quote → repo swallows the FTS OperationalError → [] (no 500).
    r = client.get("/api/email/search", params={"q": '"unbalanced', "raw": "true"})
    assert r.status_code == 200
    assert r.json()["data"]["items"] == []


def test_email_search_missing_q_422(client):
    # q is a required Query param → FastAPI 422.
    r = client.get("/api/email/search")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/email/pinned-ids (repo.list_pinned_ids — fully repo-backed)
# ---------------------------------------------------------------------------


def test_email_pinned_ids_empty(client):
    # No seeded email is pinned (is_pinned=0 for both) → empty list, count 0.
    r = client.get("/api/email/pinned-ids")
    assert r.status_code == 200
    body = r.json()
    _assert_success_envelope(body)
    assert body["data"] == {"pinned_ids": [], "count": 0}


def test_email_pinned_ids_not_shadowed_by_dynamic_id(client):
    # The `:int` converter on /{internal_id} must NOT swallow "pinned-ids":
    # a 200 list response (not a 404/422 from the int route) proves the routing.
    r = client.get("/api/email/pinned-ids")
    assert r.status_code == 200
    assert "pinned_ids" in r.json()["data"]


# ---------------------------------------------------------------------------
# Write endpoints — pre-fork input validation (E_INVALID_ARG before any CLI
# subprocess; the happy CLI paths need a real `mailagent` fork and are covered
# by e2e, not these unit tests).
# ---------------------------------------------------------------------------


def test_email_flag_requires_a_field_400(client):
    r = client.post(f"/api/email/{EMAIL_ID}/flag", json={})
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")


def test_email_flag_rejects_noninteger_ids_400(client):
    r = client.post(
        f"/api/email/{EMAIL_ID}/flag",
        json={"isRead": True, "ids": ["nope"]},
    )
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")


def test_email_draft_requires_internal_id_400(client):
    r = client.post("/api/email/draft", json={"mode": "reply"})
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")


def test_email_send_requires_internal_id_400(client):
    r = client.post("/api/email/send", json={"mode": "reply"})
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")


def test_email_draft_plan_invalid_mode_400(client):
    r = client.post(f"/api/email/{EMAIL_ID}/draft-plan", json={"mode": "bogus"})
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")


def test_email_pin_requires_bool_400(client):
    r = client.post(f"/api/email/{EMAIL_ID}/pin", json={"pinned": "yes"})
    assert r.status_code == 400
    _assert_error_envelope(r.json(), code="E_INVALID_ARG")
