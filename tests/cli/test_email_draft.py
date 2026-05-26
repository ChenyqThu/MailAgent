"""CLI ``mailagent email draft`` 测试.

灵动岛 (ping-island) create_draft / quick_reply_* / decline_with_reason /
nudge_recipient action handler 调本命令. 覆盖:
- 纯函数: _split_addrs (quoted name) + _compose_reply_draft (收件人计算 / threading)
- integration (CliRunner + seeded_db): not-found / no-page-id / no-reply-suggestion
  / dry-run / 真创建 (stub Notion retrieve + fake backend.append_draft)
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
    # Outlook 习惯 semicolon-separated
    assert _split_addrs("a@b.com; c@d.com") == ["a@b.com", "c@d.com"]


def test_split_addrs_quoted_display_name_with_comma():
    # "LastName, FirstName" <a@b> 含逗号的 quoted name 不能错切
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
    # _compose_reply_draft 用 config.user_email 把自己从 reply-all 收件人去掉
    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@mycorp.com")


def test_compose_reply_all_excludes_self_and_includes_sender():
    draft = _compose_reply_draft(
        _record(), internal_id=1, mode="reply-all",
        reply_text="ok", reply_html="<p>ok</p>", extra_to=None, extra_cc=None,
    )
    # to = 原 sender + 原 to (去掉自己 me@mycorp.com)
    assert "alice@example.com" in draft.to
    assert "bob@example.com" in draft.to
    assert "me@mycorp.com" not in draft.to
    # cc = 原 cc (去掉自己)
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
        extra_to="alice@example.com, dave@example.com",  # alice 重复应 dedup
        extra_cc="erin@example.com",
    )
    # alice 只出现一次 (dedup 保序)
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
    assert draft.subject == "Re: Hello"  # 不重复加 Re:


def test_compose_in_reply_to_and_references():
    draft = _compose_reply_draft(
        _record(), internal_id=1, mode="reply",
        reply_text="ok", reply_html=None, extra_to=None, extra_cc=None,
    )
    assert draft.in_reply_to == "<msg-1@example.com>"
    # references = thread head + in_reply_to (Outlook fold)
    assert draft.references == "<thread-head@example.com> <msg-1@example.com>"


def test_compose_no_message_id_no_threading():
    draft = _compose_reply_draft(
        _record(message_id="", thread_id=""), internal_id=1, mode="reply",
        reply_text="ok", reply_html=None, extra_to=None, extra_cc=None,
    )
    assert draft.in_reply_to is None
    assert draft.references is None


def test_compose_thread_id_equals_message_id_no_dup_in_references():
    # thread_id == message_id 时 references 不重复
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
# integration (CliRunner + seeded_db)
# ─────────────────────────────────────────────────────────────────────────────


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


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


def _patch_notion_retrieve(monkeypatch, *, rich_text):
    """Stub NotionClient 让 .client.pages.retrieve 返回含 Reply Suggestion 的 page."""
    from src.notion import client as client_mod

    async def fake_retrieve(*, page_id):
        return {
            "object": "page",
            "id": page_id,
            "properties": {
                "Reply Suggestion": {"rich_text": rich_text},
            },
        }

    class _StubNotionClient:
        def __init__(self, *args, **kwargs):
            self.email_db_id = kwargs.get("email_db_id") or "stub"
            self.client = type("NS", (), {})()
            self.client.pages = type("Pages", (), {})()
            self.client.pages.retrieve = fake_retrieve

    monkeypatch.setattr(client_mod, "NotionClient", _StubNotionClient)
    # NotionSync.__init__ 内 from .client import NotionClient — patch sync 模块引用
    from src.notion import sync as sync_mod
    monkeypatch.setattr(sync_mod, "NotionClient", _StubNotionClient)


def _patch_backend(monkeypatch, fake_backend):
    from src.mail.backend import factory as factory_mod
    monkeypatch.setattr(
        factory_mod, "create_backend",
        lambda *a, **k: fake_backend,
    )


_REPLY_RICH = [
    {"type": "text", "text": {"content": "Hi Alice,\n\nSounds good.\n\n----\nBest,\nLucien"},
     "annotations": {}},
]


def test_draft_not_found(cli_runner, seeded_db):
    r = _invoke(cli_runner, "email", "draft", "99999999", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"


def test_draft_no_notion_page_id(cli_runner, seeded_db):
    # internal_id 12346 (failed sync, notion_page_id=NULL)
    r = _invoke(cli_runner, "email", "draft", "12346", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"
    assert "notion" in data["error"]["message"].lower() or "未同步" in data["error"]["message"]


def test_draft_no_reply_suggestion(cli_runner, seeded_db, monkeypatch):
    # Notion retrieve 返回空 Reply Suggestion → 提示先跑 llm
    _patch_notion_retrieve(monkeypatch, rich_text=[])
    r = _invoke(cli_runner, "email", "draft", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] == "E_NOT_FOUND"
    assert "llm" in data["error"].get("hint", "").lower()


def test_draft_dry_run_emits_plan(cli_runner, seeded_db, monkeypatch):
    _patch_notion_retrieve(monkeypatch, rich_text=_REPLY_RICH)
    r = _invoke(cli_runner, "email", "draft", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success"
    plan = data["data"]
    assert plan["dry_run"] is True
    assert plan["internal_id"] == 12345
    assert plan["mode"] == "reply-all"
    # seeded_db sender=alice@example.com → reply-all to 含 alice
    assert "alice@example.com" in plan["to"]
    assert plan["subject"] == "Re: Hello Test"


def test_draft_real_create_invokes_append_draft(cli_runner, seeded_db, monkeypatch):
    # auth 旁路 — draft 逻辑测试不重测 auth (auth 有 tests/cli/test_auth.py 覆盖);
    # .env 配了服务端 MAILAGENT_CLI_API_KEY 时 ALLOW_UNAUTH_WRITES 不放行, 直接 no-op require_auth.
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)
    _patch_notion_retrieve(monkeypatch, rich_text=_REPLY_RICH)
    fake_backend = _FakeBackend()
    _patch_backend(monkeypatch, fake_backend)

    r = _invoke(cli_runner, "email", "draft", "12345",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert data["data"]["success"] is True
    assert data["data"]["drafts_folder"] == "Drafts"
    assert data["data"]["appended_uid"] == 42
    # backend.append_draft 真被调 + DraftRequest 收件人正确
    assert len(fake_backend.appended) == 1
    draft = fake_backend.appended[0]
    assert "alice@example.com" in draft.to
    assert draft.reply_html and "Sounds good" in draft.reply_html


def test_draft_reply_mode_only_sender(cli_runner, seeded_db, monkeypatch):
    # auth 旁路 — draft 逻辑测试不重测 auth (auth 有 tests/cli/test_auth.py 覆盖);
    # .env 配了服务端 MAILAGENT_CLI_API_KEY 时 ALLOW_UNAUTH_WRITES 不放行, 直接 no-op require_auth.
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)
    _patch_notion_retrieve(monkeypatch, rich_text=_REPLY_RICH)
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
