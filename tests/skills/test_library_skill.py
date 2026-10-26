"""library skill（对外资料库只读）—— 字段白名单 / 正文围栏 / limit 与 max_chars 越界拒 /
不存在的 id → E_NOT_FOUND / 回收站三个工具都拒 / 复用路由单例不新建 LibraryService。
"""

from __future__ import annotations

import os
from types import SimpleNamespace

import pytest

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.library.service import LibraryService  # noqa: E402
from src.skills.builtin import library as library_skill  # noqa: E402
from src.skills.builtin._common import api_router  # noqa: E402
from src.skills.context import SkillContext  # noqa: E402
from src.skills.errors import SkillError  # noqa: E402

ROW_FIELDS = {"file_id", "path", "name", "size", "mime", "updated_at", "source", "content_hash",
              "kind", "text_status", "status"}
READ_EXTRA = {"content", "extractor", "truncated", "stale", "hint"}


@pytest.fixture
def env(tmp_path, monkeypatch):
    svc = LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"), None)
    monkeypatch.setattr(api_router("library"), "get_library_service", lambda: svc)
    keep = svc.create_file("my-docs/atlas.md", "# Atlas plan\nrollout notes for Atlas".encode())
    gone = svc.create_file("my-docs/secret-plan.md", "# Secret\nquarterly zephyr budget".encode())
    svc.trash_file(int(gone["id"]))
    ctx = SkillContext(config=SimpleNamespace(sync_store_db_path=str(tmp_path / "sync.db")))
    return SimpleNamespace(ctx=ctx, svc=svc, keep=int(keep["id"]), gone=int(gone["id"]))


def _call(tool: str, ctx, **params):
    handler = {
        "library_list": library_skill._library_list,
        "library_search": library_skill._library_search,
        "library_read": library_skill._library_read,
    }[tool]
    return handler(ctx, params)


def test_context_reuses_router_singleton(env, monkeypatch):
    def _no_second_instance(*_a, **_kw):
        raise AssertionError("SkillContext built a second LibraryService")

    monkeypatch.setattr(LibraryService, "__init__", _no_second_instance)
    assert env.ctx.library_service() is env.svc
    assert _call("library_list", env.ctx, path="my-docs")["file_count"] == 1


def test_list_folder_projection(env):
    data = _call("library_list", env.ctx, path="my-docs")
    assert data["path"] == "my-docs" and data["total"] == 1 and data["has_more"] is False
    row = data["files"][0]
    assert set(row) == ROW_FIELDS
    assert row["file_id"] == env.keep and row["path"] == "my-docs/atlas.md"
    assert env.svc.root_path not in str(data)


def test_list_root_hides_trash(env):
    data = _call("library_list", env.ctx)
    names = {f["path"] for f in data["folders"]}
    assert ".trash" not in names
    assert {"my-docs", "agent-docs", "mail-attachments"} <= names


@pytest.mark.parametrize("path", [".trash", ".trash/", "./.trash"])
def test_list_trash_rejected(env, path):
    with pytest.raises(SkillError) as ei:
        _call("library_list", env.ctx, path=path)
    assert ei.value.code == "E_NOT_FOUND"


@pytest.mark.parametrize("limit", [0, 201])
def test_list_limit_out_of_range_rejected(env, limit):
    with pytest.raises(SkillError) as ei:
        _call("library_list", env.ctx, limit=limit)
    assert ei.value.code == "E_INVALID_ARG"


def test_search_hits_are_fenced_and_skip_trash(env):
    data = _call("library_search", env.ctx, q="Atlas")
    assert data["count"] == 1
    hit = data["items"][0]
    assert set(hit) == ROW_FIELDS | {"match", "snippet"}
    assert hit["snippet"].startswith(f"UNTRUSTED_LIBRARY_FILE_START file_id={env.keep} part=snippet")
    # 回收站里的文件搜不到
    assert _call("library_search", env.ctx, q="zephyr")["count"] == 0


@pytest.mark.parametrize("limit", [0, 51])
def test_search_limit_out_of_range_rejected(env, limit):
    with pytest.raises(SkillError) as ei:
        _call("library_search", env.ctx, q="Atlas", limit=limit)
    assert ei.value.code == "E_INVALID_ARG"


def test_read_text_file_fenced(env):
    data = _call("library_read", env.ctx, file_id=env.keep)
    assert set(data) == ROW_FIELDS | READ_EXTRA
    assert data["extractor"] == "native" and data["truncated"] is False
    assert data["content"].startswith(f"UNTRUSTED_LIBRARY_FILE_START file_id={env.keep} part=content\n")
    assert "rollout notes for Atlas" in data["content"]


def test_read_truncates_at_max_chars(env):
    env.svc.create_file("my-docs/long.md", ("x" * 500).encode())
    file_id = _call("library_list", env.ctx, path="my-docs")["files"]
    long_id = next(f["file_id"] for f in file_id if f["name"] == "long.md")
    data = _call("library_read", env.ctx, file_id=long_id, max_chars=200)
    assert data["truncated"] is True and "x" * 201 not in data["content"]


def test_read_trashed_file_rejected(env):
    with pytest.raises(SkillError) as ei:
        _call("library_read", env.ctx, file_id=env.gone)
    assert ei.value.code == "E_NOT_FOUND"


def test_read_unknown_file_is_not_found(env):
    with pytest.raises(SkillError) as ei:
        _call("library_read", env.ctx, file_id=999999)
    assert ei.value.code == "E_NOT_FOUND" and ei.value.http_status == 404


@pytest.mark.parametrize(
    "params",
    [{}, {"file_id": 1, "attachment_id": 2}, {"file_id": 1, "max_chars": 199}, {"file_id": 1, "max_chars": 12001}],
)
def test_read_bad_args_rejected(env, params):
    with pytest.raises(SkillError) as ei:
        _call("library_read", env.ctx, **params)
    assert ei.value.code == "E_INVALID_ARG"


@pytest.mark.parametrize(
    "path", [".TRASH", ".Trash/1", "my-docs/../.trash", "/.trash", "\\.trash", ".trash/1/secret-plan.md"]
)
def test_list_trash_variants_never_list_trashed_files(env, path):
    # 大小写 / 穿越 / 绝对路径 / 反斜杠 / 直指回收站子目录：要么拒，要么不是回收站视图。
    with pytest.raises(SkillError) as ei:
        _call("library_list", env.ctx, path=path)
    assert ei.value.code in {"E_NOT_FOUND", "E_INVALID_ARG"}


def test_list_symlink_into_trash_rejected(env):
    os.symlink(os.path.join(env.svc.root_path, ".trash"), os.path.join(env.svc.root_path, "my-docs", "t"))
    listed = _call("library_list", env.ctx, path="my-docs")
    assert "secret-plan" not in str(listed)
    with pytest.raises(SkillError):
        _call("library_list", env.ctx, path="my-docs/t")


def test_library_tools_run_off_the_event_loop():
    # 搜索可能首次加载语义模型、读 pending 文件会就地抽取（含 OCR）——不放线程池就卡住整个 serve-api。
    assert all(tool.blocking for tool in library_skill.build_skill().tools)
