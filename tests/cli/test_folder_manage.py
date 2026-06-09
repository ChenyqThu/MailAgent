"""P4 多文件夹同步: 写操作泛化 (move_to_folder) + 文件夹管理 CRUD (create/rename/delete)。

IMAP 真操作需 davmail 无法 CI 跑 → mock FolderImapReader。验证 service 编排 +
src 解析 + 系统文件夹保护 + 本地一致性 + CLI 契约。
"""
from __future__ import annotations


import pytest

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app

    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


@pytest.fixture
def davmail_env(cli_env, monkeypatch):
    monkeypatch.setenv("MAILAGENT_BACKEND", "davmail")
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)
    return cli_env


# ============================================================
# 纯 helper: build_child_imap_name + _resolve_folder_imap
# ============================================================

def test_build_child_imap_name_toplevel():
    from src.mail.backend.imap_folder_reader import FolderImapReader

    assert FolderImapReader.build_child_imap_name("", "Jira") == "Jira"
    # 中文叶子 → modified-UTF7 编码
    assert FolderImapReader.build_child_imap_name("", "测试") == "&bUuL1Q-"


def test_build_child_imap_name_nested():
    from src.mail.backend.imap_folder_reader import FolderImapReader

    assert FolderImapReader.build_child_imap_name("Proj", "Q2") == "Proj/Q2"
    assert FolderImapReader.build_child_imap_name("Proj", "子") == "Proj/&W1A-"


def test_resolve_folder_imap_standard_and_custom():
    from types import SimpleNamespace

    from src.services.mail_write import MailWriteService

    svc = MailWriteService.__new__(MailWriteService)
    svc._ctx = SimpleNamespace(
        backend=SimpleNamespace(sent_folder="Sent Items", drafts_folder="Drafts")
    )
    assert svc._resolve_folder_imap("收件箱") == "INBOX"
    assert svc._resolve_folder_imap("") == "INBOX"
    assert svc._resolve_folder_imap("发件箱") == "Sent Items"
    # 自定义文件夹中文 → encode_imap_utf7
    assert svc._resolve_folder_imap("DMS固件发布") == "DMS&VvpO9lPRXgM-"
    assert svc._resolve_folder_imap("Jira") == "Jira"


# ============================================================
# 文件夹管理 CRUD (CLI → service, mock reader)
# ============================================================

class _FakeReader:
    def __init__(self):
        self.created = []
        self.renamed = []
        self.deleted = []

    @staticmethod
    def build_child_imap_name(parent, child, delimiter="/"):
        from src.mail.backend.imap_folder_reader import FolderImapReader

        return FolderImapReader.build_child_imap_name(parent, child, delimiter)

    def create_folder(self, imap_name):
        self.created.append(imap_name)
        return True

    def rename_folder(self, old, new):
        self.renamed.append((old, new))
        return True

    def delete_folder(self, imap_name):
        self.deleted.append(imap_name)
        return True


def _patch_reader(monkeypatch, reader):
    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._folder_imap_reader",
        lambda self: reader,
    )


def _patch_no_system(monkeypatch):
    # _assert_not_system_folder 用 list_folders → mock 返回空 (无系统文件夹命中)
    monkeypatch.setattr("src.mail.backend.imap_client.list_folders", lambda cfg, with_counts=True: [])


def _patch_whitelist_noop(monkeypatch):
    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._rewrite_whitelist", lambda self, mutate: None
    )


def test_folder_create_cli(cli_runner, davmail_env, seeded_db, monkeypatch):
    reader = _FakeReader()
    _patch_reader(monkeypatch, reader)
    r = _invoke(cli_runner, "folder", "create", "新文件夹", "--parent", "Proj", "-o", "json", db_path=seeded_db)
    assert r.exit_code == 0, r.output
    data = _last_json(r.output)["data"]
    assert data["action"] == "create"
    # imap_name = Proj/<encode(新文件夹)>
    assert data["imap_name"].startswith("Proj/")
    assert reader.created == [data["imap_name"]]


def test_folder_rename_cli(cli_runner, davmail_env, seeded_db, monkeypatch):
    reader = _FakeReader()
    _patch_reader(monkeypatch, reader)
    _patch_no_system(monkeypatch)
    _patch_whitelist_noop(monkeypatch)
    r = _invoke(cli_runner, "folder", "rename", "Jira", "项目", "-o", "json", db_path=seeded_db)
    assert r.exit_code == 0, r.output
    data = _last_json(r.output)["data"]
    assert data["action"] == "rename"
    assert data["imap_name"] == "Jira"
    assert reader.renamed and reader.renamed[0][0] == "Jira"


def test_folder_rename_rejects_system(cli_runner, davmail_env, seeded_db, monkeypatch):
    from src.mail.backend.imap_client import FolderInfo

    reader = _FakeReader()
    _patch_reader(monkeypatch, reader)
    # list_folders 返回 Sent 标 is_system
    monkeypatch.setattr(
        "src.mail.backend.imap_client.list_folders",
        lambda cfg, with_counts=True: [FolderInfo("Sent", "Sent", "/", "\\sent", True, False, None, 0)],
    )
    r = _invoke(cli_runner, "folder", "rename", "Sent", "x", "-o", "json", db_path=seeded_db)
    payload = _last_json(r.output)
    assert payload["status"] == "error"
    assert "系统文件夹" in (payload.get("error", {}).get("message", "") + r.output)
    assert reader.renamed == []   # 未调 IMAP


def test_folder_delete_cli(cli_runner, davmail_env, seeded_db, monkeypatch):
    reader = _FakeReader()
    _patch_reader(monkeypatch, reader)
    _patch_no_system(monkeypatch)
    _patch_whitelist_noop(monkeypatch)
    r = _invoke(cli_runner, "folder", "delete-folder", "Jira", "-o", "json", db_path=seeded_db)
    assert r.exit_code == 0, r.output
    data = _last_json(r.output)["data"]
    assert data["action"] == "delete"
    assert reader.deleted == ["Jira"]


def test_folder_create_gated_on_applescript(cli_runner, cli_env, seeded_db, monkeypatch):
    monkeypatch.setenv("MAILAGENT_BACKEND", "applescript")
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)
    r = _invoke(cli_runner, "folder", "create", "X", "-o", "json", db_path=seeded_db)
    payload = _last_json(r.output)
    assert payload["status"] == "error"
    assert "davmail" in (payload.get("error", {}).get("message", "") + r.output).lower()


# ============================================================
# move_to_folder (service, mock reader)
# ============================================================

def test_move_to_folder_resolves_src(seeded_db, monkeypatch):
    """move_to_folder: src 从邮件当前 mailbox 解析, dst 透传; SQLite mailbox 更新。"""
    from src.cli.context import CliContext
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    calls = []

    class _R:
        def move_by_message_id(self, src_imap, message_id, dst_imap, fallback_uid=None):
            calls.append((src_imap, dst_imap))
            return True

    cli = CliContext.from_flags(db_path=str(seeded_db))
    monkeypatch.setattr(MailWriteService, "_folder_imap_reader", lambda self: _R())

    async def _noop_notion(self, page_id, mailbox):
        return None

    monkeypatch.setattr(MailWriteService, "_update_notion_mailbox", _noop_notion)
    svc = MailWriteService(cli)
    # seeded 邮件 12345 mailbox='收件箱' → src=INBOX
    result = svc.move_to_folder(12345, "Jira", actor=Actor(kind="cli", authenticated=True, label="t"))
    assert result.to_mailbox == "Jira"
    assert calls == [("INBOX", "Jira")]
    # SQLite 真被改
    import sqlite3
    conn = sqlite3.connect(str(seeded_db))
    mb = conn.execute("SELECT mailbox FROM email_metadata WHERE internal_id=12345").fetchone()[0]
    conn.close()
    assert mb == "Jira"


# ============================================================
# P4 review 修复: delete 级联清理 + restart_required + 嵌套 rename + move trash 守卫
# ============================================================

def _seed_custom_email_full(db_path, internal_id, mailbox, with_body=True):
    """seed metadata(+body+attachment) for a custom-folder email (验级联删)。"""
    import sqlite3
    import time

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys=ON")
    now = time.time()
    try:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, message_id, subject, sender, "
            "mailbox, sync_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (internal_id, f"<m{internal_id}@x>", "S", "a@b", mailbox, "synced", now, now),
        )
        if with_body:
            conn.execute(
                "INSERT INTO email_body (internal_id, message_id, body_html, body_markdown, "
                "body_format, body_size_bytes, has_inline_images, raw_mime_sha256, fetched_at, "
                "fetched_source, schema_version) VALUES (?,?,?,?,'html',?,0,?,?,'davmail',1)",
                (internal_id, f"<m{internal_id}@x>", "<p>x</p>", "x body", 6, "a" * 64, now),
            )
            conn.execute(
                "INSERT INTO email_attachment (internal_id, filename, content_type, size_bytes, "
                "is_inline, local_path, sha256, created_at, schema_version) "
                "VALUES (?,?,?,?,0,?,?,?,1)",
                (internal_id, "f.pdf", "application/pdf", 10, None, "b" * 64, now),
            )
        conn.commit()
    finally:
        conn.close()


def _svc_with_fake_reader(seeded_db, monkeypatch, reader=None):
    from src.cli.context import CliContext
    from src.services.mail_write import MailWriteService

    cli = CliContext.from_flags(db_path=str(seeded_db))
    monkeypatch.setattr(MailWriteService, "_folder_imap_reader", lambda self: reader or _FakeReader())
    monkeypatch.setattr("src.mail.backend.imap_client.list_folders", lambda cfg, with_counts=True: [])
    return MailWriteService(cli)


def test_delete_folder_cascade_no_orphan(seeded_db, monkeypatch):
    """🔴 review#1: delete_folder 级联清 body/attachment/FTS (不留孤儿)。"""
    from src.services.guards import Actor

    _seed_custom_email_full(seeded_db, 1_000_100_001, "Jira")
    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._rewrite_whitelist", lambda self, mutate: False
    )
    svc = _svc_with_fake_reader(seeded_db, monkeypatch)
    result = svc.delete_folder("Jira", actor=Actor(kind="cli", authenticated=True, label="t"))
    assert result.affected_local_rows == 1
    import sqlite3
    conn = sqlite3.connect(str(seeded_db))
    try:
        assert conn.execute("SELECT COUNT(*) FROM email_metadata WHERE internal_id=1000100001").fetchone()[0] == 0
        # 级联: body/attachment 行也清 (FK CASCADE 生效, 非孤儿)
        assert conn.execute("SELECT COUNT(*) FROM email_body WHERE internal_id=1000100001").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM email_attachment WHERE internal_id=1000100001").fetchone()[0] == 0
    finally:
        conn.close()


def test_delete_restart_required_when_whitelisted(seeded_db, monkeypatch, tmp_path):
    """review#2: delete 白名单内文件夹 → restart_required=True; 不在 → False。"""
    from src.services.guards import Actor

    actor = Actor(kind="cli", authenticated=True, label="t")
    # 在白名单 → _rewrite_whitelist 真改 → True
    monkeypatch.setattr("src.services.mail_write.MailWriteService._rewrite_whitelist", lambda self, mutate: True)
    svc = _svc_with_fake_reader(seeded_db, monkeypatch)
    r1 = svc.delete_folder("Jira", actor=actor)
    assert r1.restart_required is True
    # 不在白名单 → False
    monkeypatch.setattr("src.services.mail_write.MailWriteService._rewrite_whitelist", lambda self, mutate: False)
    svc2 = _svc_with_fake_reader(seeded_db, monkeypatch)
    r2 = svc2.delete_folder("Ghost", actor=actor)
    assert r2.restart_required is False


def test_rename_local_mailbox_updates_children(seeded_db, monkeypatch):
    """review LOW: rename 父文件夹 → 子文件夹邮件 label 前缀也更新 (label 存完整路径)。"""
    from src.services.mail_write import MailWriteService

    _seed_custom_email_full(seeded_db, 1_000_200_001, "项目", with_body=False)
    _seed_custom_email_full(seeded_db, 1_000_200_002, "项目/2026 Q2", with_body=False)
    svc = MailWriteService.__new__(MailWriteService)
    from src.cli.context import CliContext
    svc._ctx = CliContext.from_flags(db_path=str(seeded_db))
    n = svc._rename_local_mailbox("项目", "新项目")
    assert n == 2   # 父 1 + 子 1
    import sqlite3
    conn = sqlite3.connect(str(seeded_db))
    try:
        assert conn.execute("SELECT mailbox FROM email_metadata WHERE internal_id=1000200001").fetchone()[0] == "新项目"
        assert conn.execute("SELECT mailbox FROM email_metadata WHERE internal_id=1000200002").fetchone()[0] == "新项目/2026 Q2"
    finally:
        conn.close()


def test_move_to_trash_rejected(seeded_db, monkeypatch):
    """review LOW: move 到回收站/垃圾邮件被拒 (防误删)。"""
    from src.services.errors import ServiceInvalidArgError
    from src.services.guards import Actor

    svc = _svc_with_fake_reader(seeded_db, monkeypatch)
    with pytest.raises(ServiceInvalidArgError):
        svc.move_to_folder(12345, "Trash", actor=Actor(kind="cli", authenticated=True, label="t"))
    with pytest.raises(ServiceInvalidArgError):
        svc.move_to_folder(12345, "Junk", actor=Actor(kind="cli", authenticated=True, label="t"))


# ============================================================
# P5: 取消勾选清理 (cleanup_local_folder — 删本地副本, 不碰 Exchange)
# ============================================================

def test_cleanup_local_folder_deletes_rows_not_exchange(seeded_db, monkeypatch):
    """cleanup: 删本地 email_metadata (级联) + 移白名单; **不调 reader (不碰 Exchange)**。"""
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    _seed_custom_email_full(seeded_db, 1_000_300_001, "Jira")
    reader_called = {"n": 0}

    class _NoReader:
        def __getattr__(self, name):
            reader_called["n"] += 1
            raise AssertionError(f"cleanup 不该调 reader.{name} (不碰 Exchange)")

    from src.cli.context import CliContext
    cli = CliContext.from_flags(db_path=str(seeded_db))
    monkeypatch.setattr(MailWriteService, "_folder_imap_reader", lambda self: _NoReader())
    monkeypatch.setattr(MailWriteService, "_rewrite_whitelist", lambda self, mutate: True)
    svc = MailWriteService(cli)
    result = svc.cleanup_local_folder("Jira", actor=Actor(kind="cli", authenticated=True, label="t"))
    assert result.action == "cleanup"
    assert result.affected_local_rows == 1
    assert result.restart_required is True
    assert reader_called["n"] == 0   # Exchange 未碰
    import sqlite3
    conn = sqlite3.connect(str(seeded_db))
    try:
        assert conn.execute("SELECT COUNT(*) FROM email_metadata WHERE internal_id=1000300001").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM email_body WHERE internal_id=1000300001").fetchone()[0] == 0
    finally:
        conn.close()


def test_cleanup_cli(cli_runner, davmail_env, seeded_db, monkeypatch):
    from src.services.mail_write import MailWriteService

    _seed_custom_email_full(seeded_db, 1_000_300_002, "Notion", with_body=False)
    monkeypatch.setattr(MailWriteService, "_rewrite_whitelist", lambda self, mutate: True)
    r = _invoke(cli_runner, "folder", "cleanup", "Notion", "-o", "json", db_path=seeded_db)
    assert r.exit_code == 0, r.output
    data = _last_json(r.output)["data"]
    assert data["action"] == "cleanup" and data["affected_local_rows"] == 1


# ============================================================
# P5 review 修复: cleanup 守卫 (空名/系统邮箱) + 删/清含子文件夹本地行
# ============================================================

def test_cleanup_rejects_empty_and_system(seeded_db, monkeypatch):
    """review LOW: cleanup 拒空 imap_name + INBOX/标准邮箱（防误删收件箱本地行）。"""
    from src.services.errors import ServiceInvalidArgError
    from src.services.guards import Actor
    from src.services.mail_write import MailWriteService

    monkeypatch.setattr(MailWriteService, "_rewrite_whitelist", lambda self, mutate: False)
    svc = _svc_with_fake_reader(seeded_db, monkeypatch)
    actor = Actor(kind="cli", authenticated=True, label="t")
    for bad in ("", "  ", "INBOX", "收件箱", "发件箱"):
        with pytest.raises(ServiceInvalidArgError):
            svc.cleanup_local_folder(bad, actor=actor)


def test_delete_local_rows_includes_subfolders(seeded_db, monkeypatch):
    """review LOW: 删/清父文件夹时子文件夹 (label/子) 本地行也清, 不留孤儿。"""
    from src.services.mail_write import MailWriteService

    _seed_custom_email_full(seeded_db, 1_000_400_001, "项目", with_body=False)
    _seed_custom_email_full(seeded_db, 1_000_400_002, "项目/2026 Q2", with_body=False)
    _seed_custom_email_full(seeded_db, 1_000_400_003, "项目别的", with_body=False)  # 非子, 不该删
    svc = MailWriteService.__new__(MailWriteService)
    from src.cli.context import CliContext
    svc._ctx = CliContext.from_flags(db_path=str(seeded_db))
    n = svc._delete_local_mailbox_rows("项目")
    assert n == 2   # 项目 + 项目/2026 Q2 (不含 项目别的)
    import sqlite3
    conn = sqlite3.connect(str(seeded_db))
    try:
        assert conn.execute("SELECT COUNT(*) FROM email_metadata WHERE internal_id IN (1000400001,1000400002)").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM email_metadata WHERE internal_id=1000400003").fetchone()[0] == 1  # 非子保留
    finally:
        conn.close()
