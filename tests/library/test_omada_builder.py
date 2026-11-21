"""Tests for src.library.omada_builder and /api/library/artifacts/* routes."""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.library.omada_builder import (
    build_omada_demo,
    issue_preview_token,
    normalize_artifact_slug,
    publish_artifact_bundle,
    read_omada_catalog,
    resolve_preview_file,
)
from src.library.service import Actor, LibraryError, LibraryService


@pytest.fixture()
def svc(tmp_path: Path) -> LibraryService:
    return LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"))


@pytest.fixture()
def fake_kit(tmp_path: Path) -> Path:
    kit = tmp_path / "omada-ui-kit"
    (kit / "src" / "omada").mkdir(parents=True)
    (kit / "src" / "styles" / "modules").mkdir(parents=True)
    (kit / "node_modules" / ".bin").mkdir(parents=True)

    (kit / "package.json").write_text(
        json.dumps({
            "name": "omada-ui-kit",
            "dependencies": {"react": "^19.0.0", "antd": "^6.0.0", "echarts": "^5.6.0"},
            "devDependencies": {"vite": "^8.0.0"},
        }),
        encoding="utf-8",
    )
    (kit / "src" / "omada" / "index.ts").write_text(
        "export { OmadaProvider } from './theme/OmadaProvider';\n"
        "export { SAppShell, SCard, STable } from './components';\n",
        encoding="utf-8",
    )
    (kit / "COMPONENTS.md").write_text("# Omada Components\nSAppShell, SCard, STable", encoding="utf-8")
    (kit / "src" / "styles" / "tokens.css").write_text(":root {}\n", encoding="utf-8")
    (kit / "src" / "styles" / "omada-antd-overrides.css").write_text("", encoding="utf-8")
    (kit / "src" / "styles" / "modules" / "nav-shell.css").write_text("", encoding="utf-8")
    vite_bin = kit / "node_modules" / ".bin" / "vite"
    vite_bin.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    vite_bin.chmod(0o755)
    return kit


def test_normalize_artifact_slug_and_catalog(fake_kit: Path) -> None:
    assert normalize_artifact_slug("  Omada AP_Health Monitor!! ") == "omada-ap-health-monitor"
    assert normalize_artifact_slug("___") == ""

    catalog = read_omada_catalog(fake_kit)
    assert catalog["ok"] is True
    assert catalog["exported_symbols"] == ["OmadaProvider", "SAppShell", "SCard", "STable"]
    assert catalog["css_modules"] == ["nav-shell.css"]
    assert "Omada Components" in catalog["components_doc"]


def test_build_omada_demo_ingests_bundle_versions_and_cleans_harness(
    monkeypatch: pytest.MonkeyPatch,
    svc: LibraryService,
    fake_kit: Path,
) -> None:
    def _fake_subprocess_run(cmd, **kwargs):
        cfg_path = Path(cmd[cmd.index("--config") + 1])
        dist = cfg_path.parent / "dist"
        (dist / "assets").mkdir(parents=True, exist_ok=True)
        (dist / "index.html").write_text(
            '<!doctype html><html><head><link rel="stylesheet" href="./assets/app.css"></head>'
            '<body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>',
            encoding="utf-8",
        )
        (dist / "assets" / "app.js").write_text('console.log("omada-ok");', encoding="utf-8")
        (dist / "assets" / "app.css").write_text("body { margin: 0; }", encoding="utf-8")
        (dist / "assets" / "font.woff2").write_bytes(b"wOF2-binary-font-payload")
        (dist / "assets" / "app.js.map").write_text("ignored-sourcemap", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="built", stderr="")

    monkeypatch.setattr(subprocess, "run", _fake_subprocess_run)

    v1 = build_omada_demo(
        svc,
        "Omada Health",
        "export default function Demo() { return <div>v1</div>; }",
        title="AP Health v1",
        kit_root=fake_kit,
        base_url="http://127.0.0.1:8200",
        actor=Actor(kind="main_agent", session_id=12, message_id=34),
    )
    assert v1["ok"] is True
    assert v1["slug"] == "omada-health"
    assert v1["version"] == 1
    assert v1["file_count"] == 4  # .map excluded
    assert v1["path"] == "agent-docs/artifacts/omada-health/v1/index.html"
    assert v1["local_preview_url"].startswith("http://127.0.0.1:8200/api/library/artifacts/preview/")
    assert (fake_kit / "src" / "demos" / "omada-health" / "Demo.tsx").read_text(encoding="utf-8").endswith("v1</div>; }")
    assert not (fake_kit / ".mailagent-build").exists()

    # Second build for same slug bumps v2 immutably
    v2 = build_omada_demo(
        svc,
        "omada-health",
        "export default function Demo() { return <div>v2</div>; }",
        title="AP Health v2",
        kit_root=fake_kit,
    )
    assert v2["version"] == 2
    assert v2["path"] == "agent-docs/artifacts/omada-health/v2/index.html"

    # Preview route serves entry HTML & relative binary assets cleanly with sandbox CSP + CORS
    monkeypatch.setenv("MAILAGENT_LOCAL_API_TOKEN", "test-local-token")
    from src.api.app import APIError, error_envelope
    from src.api.routers import library as library_router

    app = FastAPI()
    app.include_router(library_router.preview_router)

    @app.exception_handler(APIError)
    async def _err(req, exc: APIError):
        return error_envelope(exc.code, exc.message, http_status=exc.http_status, request=req)

    client = TestClient(app)
    res_html = client.get(f"/api/library/artifacts/preview/{v1['preview_token']}/index.html")
    assert res_html.status_code == 200
    assert res_html.headers["content-security-policy"] == "sandbox allow-scripts allow-popups allow-forms allow-modals"
    assert res_html.headers["access-control-allow-origin"] == "*"
    assert "./assets/app.js" in res_html.text

    res_js = client.get(f"/api/library/artifacts/preview/{v1['preview_token']}/assets/app.js")
    assert res_js.status_code == 200
    assert 'console.log("omada-ok");' in res_js.text

    res_font = client.get(f"/api/library/artifacts/preview/{v1['preview_token']}/assets/font.woff2")
    assert res_font.status_code == 200
    assert res_font.content == b"wOF2-binary-font-payload"

    # Explicit preview token issuance and error guards
    reissued = issue_preview_token(svc, "omada-health", version=1, base_url="http://127.0.0.1:8200")
    assert reissued["version"] == 1
    assert reissued["preview_url"].endswith("/index.html")
    with pytest.raises(LibraryError):
        issue_preview_token(svc, "nonexistent-slug")

    # Traversal and non-loopback rejection
    with pytest.raises(LibraryError):
        resolve_preview_file(v1["preview_token"], "../secret.txt")
    with pytest.raises(APIError) as non_local:
        library_router._serve_preview_file(
            SimpleNamespace(client=SimpleNamespace(host="192.168.1.25")),
            v1["preview_token"],
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


_REAL_OMADA_KIT = Path.home() / "Documents" / "omada-ui-kit"


@pytest.mark.skipif(
    not (_REAL_OMADA_KIT / "node_modules" / ".bin" / "vite").is_file(),
    reason="local omada-ui-kit workspace with vite not present",
)
def test_real_omada_ui_kit_vite_smoke_build(svc: LibraryService) -> None:
    """Real end-to-end Vite 8 bundle check against ~/Documents/omada-ui-kit (cleaned up after)."""
    smoke_slug = "_mailagent-pytest-smoke"
    demo_dir = _REAL_OMADA_KIT / "src" / "demos" / "mailagent-pytest-smoke"
    try:
        catalog = read_omada_catalog(_REAL_OMADA_KIT)
        assert "SAppShell" in catalog["exported_symbols"]

        code = (
            "import React from 'react';\n"
            "import { SCard, SButton, STag } from '@/omada';\n"
            "export default function Demo() {\n"
            "  return (\n"
            "    <div className='p-6'>\n"
            "      <SCard title='Pytest Smoke'>\n"
            "        <STag color='success'>Online</STag>\n"
            "        <SButton type='primary'>Refresh</SButton>\n"
            "      </SCard>\n"
            "    </div>\n"
            "  );\n"
            "}\n"
        )
        res = build_omada_demo(svc, smoke_slug, code, title="Pytest Omada Smoke")
        assert res["ok"] is True
        assert res["version"] == 1
        assert res["file_count"] >= 2
        resolved_entry = resolve_preview_file(res["preview_token"], "index.html")
        assert resolved_entry.is_file()
        assert "./assets/" in resolved_entry.read_text(encoding="utf-8")
    finally:
        import shutil

        shutil.rmtree(demo_dir, ignore_errors=True)
        shutil.rmtree(_REAL_OMADA_KIT / "src" / "demos" / "_mailagent-pytest-smoke", ignore_errors=True)
