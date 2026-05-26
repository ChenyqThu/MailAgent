"""CLI ``mailagent email draft`` 测试.

灵动岛 (ping-island) create_draft / quick_reply_* / decline_with_reason /
nudge_recipient action handler 调本命令. reply_suggestion 从 SQLite
llm_processing.labels_json (SSoT) 读, 不读 Notion. 覆盖:
- 纯函数: _split_addrs (quoted name) + _compose_reply_draft (收件人计算 / threading)
- integration (CliRunner + seeded_db + seed llm_processing): not-found /
  no-reply-suggestion / dry-run / 真创建 (fake backend.append_draft)
"""

from __future__ import annotations

import pytest

from src.cli.commands.email import _compose_reply_draft, _split_addrs
from tests.cli.conftest import extract_last_json_object as _last_json


# ─────────────────────────────────────────────────────────────────────────────
# 纯函数: _split_addrs
# ─────────────────────────────────────────────────────────────────────────────


def test_split_addrs_simple():
    assert _split_addrs("a@b.com, c@d.com") == ["a@b.com", "c@d.com"]


def test_split_addrs_semicolon_outlook():
    assert _split_addrs("a@b.com; c@d.com") == ["a@b.com", "c@d.com"]


def test_split_addrs_quoted_display_name_with_comma():
    out = _split_addrs('"Zhang, San" <san@acme.com>, lisi@acme.com')
    assert out == ["san@acme.com", "lisi@acme.com"]


def test_split_addrs_empty():
    assert _split_addrs("") == []
    assert _split_addrs(None) == []  # type: ignore[arg-type]


# ─────────────────────────────────────────────────────────────────────────────
# 纯函数: _compose_reply_draft (收件人计算 + In-Reply-To/References)
# ─────────────────────────────────────────────────────────────────────────────


def _record(**overrides):
    base = {
        "sender": "alice@example.com",
        "to_addr": "me@mycorp.com, bob@example.com",
        "cc_addr": "carol@example.com",
        "subject": "PCI compliance",
        "message_id": "<msg-1@example.com>",
        "thread_id": "<thread-head@example.com>",
        "notion_page_id": "page-1",
    }
    base.update(overrides)
    return base


@pytest.fixture(autouse=True)
def _set_user_email(monkeypatch):
    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@mycorp.com")


def test_compose_reply_all_excludes_self_and_includes_sender():
    draft = _compose_reply_draft(
        _record(), internal_id=1, mode="reply-all",
        reply_text="ok", reply_html="<p>ok</p>", extra_to=None, extra_cc=None,
    )
    assert "alice@example.com" in draft.to
    assert "bob@example.com" in draft.to
    assert "me@mycorp.com" not in draft.to
    assert draft.cc == ["carol@example.com"]


def test_compose_reply_only_sender():
    draft = _compose_reply_draft(
        _record(), internal_id=1, mode="reply",
        reply_text="ok", reply_html=None, extra_to=None, extra_cc=None,
    )
    assert draft.to == ["alice@example.com"]
    assert draft.cc == []


def test_compose_reply_all_dedup_and_extra():
    draft = _compose_reply_draft(
        _record(), internal_id=1, mode="reply-all",
        reply_text="ok", reply_html=None,
        extra_to="alice@example.com, dave@example.com",
        extra_cc="erin@example.com",
    )
    assert draft.to.count("alice@example.com") == 1
    assert "dave@example.com" in draft.to
    assert "erin@example.com" in draft.cc


def test_compose_subject_adds_re_prefix():
    draft = _compose_reply_draft(
        _record(subject="Hello"), internal_id=1, mode="reply",
        reply_text="ok", reply_html=None, extra_to=None, extra_cc=None,
    )
    assert draft.subject == "Re: Hello"


def test_compose_subject_keeps_existing_re():
    draft = _compose_reply_draft(
        _record(subject="Re: Hello"), internal_id=1, mode="reply",
        reply_text="ok", reply_html=None, extra_to=None, extra_cc=None,
    )
    assert draft.subject == "Re: Hello"


def test_compose_in_reply_to_and_references():
    draft = _compose_reply_draft(
        _record(), internal_id=1, mode="reply",
        reply_text="ok", reply_html=None, extra_to=None, extra_cc=None,
    )
    assert draft.in_reply_to == "<msg-1@example.com>"
    assert draft.references == "<thread-head@example.com> <msg-1@example.com>"


def test_compose_no_message_id_no_threading():
    draft = _compose_reply_draft(
        _record(message_id="", thread_id=""), internal_id=1, mode="reply",
        reply_text="ok", reply_html=None, extra_to=None, extra_cc=None,
    )
    assert draft.in_reply_to is None
    assert draft.references is None


def test_compose_thread_id_equals_message_id_no_dup_in_references():
    draft = _compose_reply_draft(
        _record(thread_id="<msg-1@example.com>"), internal_id=1, mode="reply",
        reply_text="ok", reply_html=None, extra_to=None, extra_cc=None,
    )
    assert draft.references == "<msg-1@example.com>"


def test_compose_carries_reply_text_and_html():
    draft = _compose_reply_draft(
        _record(), internal_id=99, mode="reply",
        reply_text="hello body", reply_html="<p>hello body</p>",
        extra_to=None, extra_cc=None,
    )
    assert draft.reply_text == "hello body"
    assert draft.reply_html == "<p>hello body</p>"
    assert draft.internal_id_for_threading == 99


# ─────────────────────────────────────────────────────────────────────────────
# integration (CliRunner + seeded_db + seed llm_processing.labels_json)
# ─────────────────────────────────────────────────────────────────────────────


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


def _seed_reply_suggestion(db_path, internal_id, reply_md, priority="🟡 重要"):
    """在 SQLite llm_processing 表 seed 一行含 labels_json.reply_suggestion_md.

    llm_processing 表由 LLMProcessingStore 建 (seeded_db 的 SyncStore 不建), 所以
    先构造 store 确保表存在, 再裸 SQL upsert labels_json.
    """
    import json
    import sqlite3
    import time

    from src.llm_agent.store import LLMProcessingStore

    LLMProcessingStore(str(db_path))  # _init 建 llm_processing 表
    conn = sqlite3.connect(str(db_path))
    labels = {"reply_suggestion_md": reply_md, "priority": priority}
    now = time.time()
    conn.execute(
        "INSERT INTO llm_processing (internal_id, status, labels_json, created_at, updated_at) "
        "VALUES (?, 'success', ?, ?, ?) "
        "ON CONFLICT(internal_id) DO UPDATE SET labels_json=excluded.labels_json, "
        "updated_at=excluded.updated_at",
        (internal_id, json.dumps(labels, ensure_ascii=False), now, now),
    )
    conn.commit()
    conn.close()


class _FakeBackend:
    """fake IMailBackend: 只实现 append_draft, 记录 DraftRequest."""

    def __init__(self):
        self.appended = []

    def append_draft(self, draft):
        from src.mail.backend.types import DraftAppendResult
        self.appended.append(draft)
        return DraftAppendResult(
            success=True, drafts_folder="Drafts", appended_uid=42,
            method="imap_append",
        )


def _patch_backend(monkeypatch, fake_backend):
    from src.mail.backend import factory as factory_mod
    monkeypatch.setattr(
        factory_mod, "create_backend",
        lambda *a, **k: fake_backend,
    )


def _bypass_auth(monkeypatch):
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)


_REPLY_MD = "Hi Alice,\n\nSounds good, I'll review by Friday.\n\n----\nBest,\nLucien"


def test_draft_not_found(cli_runner, seeded_db):
    r = _invoke(cli_runner, "email", "draft", "99999999", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"


def test_draft_no_reply_suggestion(cli_runner, seeded_db):
    # 12345 无 llm_processing 行 (没 seed) → labels_json 空 → E_NOT_FOUND
    r = _invoke(cli_runner, "email", "draft", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"
    assert "llm" in data["error"].get("hint", "").lower()


def test_draft_dry_run_emits_plan(cli_runner, seeded_db):
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    r = _invoke(cli_runner, "email", "draft", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    plan = data["data"]
    assert plan["dry_run"] is True
    assert plan["internal_id"] == 12345
    assert plan["mode"] == "reply-all"
    # seeded_db sender=alice@example.com → reply-all to 含 alice
    assert "alice@example.com" in plan["to"]
    assert plan["subject"] == "Re: Hello Test"
    assert plan["reply_source"] == "sqlite:llm_processing.labels_json"


def test_draft_real_create_invokes_append_draft(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    fake_backend = _FakeBackend()
    _patch_backend(monkeypatch, fake_backend)

    r = _invoke(cli_runner, "email", "draft", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert data["data"]["success"] is True
    assert data["data"]["drafts_folder"] == "Drafts"
    assert data["data"]["appended_uid"] == 42
    # backend.append_draft 真被调 + DraftRequest 收件人 + reply_html (md→html) 正确
    assert len(fake_backend.appended) == 1
    draft = fake_backend.appended[0]
    assert "alice@example.com" in draft.to
    assert draft.reply_text == _REPLY_MD  # plain = markdown 原文
    assert draft.reply_html and "Sounds good" in draft.reply_html


def test_draft_reply_mode_only_sender(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    fake_backend = _FakeBackend()
    _patch_backend(monkeypatch, fake_backend)

    r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "reply",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    draft = fake_backend.appended[0]
    assert draft.to == ["alice@example.com"]


def test_draft_invalid_mode_rejected(cli_runner, seeded_db):
    r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "forward",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] in ("E_INVALID_ARG", "E_INVALID_ARGUMENT")
