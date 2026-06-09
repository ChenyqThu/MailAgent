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
def folder_client(monkeypatch, tmp_path) -> Iterator[TestClient]:
    cfg = _StubConfig()
    app.dependency_overrides[get_settings] = lambda: cfg
    monkeypatch.setattr(
        "src.mail.backend.imap_client.list_folders",
        lambda c, with_counts=True: _fake_folders(),
    )
    # 隔离 env 文件: _current_whitelist 现热读 .env (Bug A 修复)。默认指向一个无
    # SYNC_FOLDERS 的临时文件 → 热读 fallthrough 到 cfg 路径 (cfg.sync_folders 仍是
    # 这些 cfg-based 测试的真源), 不被 host 真实 .env 的 SYNC_FOLDERS 污染 (hermetic)。
    _env = tmp_path / "isolated.env"
    _env.write_text("MAILAGENT_BACKEND=davmail\n")
    monkeypatch.setattr("src.config._resolve_env_file", lambda: str(_env))
    with TestClient(app, raise_server_exceptions=False) as c:
        c._cfg = cfg  # type: ignore[attr-defined]
        c._env_file = _env  # type: ignore[attr-defined]
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

    def test_get_whitelist_hot_reads_env_over_stale_singleton(self, folder_client):
        """Bug A: GET /whitelist 热读 .env, 不读 import-time Config 单例的陈旧值.

        serve-api 常驻进程 → 启动后写入的 SYNC_FOLDERS 必须立即反映 (否则 UI 勾选丢失)。
        模拟: cfg 单例还是旧空值, 但 .env 已被写入新白名单 → 端点反映文件值。
        """
        # 单例 (cfg) 停留在旧值 (空 = 启动时未配)
        folder_client._cfg.sync_folders = ""
        # .env 文件被运行时写入新白名单 (含逗号的 modified-UTF7 名也要完整解析)
        folder_client._env_file.write_text(
            'MAILAGENT_BACKEND=davmail\n'
            'SYNC_FOLDERS=\'["DMS&VvpO9lPRXgM-","&W,mL3VOGU,KLsF9V-"]\'\n'
        )
        r = folder_client.get("/api/folder/whitelist")
        assert r.status_code == 200, r.text
        # 反映文件值, 而非陈旧单例的空值
        assert r.json()["data"]["folders"] == ["DMS&VvpO9lPRXgM-", "&W,mL3VOGU,KLsF9V-"]

    def test_get_whitelist_empty_env_key_respects_cleared(self, folder_client):
        """Bug A: .env 显式写空数组 (用户清空白名单) → 尊重为空, 不退回单例旧值."""
        folder_client._cfg.sync_folders = '["Jira"]'  # 单例旧值
        folder_client._env_file.write_text(
            'MAILAGENT_BACKEND=davmail\nSYNC_FOLDERS=\'[]\'\n'
        )
        r = folder_client.get("/api/folder/whitelist")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["folders"] == []  # 文件的空数组优先于单例

    def test_get_whitelist_falls_back_to_cfg_when_env_missing_key(self, folder_client):
        """Bug A: .env 无 SYNC_FOLDERS key → fallback 现有 cfg 路径 (dev/test 兼容)."""
        folder_client._cfg.sync_folders = '["Notion"]'
        # fixture 的隔离 .env 默认无 SYNC_FOLDERS key
        r = folder_client.get("/api/folder/whitelist")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["folders"] == ["Notion"]  # 走 cfg 路径

    def test_discover_is_synced_hot_reads_env(self, folder_client):
        """Bug A: discover 的 is_synced 同样热读 .env (Sidebar 树出现的依据)."""
        folder_client._cfg.sync_folders = ""  # 单例陈旧空
        folder_client._env_file.write_text(
            'MAILAGENT_BACKEND=davmail\nSYNC_FOLDERS=\'["DMS&VvpO9lPRXgM-"]\'\n'
        )
        r = folder_client.get("/api/folder/discover")
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        dms = next(f for f in data["folders"] if f["imap_name"] == "DMS&VvpO9lPRXgM-")
        assert dms["is_synced"] is True
        assert data["whitelist"] == ["DMS&VvpO9lPRXgM-"]

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

    def test_put_whitelist_syncs_singleton_and_get_round_trips(
        self, folder_client, tmp_path, monkeypatch
    ):
        """Bug A: PUT 写 .env 后, ① 同进程单例 cfg.sync_folders 同步更新; ② GET 立即反映
        (热读 .env), 无需重启 serve-api。"""
        env_file = tmp_path / ".env"
        env_file.write_text("MAILAGENT_BACKEND=davmail\n")
        monkeypatch.setattr("src.config._resolve_env_file", lambda: str(env_file))
        folder_client._cfg.sync_folders = ""  # 启动时空
        r = folder_client.put(
            "/api/folder/whitelist", json={"folders": ["DMS&VvpO9lPRXgM-"]}
        )
        assert r.status_code == 200, r.text
        # ① 单例被同步更新为新值
        assert folder_client._cfg.sync_folders == '["DMS&VvpO9lPRXgM-"]'
        # ② GET 立即反映 (热读 .env)
        r2 = folder_client.get("/api/folder/whitelist")
        assert r2.json()["data"]["folders"] == ["DMS&VvpO9lPRXgM-"]

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
