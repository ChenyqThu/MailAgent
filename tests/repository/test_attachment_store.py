"""AttachmentStore 单测（v4 架构）.

覆盖:
    - 路径生成 / 文件名 sanitize
    - 落盘 / 读盘 / 去重后缀
    - delete_email_dir CASCADE
    - find_orphan_dirs
    - sha256 计算
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from src.repository.attachment_store import AttachmentStore


@pytest.fixture
def store(tmp_path: Path) -> AttachmentStore:
    return AttachmentStore(tmp_path / "attachments")


# ============================================================
# sanitize_filename
# ============================================================

class TestSanitizeFilename:
    def test_empty(self):
        assert AttachmentStore.sanitize_filename("") == "unnamed"
        assert AttachmentStore.sanitize_filename("   ") == "unnamed"

    def test_traversal(self):
        # 路径分隔符必须被替换
        assert "/" not in AttachmentStore.sanitize_filename("../etc/passwd")
        assert "\\" not in AttachmentStore.sanitize_filename("..\\..\\etc")

    def test_dotdot(self):
        assert AttachmentStore.sanitize_filename(".") == "unnamed"
        assert AttachmentStore.sanitize_filename("..") == "unnamed"

    def test_control_chars(self):
        # NUL + 控制字符
        assert "\x00" not in AttachmentStore.sanitize_filename("ev\x00il.txt")
        assert AttachmentStore.sanitize_filename("ev\x00il.txt").endswith(".txt")

    def test_unsafe_chars(self):
        # < > : " | ? * 都是 fs 保留
        out = AttachmentStore.sanitize_filename('a<b>c:d"e|f?g*.txt')
        for ch in '<>:"|?*':
            assert ch not in out
        assert out.endswith(".txt")

    def test_unicode_ok(self):
        # 中文 / unicode 不动
        assert AttachmentStore.sanitize_filename("报告.docx") == "报告.docx"

    def test_length_cap(self):
        long_name = "x" * 300 + ".pdf"
        out = AttachmentStore.sanitize_filename(long_name)
        assert len(out) <= 200
        assert out.endswith(".pdf")


# ============================================================
# save / read
# ============================================================

class TestSaveRead:
    def test_save_and_read(self, store: AttachmentStore):
        target, used = store.save(123, "hello.txt", b"hello world")
        assert target.exists()
        assert target.read_bytes() == b"hello world"
        assert used == "hello.txt"

    def test_dedup_within_email(self, store: AttachmentStore):
        # 同邮件内同名 → 加 _1 _2 后缀
        _, n1 = store.save(123, "a.txt", b"v1")
        _, n2 = store.save(123, "a.txt", b"v2")
        _, n3 = store.save(123, "a.txt", b"v3")
        assert n1 == "a.txt"
        assert n2 == "a_1.txt"
        assert n3 == "a_2.txt"

    def test_dir_per_email(self, store: AttachmentStore):
        # 不同 internal_id 独立目录
        store.save(1, "x.txt", b"1")
        store.save(2, "x.txt", b"2")
        assert (store.dir_for(1) / "x.txt").read_bytes() == b"1"
        assert (store.dir_for(2) / "x.txt").read_bytes() == b"2"

    def test_relative_path_format(self, store: AttachmentStore):
        rel = store.relative_path(99, "logo.png")
        assert rel.endswith("/99/logo.png")

    def test_read_by_relative_path(self, store: AttachmentStore, tmp_path: Path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        s2 = AttachmentStore("attach")
        target, _ = s2.save(7, "doc.pdf", b"PDF")
        rel = s2.relative_path(7, "doc.pdf")
        # 用相对路径读取
        assert s2.read(rel) == b"PDF"


# ============================================================
# delete_email_dir / orphan
# ============================================================

class TestDeleteAndOrphan:
    def test_delete_email_dir(self, store: AttachmentStore):
        store.save(42, "x.txt", b"a")
        store.save(42, "y.txt", b"b")
        assert store.dir_for(42).exists()
        store.delete_email_dir(42)
        assert not store.dir_for(42).exists()

    def test_delete_nonexistent_dir_is_noop(self, store: AttachmentStore):
        # 不抛
        store.delete_email_dir(9999)

    def test_find_orphan_dirs(self, store: AttachmentStore):
        store.save(1, "x", b"1")
        store.save(2, "y", b"2")
        store.save(3, "z", b"3")
        # 假装只有 1, 2 在 DB 里
        orphans = store.find_orphan_dirs(known_internal_ids={1, 2})
        assert len(orphans) == 1
        assert orphans[0].name == "3"


# ============================================================
# sha256
# ============================================================

def test_sha256_deterministic():
    a = AttachmentStore.sha256(b"hello")
    b = AttachmentStore.sha256(b"hello")
    c = AttachmentStore.sha256(b"world")
    assert a == b
    assert a != c
    # SHA-256 hex 长度 64
    assert len(a) == 64


class TestAbsolutePath:
    """R-04 / I-05: base_dir resolve 绝对路径 + read/exists 解除 cwd 依赖."""

    def test_base_dir_is_absolute_after_init(self, tmp_path: Path):
        """relative base_dir → __init__ 后变绝对."""
        # 用 monkeypatch 切换 cwd 避免影响其他测试 (用 chdir 上下文)
        import os
        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            store = AttachmentStore("data/attachments")
            assert store.base_dir.is_absolute()
            assert str(store.base_dir) == str((tmp_path / "data" / "attachments").resolve())
        finally:
            os.chdir(old_cwd)

    def test_base_dir_already_absolute_unchanged(self, tmp_path: Path):
        abs_dir = (tmp_path / "myattach").resolve()
        store = AttachmentStore(abs_dir)
        assert store.base_dir == abs_dir
        assert store.base_dir.is_absolute()

    def test_read_with_relative_path_uses_base_dir_anchor(self, tmp_path: Path):
        """read 用 base_dir.parent.parent 当 project_root，不依赖 cwd."""
        import os
        # 构造 base_dir = tmp_path/data/attachments
        base = tmp_path / "data" / "attachments"
        base.mkdir(parents=True)
        # 写一个测试文件到 base/123/test.txt
        (base / "123").mkdir()
        (base / "123" / "test.txt").write_bytes(b"hello")

        store = AttachmentStore(base)
        # 用相对 local_path 调用 read（与生产 SQLite 中 local_path 形式一致）
        # 期望: project_root = base.parent.parent = tmp_path, 拼出 tmp_path/data/attachments/123/test.txt
        # 故意把 cwd 切到 /tmp 看 read 是否仍然成功
        old_cwd = os.getcwd()
        os.chdir("/tmp")
        try:
            content = store.read("data/attachments/123/test.txt")
            assert content == b"hello"
        finally:
            os.chdir(old_cwd)

    def test_read_with_absolute_path(self, tmp_path: Path):
        """绝对路径直接读，不走 anchor."""
        f = tmp_path / "abs_file.bin"
        f.write_bytes(b"abs-content")
        store = AttachmentStore(tmp_path / "x")
        assert store.read(str(f)) == b"abs-content"

    def test_exists_with_relative_path_uses_base_dir_anchor(self, tmp_path: Path):
        import os
        base = tmp_path / "data" / "attachments"
        base.mkdir(parents=True)
        (base / "456").mkdir()
        (base / "456" / "x.bin").write_bytes(b"x")
        store = AttachmentStore(base)

        old_cwd = os.getcwd()
        os.chdir("/tmp")
        try:
            assert store.exists("data/attachments/456/x.bin") is True
            assert store.exists("data/attachments/456/missing.bin") is False
        finally:
            os.chdir(old_cwd)
