"""CLI ``mailagent email archive`` 测试 (收件箱归档: IMAP MOVE INBOX→Archive +
Mailbox→存档, davmail-only).

IMAP MOVE 本身需真 davmail, 无法 CI 跑 — 这里 mock FolderImapReader + Notion,
覆盖: dry-run plan / not-found / already-archived / 非 davmail backend 拒绝 /
成功路径 (SQLite mailbox 真被改 + reader 真被调). 另含 SyncStore.update_mailbox 单测.
"""

from __future__ import annotations

import sqlite3

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


def _bypass_auth(monkeypatch):
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)


def _set_mailbox(db_path, internal_id, mailbox):
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "UPDATE email_metadata SET mailbox = ? WHERE internal_id = ?", (mailbox, internal_id)
    )
    conn.commit()
    conn.close()


def _read_mailbox(db_path, internal_id):
    conn = sqlite3.connect(str(db_path))
    row = conn.execute(
        "SELECT mailbox FROM email_metadata WHERE internal_id = ?", (internal_id,)
    ).fetchone()
    conn.close()
    return row[0] if row else None


# ─────────────────────────────────────────────────────────────────────────────
# dry-run / 校验 (无 IMAP/Notion 依赖)
# ─────────────────────────────────────────────────────────────────────────────


def test_archive_dry_run_plan(cli_runner, seeded_db):
    r = _invoke(cli_runner, "email", "archive", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    plan = data["data"]
    assert plan["dry_run"] is True
    assert plan["action"] == "archive"
    assert plan["from_mailbox"] == "收件箱"
    assert plan["to_mailbox"] == "存档"
    assert plan["notion_page_id"]  # seeded 有 notion_page_id
    # dry-run 不写 SQLite
    assert _read_mailbox(seeded_db, 12345) == "收件箱"


def test_archive_not_found(cli_runner, seeded_db):
    r = _invoke(cli_runner, "email", "archive", "99999999", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"


def test_archive_already_archived_rejected(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    _set_mailbox(seeded_db, 12345, "存档")
    r = _invoke(cli_runner, "email", "archive", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] in ("E_INVALID_ARG", "E_INVALID_ARGUMENT")


def test_archive_non_davmail_backend_rejected(cli_runner, seeded_db, monkeypatch):
    # 非 davmail backend → _folder_imap_reader 抛 CliInvalidArgError (归档 davmail-only)
    _bypass_auth(monkeypatch)

    class _NotDavmail:
        backend_origin = "applescript"

    from src.mail.backend import factory as factory_mod
    monkeypatch.setattr(factory_mod, "create_backend", lambda *a, **k: _NotDavmail())

    r = _invoke(cli_runner, "email", "archive", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] in ("E_INVALID_ARG", "E_INVALID_ARGUMENT")
    # IMAP 没跑 → mailbox 不变
    assert _read_mailbox(seeded_db, 12345) == "收件箱"


# ─────────────────────────────────────────────────────────────────────────────
# 成功路径 (mock reader + Notion)
# ─────────────────────────────────────────────────────────────────────────────


class _FakeReader:
    def __init__(self):
        self.calls = []

    def archive_inbox_message(self, message_id, fallback_uid=None, src_imap="INBOX"):
        # P4: archive_inbox_message 加 src_imap 泛化 (自定义文件夹邮件归档 src≠INBOX)。
        self.calls.append((message_id, fallback_uid, src_imap))
        return True


def test_archive_success_updates_mailbox(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    fake_reader = _FakeReader()
    # A3: archive 编排 + IMAP/Notion helper 下沉 MailWriteService → monkeypatch service 方法。
    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._folder_imap_reader",
        lambda self: fake_reader,
    )

    notion_calls = []

    async def _fake_notion(self, page_id, mailbox):
        notion_calls.append((page_id, mailbox))

    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._update_notion_mailbox", _fake_notion
    )

    r = _invoke(cli_runner, "email", "archive", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert data["data"]["success"] is True
    assert data["data"]["to_mailbox"] == "存档"
    assert data["data"]["notion_updated"] is True
    # reader 真被调 (传 message_id, src=INBOX 因邮件在收件箱)
    assert len(fake_reader.calls) == 1
    assert fake_reader.calls[0][0] == "<msg-12345@example.com>"
    assert fake_reader.calls[0][2] == "INBOX"
    # SQLite mailbox 真被改 → 移出收件箱视图
    assert _read_mailbox(seeded_db, 12345) == "存档"
    # Notion 镜像也更新
    assert notion_calls == [("abc12345-0000-0000-0000-000000000001", "存档")]


def test_archive_imap_failure_keeps_mailbox(cli_runner, seeded_db, monkeypatch):
    # IMAP MOVE 失败 → 整体 error, mailbox 不变 (不留半归档状态)
    _bypass_auth(monkeypatch)

    class _FailReader:
        def archive_inbox_message(self, message_id, fallback_uid=None, src_imap="INBOX"):
            return False

    monkeypatch.setattr(
        "src.services.mail_write.MailWriteService._folder_imap_reader",
        lambda self: _FailReader(),
    )

    r = _invoke(cli_runner, "email", "archive", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert _read_mailbox(seeded_db, 12345) == "收件箱"


# ─────────────────────────────────────────────────────────────────────────────
# SyncStore.update_mailbox 单测
# ─────────────────────────────────────────────────────────────────────────────


def test_update_mailbox_changes_and_idempotent(seeded_db):
    from src.mail.sync_store import SyncStore

    store = SyncStore(str(seeded_db))
    assert store.update_mailbox(12345, "存档") is True
    assert _read_mailbox(seeded_db, 12345) == "存档"
    # 再写同值 → no-op False
    assert store.update_mailbox(12345, "存档") is False
    # 不存在的 id → False
    assert store.update_mailbox(99999999, "存档") is False
