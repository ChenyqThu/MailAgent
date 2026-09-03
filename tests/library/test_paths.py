"""多根路径 jail（``src/library/paths.py``）。

覆盖 design §3 / §8.2 的路径校验：穿越 / 绝对 / NUL / symlink（根外与根内）/ NFD 同名 /
大小写同名 / 挂载内后缀与 ``.git`` 拒收 / ``.`` 开头保留 / 写目标文件名 sanitize / 虚拟路径拆合。
"""

from __future__ import annotations

import os
import stat
import unicodedata

import pytest

from src.library import paths
from src.library.paths import MountRoot, PathError


@pytest.fixture()
def root(tmp_path) -> MountRoot:
    d = tmp_path / "library"
    (d / "my-docs").mkdir(parents=True)
    return MountRoot(id=0, label="", abs_path=os.path.realpath(str(d)), mode="rw")


@pytest.fixture()
def mount(tmp_path) -> MountRoot:
    d = tmp_path / "workspace"
    d.mkdir()
    return MountRoot(id=7, label="work", abs_path=os.path.realpath(str(d)), mode="rw")


# ── normalize_rel ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "bad",
    ["../x.md", "my-docs/../../etc/passwd", "/etc/passwd", "my-docs/\x00evil.md", "a/../../b"],
)
def test_normalize_rejects_traversal_absolute_nul(bad: str) -> None:
    with pytest.raises(PathError):
        paths.normalize_rel(bad)


def test_normalize_collapses_dot_segments_and_slashes() -> None:
    assert paths.normalize_rel("./my-docs//./a.md/") == "my-docs/a.md"
    assert paths.normalize_rel("") == ""


def test_dot_prefixed_segments_are_kept_not_special_cased() -> None:
    """``.hidden/x.md`` 不是穿越也不是保留名 —— 原样保留（design §3「`.` 开头保留」）。"""
    assert paths.normalize_rel(".hidden/x.md") == ".hidden/x.md"


def test_rel_key_is_nfc_plus_casefold() -> None:
    nfd = unicodedata.normalize("NFD", "my-docs/café.md")
    nfc = unicodedata.normalize("NFC", "my-docs/café.md")
    assert nfd != nfc  # 前提：带组合字符的名字在 NFD / NFC 下确实不同（Finder 拖入的是 NFD）
    assert paths.rel_key_of(nfd) == paths.rel_key_of(nfc)
    assert paths.rel_key_of("My-Docs/Report.MD") == paths.rel_key_of("my-docs/report.md")


# ── resolve ────────────────────────────────────────────────────────────────────


def test_resolve_inside_root(root: MountRoot) -> None:
    r = paths.resolve(root, "my-docs/a.md")
    assert r.abs_path == os.path.join(root.abs_path, "my-docs", "a.md")
    assert r.rel_path == "my-docs/a.md"
    assert r.parent_path == "my-docs"
    assert r.filename == "a.md"
    assert r.virtual_path == "my-docs/a.md"


def test_resolve_symlink_pointing_outside_root_is_rejected(root: MountRoot, tmp_path) -> None:
    outside = tmp_path / "outside.md"
    outside.write_text("secret")
    os.symlink(str(outside), os.path.join(root.abs_path, "my-docs", "link.md"))
    with pytest.raises(PathError):
        paths.resolve(root, "my-docs/link.md")


def test_resolve_symlink_dir_pointing_outside_root_is_rejected(root: MountRoot, tmp_path) -> None:
    outside_dir = tmp_path / "outside-dir"
    outside_dir.mkdir()
    (outside_dir / "x.md").write_text("x")
    os.symlink(str(outside_dir), os.path.join(root.abs_path, "my-docs", "linkdir"))
    with pytest.raises(PathError):
        paths.resolve(root, "my-docs/linkdir/x.md")


def test_resolve_symlink_inside_root_is_rejected_too(root: MountRoot) -> None:
    """P1 纪律：任何 symlink 成分一律拒（根内指向也拒），jail 只认真实路径。"""
    real = os.path.join(root.abs_path, "my-docs", "real.md")
    with open(real, "w") as f:
        f.write("x")
    os.symlink(real, os.path.join(root.abs_path, "my-docs", "alias.md"))
    with pytest.raises(PathError):
        paths.resolve(root, "my-docs/alias.md")
    # 真路径照常可解析
    assert paths.resolve(root, "my-docs/real.md").abs_path == real


def test_resolve_for_write_sanitizes_last_segment(root: MountRoot) -> None:
    r = paths.resolve(root, 'my-docs/bad:name?.md', for_write=True)
    assert r.filename == "bad_name_.md"
    assert r.rel_path == "my-docs/bad_name_.md"


def test_resolve_mount_denies_suffixes_and_git(mount: MountRoot) -> None:
    for rel in ("notes/.env", "notes/.env.local", "keys/id.pem", "keys/host.key", "db/app.db", "app.DB"):
        with pytest.raises(PathError) as exc_info:
            paths.resolve(mount, rel)
        assert exc_info.value.code == "E_AUTH_FAILED", rel
    with pytest.raises(PathError):
        paths.resolve(mount, ".git/config")
    with pytest.raises(PathError):
        paths.resolve(mount, "sub/.git/HEAD")
    # 同名后缀在**库根**不额外拒（那是 exec 地板的事）
    paths.resolve(MountRoot(id=0, label="", abs_path=mount.abs_path, mode="rw"), "my-docs/x.db")


# ── open_read / open_write（O_NOFOLLOW + fstat 复核）────────────────────────────


def test_open_read_rejects_directory_and_symlink(root: MountRoot) -> None:
    r = paths.resolve(root, "my-docs")
    with pytest.raises(PathError):
        paths.open_read(r)
    target = os.path.join(root.abs_path, "my-docs", "t.md")
    with open(target, "w") as f:
        f.write("hello")
    r_ok = paths.resolve(root, "my-docs/t.md")
    # resolve 之后、open 之前把真文件换成 symlink（TOCTOU）→ O_NOFOLLOW 拦住
    os.unlink(target)
    os.symlink("/etc/hosts", target)
    with pytest.raises(PathError):
        paths.open_read(r_ok)


def test_open_write_modes(root: MountRoot) -> None:
    r = paths.resolve(root, "my-docs/new/w.md", for_write=True)
    fd = paths.open_write(r, "create_new")
    os.write(fd, b"one")
    os.close(fd)
    with pytest.raises(PathError):
        paths.open_write(r, "create_new")  # 已存在
    fd = paths.open_write(r, "append")
    os.write(fd, b"two")
    os.close(fd)
    assert open(r.abs_path, "rb").read() == b"onetwo"
    fd = paths.open_write(r, "overwrite")
    os.write(fd, b"x")
    os.close(fd)
    assert open(r.abs_path, "rb").read() == b"x"
    assert stat.S_ISREG(os.stat(r.abs_path).st_mode)


# ── 虚拟路径 ───────────────────────────────────────────────────────────────────


def test_split_and_join_virtual(mount: MountRoot, root: MountRoot) -> None:
    assert paths.split_virtual("@work/notes/a.md") == ("work", "notes/a.md")
    assert paths.split_virtual("@work") == ("work", "")
    assert paths.split_virtual("my-docs/a.md") == (None, "my-docs/a.md")
    assert paths.join_virtual(mount, "notes/a.md") == "@work/notes/a.md"
    assert paths.join_virtual(mount, "") == "@work"
    assert paths.join_virtual(root, "my-docs/a.md") == "my-docs/a.md"
    with pytest.raises(PathError):
        paths.split_virtual("@")  # 空 label
