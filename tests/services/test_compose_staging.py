"""compose_staging — D1 两段式上传暂存区单元测试 (07-04-send-attachments-richtext).

覆盖: stage→read 往返 / filename sanitize (路径穿越) / stage_id 形态防御 /
discard 消费清理 / sweep_stale TTL 回收。全部走 tmp_path, 不碰真实 data/。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from src.services.compose_staging import (
    STAGING_TTL_SECONDS,
    discard_staged,
    guess_mime,
    read_staged,
    stage_attachment,
    staging_root,
    sweep_stale,
)


class _Cfg:
    def __init__(self, tmp_path: Path):
        self.sync_store_db_path = str(tmp_path / "sync_store.db")


@pytest.fixture()
def cfg(tmp_path: Path) -> _Cfg:
    return _Cfg(tmp_path)


def test_staging_root_is_db_sibling_not_attachments(cfg, tmp_path):
    root = staging_root(cfg)
    assert root == tmp_path / "compose_staging"
    # SSoT 隔离: 绝不指向 data/attachments 的 internal_id 目录空间
    assert "attachments" not in root.parts


def test_stage_and_read_roundtrip(cfg):
    resp = stage_attachment(cfg, "report.pdf", b"%PDF-fake")
    assert set(resp) == {"stage_id", "filename", "size", "mime"}
    assert resp["filename"] == "report.pdf"
    assert resp["size"] == len(b"%PDF-fake")
    assert resp["mime"] == "application/pdf"
    got = read_staged(cfg, resp["stage_id"])
    assert got is not None
    filename, data, mime = got
    assert filename == "report.pdf"
    assert data == b"%PDF-fake"
    assert mime == "application/pdf"


def test_stage_sanitizes_traversal_filename(cfg):
    resp = stage_attachment(cfg, "../../etc/passwd", b"x")
    # 路径分隔符被 sanitize 成下划线 — 文件必须落在 staging root 之内
    assert "/" not in resp["filename"]
    staged_file = staging_root(cfg) / resp["stage_id"] / resp["filename"]
    assert staged_file.is_file()
    assert staged_file.resolve().is_relative_to(staging_root(cfg).resolve())


def test_guess_mime_fallback_octet_stream():
    assert guess_mime("weird.unknownext123") == "application/octet-stream"
    assert guess_mime("photo.png") == "image/png"


def test_read_staged_rejects_bad_stage_ids(cfg, tmp_path):
    # 放一个诱饵文件在 staging root 之外
    (tmp_path / "secret.txt").write_text("s")
    for bad in ("", "../secret.txt", "ABC", "12345", None, "a" * 31, "Z" * 32):
        assert read_staged(cfg, bad) is None  # type: ignore[arg-type]


def test_read_staged_missing_dir_returns_none(cfg):
    assert read_staged(cfg, "0" * 32) is None


def test_discard_staged_removes_dir(cfg):
    resp = stage_attachment(cfg, "a.txt", b"hi")
    d = staging_root(cfg) / resp["stage_id"]
    assert d.is_dir()
    discard_staged(cfg, resp["stage_id"])
    assert not d.exists()
    # 幂等 + 非法 id 不炸
    discard_staged(cfg, resp["stage_id"])
    discard_staged(cfg, "../oops")


def test_sweep_stale_removes_only_expired(cfg):
    old = stage_attachment(cfg, "old.txt", b"1")
    fresh = stage_attachment(cfg, "new.txt", b"2")
    old_dir = staging_root(cfg) / old["stage_id"]
    past = time.time() - STAGING_TTL_SECONDS - 60
    os.utime(old_dir, (past, past))
    removed = sweep_stale(cfg)
    assert removed == 1
    assert not old_dir.exists()
    assert (staging_root(cfg) / fresh["stage_id"]).is_dir()


def test_sweep_stale_no_root_is_noop(cfg):
    assert sweep_stale(cfg) == 0
