"""Tests for src.library.artifact_bundle and /api/library/artifacts/* routes."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.library.artifact_bundle import (
    guess_media_type,
    issue_preview_token,
    normalize_artifact_slug,
    publish_artifact_bundle,
    resolve_preview_file,
)
from src.library.service import Actor, LibraryError, LibraryService


@pytest.fixture()
def svc(tmp_path: Path) -> LibraryService:
    return LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"))


def test_normalize_artifact_slug_and_media_type() -> None:
    assert normalize_artifact_slug("  Omada AP_Health Monitor!! ") == "omada-ap-health-monitor"
    assert normalize_artifact_slug("___") == ""
    assert guess_media_type("index.html") == "text/html; charset=utf-8"
    assert guess_media_type("app.mjs") == "application/javascript; charset=utf-8"
    assert guess_media_type("font.woff2") == "font/woff2"


def test_preview_token_serves_bundle_assets_with_csp_cors_and_security_guards(
    monkeypatch: pytest.MonkeyPatch,
    svc: LibraryService,
) -> None:
    svc.create_file(
        "agent-docs/artifacts/demo-health/v1/index.html",
        b'<!doctype html><html><head><link rel="stylesheet" href="./assets/app.css"></head>'
        b'<body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>',
        actor=Actor(kind="user"),
        source="agent",
    )
    svc.create_file(
        "agent-docs/artifacts/demo-health/v1/assets/app.js",
        b'console.log("ok");',
        actor=Actor(kind="user"),
        source="agent",
    )
    svc.create_file(
        "agent-docs/artifacts/demo-health/v1/assets/font.woff2",
        b"wOF2-binary-font-payload",
        actor=Actor(kind="user"),
        source="agent",
    )

    issued = issue_preview_token(svc, "demo-health", version=1, base_url="http://127.0.0.1:8200")
    assert issued["version"] == 1
    assert issued["preview_url"].startswith("http://127.0.0.1:8200/api/library/artifacts/preview/")

    monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "test-local-token")
    from src.api.app import APIError, app as real_app, error_envelope
    from src.api.routers import library as library_router

    app = FastAPI()
    app.include_router(library_router.preview_router)

    @app.exception_handler(APIError)
    async def _err(req, exc: APIError):
        return error_envelope(exc.code, exc.message, http_status=exc.http_status, request=req)

    client = TestClient(app)
    res_html = client.get(f"/api/library/artifacts/preview/{issued['token']}/index.html")
    assert res_html.status_code == 200
    assert (
        res_html.headers["content-security-policy"]
        == "sandbox allow-scripts allow-popups allow-forms allow-modals"
    )
    assert res_html.headers["access-control-allow-origin"] == "*"
    assert "./assets/app.js" in res_html.text

    res_head = client.head(f"/api/library/artifacts/preview/{issued['token']}/index.html")
    assert res_head.status_code == 200

    real_client = TestClient(real_app)
    res_null_origin = real_client.get(
        f"/api/library/artifacts/preview/{issued['token']}/index.html",
        headers={"Origin": "null"},
    )
    assert res_null_origin.status_code == 200
    assert res_null_origin.headers.get("access-control-allow-origin") == "*"
    assert "access-control-allow-credentials" not in res_null_origin.headers

    res_js = client.get(f"/api/library/artifacts/preview/{issued['token']}/assets/app.js")
    assert res_js.status_code == 200
    assert 'console.log("ok");' in res_js.text

    res_font = client.get(f"/api/library/artifacts/preview/{issued['token']}/assets/font.woff2")
    assert res_font.status_code == 200
    assert res_font.content == b"wOF2-binary-font-payload"

    with pytest.raises(LibraryError):
        issue_preview_token(svc, "nonexistent-slug")

    with pytest.raises(LibraryError):
        resolve_preview_file(issued["token"], "../secret.txt")

    with pytest.raises(APIError) as non_local:
        library_router._serve_preview_file(
            SimpleNamespace(client=SimpleNamespace(host="192.168.1.25")),
            issued["token"],
            "index.html",
        )
    assert non_local.value.http_status == 403


@pytest.mark.asyncio
async def test_publish_artifact_bundle_encodes_text_and_binary_and_invokes_connector(
    monkeypatch: pytest.MonkeyPatch,
    svc: LibraryService,
) -> None:
    svc.create_file(
        "agent-docs/artifacts/demo-bundle/v1/index.html",
        b"<!doctype html><html><body>bundle</body></html>",
        actor=Actor(kind="user"),
        source="agent",
    )
    svc.create_file(
        "agent-docs/artifacts/demo-bundle/v1/assets/app.js",
        b"console.log(1);",
        actor=Actor(kind="user"),
        source="agent",
    )
    svc.create_file(
        "agent-docs/artifacts/demo-bundle/v1/assets/font.woff2",
        b"\x00\x01\x02woff2",
        actor=Actor(kind="user"),
        source="agent",
    )

    captured: dict = {}

    async def _fake_invoke(connector_id: str, tool_name: str, arguments=None, **kwargs):
        captured["connector_id"] = connector_id
        captured["tool_name"] = tool_name
        captured["arguments"] = arguments
        captured["kwargs"] = kwargs
        return {
            "content": json.dumps({
                "ok": True,
                "slug": "demo-bundle",
                "title": "Demo Bundle",
                "version": 1,
                "file_count": len(arguments["files"]),
                "size_bytes": 68,
                "review_url": "https://canvas.chenge.ink/a/demo-bundle/v/1",
                "share_url": "https://canvas.chenge.ink/s/tok?v=1",
                "raw_url": "https://canvas.chenge.ink/raw/demo-bundle/v1/index.html",
            }),
            "images": [],
            "is_error": False,
            "truncated": False,
            "elapsed_ms": 12,
        }

    monkeypatch.setattr("src.connectors.service.invoke_connector_tool", _fake_invoke)

    res = await publish_artifact_bundle(svc, "demo-bundle", version=1, title="Demo Bundle")
    assert res["ok"] is True
    assert res["review_url"] == "https://canvas.chenge.ink/a/demo-bundle/v/1"
    assert res["file_count"] == 3
    assert captured["connector_id"] == "artifact_server"
    assert captured["tool_name"] == "artifact_publish"
    files = {f["path"]: f for f in captured["arguments"]["files"]}
    assert files["index.html"]["encoding"] == "utf8"
    assert files["assets/app.js"]["encoding"] == "utf8"
    assert files["assets/font.woff2"]["encoding"] == "base64"
    assert base64.b64decode(files["assets/font.woff2"]["content"]) == b"\x00\x01\x02woff2"
