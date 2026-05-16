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
