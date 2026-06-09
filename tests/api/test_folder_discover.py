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


# ============================================================
# P4: 文件夹管理 CRUD (POST/PATCH/DELETE /api/folder/manage)
# ============================================================

class TestFolderManage:
    def test_create(self, folder_client, monkeypatch):
        from src.services.mail_write import FolderMutationResult, MailWriteService

        monkeypatch.setattr(
            MailWriteService, "create_folder",
            lambda self, parent, name, *, actor: FolderMutationResult(action="create", imap_name=f"{parent}/X" if parent else "X"),
        )
        r = folder_client.post("/api/folder/manage", json={"parent": "Proj", "name": "新"})
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["action"] == "create" and data["imap_name"] == "Proj/X"

    def test_rename(self, folder_client, monkeypatch):
        from src.services.mail_write import FolderMutationResult, MailWriteService

        monkeypatch.setattr(
            MailWriteService, "rename_folder",
            lambda self, imap_name, new_name, *, actor: FolderMutationResult(
                action="rename", imap_name=imap_name, new_imap_name="项目enc",
                affected_local_rows=3, restart_required=True,
            ),
        )
        r = folder_client.patch("/api/folder/manage", json={"imap_name": "Jira", "new_name": "项目"})
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["action"] == "rename" and data["affected_local_rows"] == 3
        # review#2: 改白名单内文件夹 → restart_required 透传给前端 banner
        assert data["restart_required"] is True

    def test_delete(self, folder_client, monkeypatch):
        from src.services.mail_write import FolderMutationResult, MailWriteService

        monkeypatch.setattr(
            MailWriteService, "delete_folder",
            lambda self, imap_name, *, actor: FolderMutationResult(action="delete", imap_name=imap_name, affected_local_rows=5),
        )
        r = folder_client.request("DELETE", "/api/folder/manage", json={"imap_name": "Jira"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["affected_local_rows"] == 5

    def test_rename_system_rejected(self, folder_client, monkeypatch):
        from src.services.errors import ServiceInvalidArgError
        from src.services.mail_write import MailWriteService

        def _raise(self, imap_name, new_name, *, actor):
            raise ServiceInvalidArgError("Sent 是系统文件夹, 不可重命名/删除")

        monkeypatch.setattr(MailWriteService, "rename_folder", _raise)
        r = folder_client.patch("/api/folder/manage", json={"imap_name": "Sent", "new_name": "x"})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "E_INVALID_ARG"

    def test_create_gated_applescript(self, folder_client):
        folder_client._cfg.mailagent_backend = "applescript"
        r = folder_client.post("/api/folder/manage", json={"parent": "", "name": "X"})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "E_INVALID_ARG"


    def test_cleanup(self, folder_client, monkeypatch):
        from src.services.mail_write import FolderMutationResult, MailWriteService

        monkeypatch.setattr(
            MailWriteService, "cleanup_local_folder",
            lambda self, imap_name, *, actor: FolderMutationResult(
                action="cleanup", imap_name=imap_name, affected_local_rows=7, restart_required=True
            ),
        )
        r = folder_client.post("/api/folder/cleanup", json={"imap_name": "Jira"})
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["action"] == "cleanup" and data["affected_local_rows"] == 7
        assert data["restart_required"] is True
