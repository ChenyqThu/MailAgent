"""exec 地板的资料库规则（design §1.2）：``library.db``（含 wal / shm / journal）deny；``data/library/**`` 放行；
库目录下 ``.db / .key / .env* / .pem`` 后缀一律 deny。经 ``/api/exec/file_read`` 端到端各验一条。"""

from __future__ import annotations

import os

import pytest

from src.api import exec_floor


@pytest.fixture()
def floor(tmp_path, monkeypatch):
    data_root = tmp_path / "root"
    (data_root / "data" / "library" / "my-docs").mkdir(parents=True)
    monkeypatch.setenv("MAILAGENT_DATA_ROOT", str(data_root))
    # 三库路径经 config 单例解析（import 期固定）；把 sync_store 的解析钉到 tmp，library.db / 库根随它推导。
    monkeypatch.setattr(exec_floor, "_sync_store_db", lambda _root: str(data_root / "data" / "sync_store.db"))
    exec_floor.reset_exec_floor_cache()
    yield exec_floor.get_exec_floor(), data_root
    exec_floor.reset_exec_floor_cache()


def _rp(path) -> str:
    return os.path.realpath(str(path))


def test_library_db_and_sidecars_are_denied(floor):
    fl, root = floor
    for suffix in ("", "-wal", "-shm", "-journal"):
        assert fl.path_reason(_rp(root / "data" / f"library.db{suffix}")) == "sensitive file", suffix


def test_library_dir_is_allowed_but_secret_suffixes_are_denied(floor):
    fl, root = floor
    lib = root / "data" / "library"
    note = lib / "my-docs" / "note.md"
    note.write_text("hello")
    assert fl.path_reason(_rp(note)) is None
    assert fl.path_reason(_rp(lib / "agent-docs" / "report.html")) is None
    for name in ("cache.db", "id.key", "cert.pem", ".env", ".env.local", "UPPER.DB"):
        assert fl.path_reason(_rp(lib / "my-docs" / name)) == "sensitive suffix in library", name
    # 库目录之外的同名后缀不归这条规则管（.env 由 DATA_ROOT/.env 精确规则管，其余不拒）
    assert fl.path_reason(_rp(root / "work" / "cache.db")) is None


def test_file_read_endpoint_enforces_library_rules(client, floor):
    _, root = floor
    lib = root / "data" / "library"
    (root / "data" / "library.db").write_bytes(b"SQLite format 3\x00")
    (lib / "my-docs" / "note.md").write_text("hello")
    (lib / "my-docs" / "secret.key").write_text("k")

    r = client.post("/api/exec/file_read", json={"path": str(root / "data" / "library.db")})
    assert r.status_code == 403 and r.json()["error"]["code"] == "E_EXEC_FLOOR_DENIED"
    r = client.post("/api/exec/file_read", json={"path": str(lib / "my-docs" / "secret.key")})
    assert r.status_code == 403 and r.json()["error"]["code"] == "E_EXEC_FLOOR_DENIED"
    r = client.post("/api/exec/file_read", json={"path": str(lib / "my-docs" / "note.md")})
    assert r.status_code == 200 and r.json()["data"]["content"] == "hello"
