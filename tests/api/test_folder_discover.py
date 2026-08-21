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
    # discover 有 60s TTL 进程内缓存 (模块级单例) —— 每个 case 前清空, 否则上一个
    # case 的 folders 会跨 case 串味 (spy 类断言尤其会被缓存吃掉)。
    from src.api.routers.folder import _reset_discover_cache

    _reset_discover_cache()
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

    def test_discover_default_skips_counts(self, folder_client, monkeypatch):
        """issue #45: 默认不取 message_count (大邮箱逐文件夹 STATUS 分钟级)。"""
        captured = {}

        def _spy(c, with_counts=True):
            captured["with_counts"] = with_counts
            return _fake_folders()

        monkeypatch.setattr("src.mail.backend.imap_client.list_folders", _spy)
        r = folder_client.get("/api/folder/discover")
        assert r.status_code == 200, r.text
        assert captured["with_counts"] is False

    def test_discover_counts_true_opts_in(self, folder_client, monkeypatch):
        """``?counts=true`` 仍可显式取 message_count (opt-in)。"""
        captured = {}

        def _spy(c, with_counts=True):
            captured["with_counts"] = with_counts
            return _fake_folders()

        monkeypatch.setattr("src.mail.backend.imap_client.list_folders", _spy)
        r = folder_client.get("/api/folder/discover", params={"counts": "true"})
        assert r.status_code == 200, r.text
        assert captured["with_counts"] is True


class TestDiscoverTtlCache:
    """task 08-20-perf-shell-prefetch-sidebar §③ — discover 的 60s TTL 进程内缓存。"""

    def _spy(self, monkeypatch):
        calls = {"n": 0}

        def _fake(c, with_counts=True):
            calls["n"] += 1
            return _fake_folders()

        monkeypatch.setattr("src.mail.backend.imap_client.list_folders", _fake)
        return calls

    def test_second_call_within_ttl_hits_cache(self, folder_client, monkeypatch):
        """TTL 内第二次调用不真连 IMAP (变异验证: 去掉缓存则 n==2 → 红)。"""
        calls = self._spy(monkeypatch)
        assert folder_client.get("/api/folder/discover").status_code == 200
        assert folder_client.get("/api/folder/discover").status_code == 200
        assert calls["n"] == 1

    def test_refresh_true_bypasses_cache(self, folder_client, monkeypatch):
        """?refresh=true 穿透缓存真连 IMAP, 并回填缓存供后续命中。"""
        calls = self._spy(monkeypatch)
        folder_client.get("/api/folder/discover")
        folder_client.get("/api/folder/discover", params={"refresh": "true"})
        assert calls["n"] == 2
        # refresh 回填 → 紧随其后的普通调用命中新缓存
        folder_client.get("/api/folder/discover")
        assert calls["n"] == 2

    def test_cache_key_includes_counts(self, folder_client, monkeypatch):
        """counts=true/false 两种负载不同形, 各自独立缓存。"""
        calls = self._spy(monkeypatch)
        folder_client.get("/api/folder/discover")
        folder_client.get("/api/folder/discover", params={"counts": "true"})
        assert calls["n"] == 2

    def test_ttl_expiry_refetches(self, folder_client, monkeypatch):
        """过 TTL 后再调用重新真连 (monotonic 时钟前拨模拟)。"""
        calls = self._spy(monkeypatch)
        folder_client.get("/api/folder/discover")
        import src.api.routers.folder as folder_mod

        real_monotonic = folder_mod.time.monotonic
        monkeypatch.setattr(
            folder_mod.time, "monotonic", lambda: real_monotonic() + 61.0
        )
        folder_client.get("/api/folder/discover")
        assert calls["n"] == 2

    def test_cached_response_still_recomputes_whitelist(self, folder_client):
        """只缓存 list_folders 原始结果 —— is_synced/whitelist 每请求现算, 白名单
        改动不吃 TTL (否则设置页勾选后 Sidebar 最多滞后 60s)。"""
        folder_client._cfg.sync_folders = ""
        r1 = folder_client.get("/api/folder/discover")
        assert r1.json()["data"]["whitelist"] == []
        folder_client._cfg.sync_folders = '["Jira"]'
        r2 = folder_client.get("/api/folder/discover")  # 命中缓存 (同 counts key)
        data = r2.json()["data"]
        assert data["whitelist"] == ["Jira"]
        jira = next(f for f in data["folders"] if f["imap_name"] == "Jira")
        assert jira["is_synced"] is True

    def test_error_not_cached(self, folder_client, monkeypatch):
        """失败不缓存 —— 下一次调用重试真连而不是 60s 内一直回错。"""
        state = {"n": 0}

        def _flaky(c, with_counts=True):
            state["n"] += 1
            if state["n"] == 1:
                raise ConnectionError("imap down")
            return _fake_folders()

        monkeypatch.setattr("src.mail.backend.imap_client.list_folders", _flaky)
        r1 = folder_client.get("/api/folder/discover")
        assert r1.status_code in (500, 502) or r1.json().get("error")
        r2 = folder_client.get("/api/folder/discover")
        assert r2.status_code == 200, r2.text
        assert state["n"] == 2


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

    def test_discover_whitelist_preserves_custom_order(self, folder_client):
        """排序 task: discover 的 whitelist 保 SYNC_FOLDERS 原序 (= 用户自定义显示顺序),
        不得 sorted() 重排成字母序。"""
        # 故意用非字母序 ("Jira" < "DMS..." 为假; 字母序应为 DMS... 在前)
        folder_client._cfg.sync_folders = '["Jira","DMS&VvpO9lPRXgM-"]'
        r = folder_client.get("/api/folder/discover")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["whitelist"] == ["Jira", "DMS&VvpO9lPRXgM-"]

    def test_put_whitelist_order_only_change_no_restart(
        self, folder_client, tmp_path, monkeypatch
    ):
        """排序 task: 仅顺序变化 (集合相等) → restart_required=False (watcher 消费是
        集合语义, 调序只影响显示), 但新序照常写入 .env。"""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "MAILAGENT_BACKEND=davmail\nSYNC_FOLDERS='[\"Notion\",\"Jira\"]'\n"
        )
        monkeypatch.setattr("src.config._resolve_env_file", lambda: str(env_file))
        r = folder_client.put(
            "/api/folder/whitelist", json={"folders": ["Jira", "Notion"]}
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["folders"] == ["Jira", "Notion"]
        assert data["restart_required"] is False
        # 新序已落 .env (GET 热读反映)
        r2 = folder_client.get("/api/folder/whitelist")
        assert r2.json()["data"]["folders"] == ["Jira", "Notion"]

    def test_put_whitelist_set_change_requires_restart(
        self, folder_client, tmp_path, monkeypatch
    ):
        """排序 task: 集合变化 (增/删项) → restart_required=True (行为同现状)。"""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "MAILAGENT_BACKEND=davmail\nSYNC_FOLDERS='[\"Notion\"]'\n"
        )
        monkeypatch.setattr("src.config._resolve_env_file", lambda: str(env_file))
        r = folder_client.put(
            "/api/folder/whitelist", json={"folders": ["Notion", "Jira"]}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["restart_required"] is True

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


class TestPrefs:
    """v62 per-folder 配置端点 (GET/PUT /api/folder/prefs)。"""

    @pytest.fixture()
    def prefs_client(self, folder_client, monkeypatch, tmp_path):
        """把端点用的 ServiceContext 指到一条真 SQLite —— prefs 是纯本地读写, 不 mock 存储层。"""
        from src.mail.sync_store import SyncStore

        store = SyncStore(str(tmp_path / "prefs.db"))

        class _Ctx:
            sync_store = store

        monkeypatch.setattr("src.api.deps.get_service_ctx", lambda: _Ctx())
        folder_client._store = store  # type: ignore[attr-defined]
        return folder_client

    def test_get_prefs_empty(self, prefs_client):
        r = prefs_client.get("/api/folder/prefs")
        assert r.status_code == 200, r.text
        assert r.json()["data"]["prefs"] == []

    def test_put_creates_then_partially_updates(self, prefs_client):
        r = prefs_client.put(
            "/api/folder/prefs",
            json={"imap_name": "DMS&VvpO9lPRXgM-", "icon": "folder-check", "notify_enabled": True},
        )
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data["imap_name"] == "DMS&VvpO9lPRXgM-"
        assert data["mailbox_label"] == "DMS固件发布"   # 派生列由后端算, 不收前端的
        assert data["icon"] == "folder-check"
        assert data["notify_enabled"] is True
        assert data["llm_disabled"] is False

        # 只传 llm_disabled → icon / notify 保持原值 (部分更新)。
        r = prefs_client.put(
            "/api/folder/prefs", json={"imap_name": "DMS&VvpO9lPRXgM-", "llm_disabled": True}
        )
        data = r.json()["data"]
        assert data["icon"] == "folder-check"
        assert data["notify_enabled"] is True
        assert data["llm_disabled"] is True

    def test_put_icon_null_clears_but_omitted_keeps(self, prefs_client):
        """🔴 "传了 null" 与 "没传" 必须分得开: 前者清除图标, 后者保持不变。"""
        prefs_client.put("/api/folder/prefs", json={"imap_name": "Teams", "icon": "folder-sync"})

        prefs_client.put("/api/folder/prefs", json={"imap_name": "Teams", "notify_enabled": True})
        assert prefs_client.get("/api/folder/prefs").json()["data"]["prefs"][0]["icon"] == "folder-sync"

        prefs_client.put("/api/folder/prefs", json={"imap_name": "Teams", "icon": None})
        assert prefs_client.get("/api/folder/prefs").json()["data"]["prefs"][0]["icon"] is None

    def test_put_accepts_unknown_icon_string(self, prefs_client):
        """icon 是**不透明短串**: 后端不做枚举校验 (可选集是纯前端词汇, 抄过来就多一处镜像)。"""
        r = prefs_client.put(
            "/api/folder/prefs", json={"imap_name": "Teams", "icon": "not-a-real-lucide-name"}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["icon"] == "not-a-real-lucide-name"

    def test_put_rejects_empty_imap_name_and_overlong_icon(self, prefs_client):
        r = prefs_client.put("/api/folder/prefs", json={"imap_name": "  "})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "E_INVALID_ARG"

        r = prefs_client.put("/api/folder/prefs", json={"imap_name": "Teams", "icon": "x" * 65})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "E_INVALID_ARG"

    def test_prefs_not_gated_on_davmail(self, prefs_client):
        """纯本地 SQLite 读写 (同 /cleanup 的口径) —— 配置读写不该被后端探活挡住。"""
        prefs_client._cfg.mailagent_backend = "applescript"
        assert prefs_client.get("/api/folder/prefs").status_code == 200
        r = prefs_client.put("/api/folder/prefs", json={"imap_name": "Teams", "notify_enabled": True})
        assert r.status_code == 200, r.text
