"""P3 serve-api: GET /api/folder/discover + GET/PUT /api/folder/whitelist (多文件夹同步)。

mock list_folders (不连真实 IMAP) + stub Config (davmail 后端)，验证端点契约 + davmail 门控 +
.env 白名单读写。复用 conftest 的 auth bypass (MAILAGENT_API_AUTH_DISABLED=true)。
"""
from __future__ import annotations

from typing import Iterator

import pytest
from fastapi.testclient import TestClient

from src.api.app import app
from src.api.deps import get_settings
from src.mail.backend.imap_client import FolderInfo


def _fake_folders():
    return [
        FolderInfo("INBOX", "INBOX", "/", None, True, False, None, 100),
        FolderInfo("Sent", "Sent", "/", "\\sent", True, False, None, 50),
        FolderInfo("DMS&VvpO9lPRXgM-", "DMS固件发布", "/", None, False, False, None, 728),
        FolderInfo("Jira", "Jira", "/", None, False, False, None, 3458),
        FolderInfo("&W,mL3VOGU,KLsF9V-", "对话历史记录", "/", None, False, True, None, 12),
    ]


class _StubConfig:
    def __init__(self, backend="davmail", sync_folders=""):
        self.mailagent_backend = backend
        self.sync_folders = sync_folders
        self.sync_store_db_path = ":memory:"


@pytest.fixture()
def folder_client(monkeypatch) -> Iterator[TestClient]:
    cfg = _StubConfig()
    app.dependency_overrides[get_settings] = lambda: cfg
    monkeypatch.setattr(
        "src.mail.backend.imap_client.list_folders",
        lambda c, with_counts=True: _fake_folders(),
    )
    with TestClient(app, raise_server_exceptions=False) as c:
        c._cfg = cfg  # type: ignore[attr-defined]
        yield c
    app.dependency_overrides.pop(get_settings, None)


class TestDiscover:
    def test_discover_contract(self, folder_client):
        r = folder_client.get("/api/folder/discover")
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert len(data["folders"]) == 5
        names = {f["display_name"] for f in data["folders"]}
        assert "DMS固件发布" in names and "对话历史记录" in names
        inbox = next(f for f in data["folders"] if f["imap_name"] == "INBOX")
        assert inbox["is_system"] is True
        assert all(f["is_synced"] is False for f in data["folders"])
        assert "tree" in data and isinstance(data["tree"], list)

    def test_discover_marks_synced(self, folder_client):
        folder_client._cfg.sync_folders = '["Jira"]'
        r = folder_client.get("/api/folder/discover")
        data = r.json()["data"]
        jira = next(f for f in data["folders"] if f["imap_name"] == "Jira")
        assert jira["is_synced"] is True
        assert data["whitelist"] == ["Jira"]

    def test_discover_gated_on_applescript(self, folder_client):
        folder_client._cfg.mailagent_backend = "applescript"
        r = folder_client.get("/api/folder/discover")
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "E_INVALID_ARG"


class TestWhitelist:
    def test_get_whitelist(self, folder_client):
        folder_client._cfg.sync_folders = '["Notion","Jira"]'
        r = folder_client.get("/api/folder/whitelist")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["folders"] == ["Notion", "Jira"]

    def test_put_whitelist_writes_env(self, folder_client, tmp_path, monkeypatch):
        env_file = tmp_path / ".env"
        env_file.write_text("MAILAGENT_BACKEND=davmail\n")
        monkeypatch.setattr("src.config._resolve_env_file", lambda: str(env_file))
        r = folder_client.put(
            "/api/folder/whitelist",
            json={"folders": ["Notion", "&W,mL3VOGU,KLsF9V-", "INBOX", "Notion"]},
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        # INBOX 排除 + 去重
        assert data["folders"] == ["Notion", "&W,mL3VOGU,KLsF9V-"]
        assert data["restart_required"] is True
        # .env 以 JSON 写, 含逗号名完整保留
        content = env_file.read_text()
        assert "SYNC_FOLDERS" in content and "&W,mL3VOGU,KLsF9V-" in content

    def test_put_whitelist_gated_on_applescript(self, folder_client, monkeypatch):
        folder_client._cfg.mailagent_backend = "applescript"
        r = folder_client.put("/api/folder/whitelist", json={"folders": ["Jira"]})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "E_INVALID_ARG"
