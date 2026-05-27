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
# 纯函数: _compose_reply_draft forward 模式
# ─────────────────────────────────────────────────────────────────────────────


def test_compose_forward_recipients_pure_extra_to():
    # forward 收件人纯来自 extra_to (不从原邮件 sender/to 推导)
    draft = _compose_reply_draft(
        _record(), internal_id=5, mode="forward",
        reply_text="fyi", reply_html=None,
        extra_to="x@y.com, z@y.com", extra_cc="cc@y.com",
        forward_intro_text="---- Forwarded ----", forward_intro_html="<hr>",
        attachments=[("a.pdf", b"data", "application/pdf")],
    )
    assert draft.to == ["x@y.com", "z@y.com"]
    assert draft.cc == ["cc@y.com"]
    assert "alice@example.com" not in draft.to  # 原 sender 不入 to


def test_compose_forward_subject_fwd_prefix():
    draft = _compose_reply_draft(
        _record(subject="Hello"), internal_id=5, mode="forward",
        reply_text="", reply_html=None, extra_to="x@y.com", extra_cc=None,
    )
    assert draft.subject == "Fwd: Hello"


def test_compose_forward_keeps_existing_fwd():
    draft = _compose_reply_draft(
        _record(subject="Fwd: Hello"), internal_id=5, mode="forward",
        reply_text="", reply_html=None, extra_to="x@y.com", extra_cc=None,
    )
    assert draft.subject == "Fwd: Hello"


def test_compose_forward_no_threading_headers():
    # forward 是独立邮件 — 不带 In-Reply-To / References
    draft = _compose_reply_draft(
        _record(), internal_id=5, mode="forward",
        reply_text="fyi", reply_html=None, extra_to="x@y.com", extra_cc=None,
    )
    assert draft.in_reply_to is None
    assert draft.references is None


def test_compose_forward_carries_intro_and_attachments():
    draft = _compose_reply_draft(
        _record(), internal_id=5, mode="forward",
        reply_text="fyi", reply_html=None, extra_to="x@y.com", extra_cc=None,
        forward_intro_text="---- Forwarded ----", forward_intro_html="<hr>orig",
        attachments=[("a.pdf", b"data", "application/pdf")],
    )
    assert draft.forward_intro_text == "---- Forwarded ----"
    assert draft.forward_intro_html == "<hr>orig"
    assert len(draft.attachments) == 1
    assert draft.attachments[0][0] == "a.pdf"


def test_compose_to_override_bypasses_derivation():
    # 前端 compose 传 to_override/cc_override → 权威完整列表, 不推导不叠加
    draft = _compose_reply_draft(
        _record(), internal_id=1, mode="reply-all",
        reply_text="x", reply_html=None, extra_to="ignored@x.com", extra_cc=None,
        to_override="only@y.com, two@y.com", cc_override="cc@y.com", bcc="secret@y.com",
    )
    assert draft.to == ["only@y.com", "two@y.com"]
    assert draft.cc == ["cc@y.com"]
    assert draft.bcc == ["secret@y.com"]
    assert "alice@example.com" not in draft.to  # 原 sender 推导被覆盖
    assert "ignored@x.com" not in draft.to  # extra_to 不叠加


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


def test_draft_dry_run_no_reply_suggestion_prefills_recipients(cli_runner, seeded_db):
    # dry-run = 前端 compose 预填: 收件人推导不依赖 LLM 建议, 12345 无 reply_suggestion
    # 也要返回推导出的收件人 (正文留空让用户自己写), 不能整个 plan 失败 — 否则前端
    # 打开回复面板时连收件人都拿不到 (Bug B 修复).
    r = _invoke(cli_runner, "email", "draft", "12345", "--dry-run",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    plan = data["data"]
    assert plan["dry_run"] is True
    # reply-all (默认 mode) → to 含原发件人; 收件人推导与有无建议无关
    assert "alice@example.com" in plan["to"]
    # 无建议但有原邮件 → reply_html = 原邮件引用块 (无 suggestion 时正文头为空, 仅引用)
    assert plan["reply_html"]
    assert "写道" in plan["reply_html"]  # 回复引用头


def test_draft_real_no_reply_suggestion_errors(cli_runner, seeded_db):
    # 真实 draft (非 dry-run) 无正文来源仍报错, 避免误发空回复 — allow_missing_reply
    # 只对 dry-run 预填放宽, 写命令契约不变.
    r = _invoke(cli_runner, "email", "draft", "12345",
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
    # reply_text = suggestion + 原邮件引用 (Mail.app/Outlook 行为)
    assert draft.reply_text.startswith(_REPLY_MD)
    assert "写道" in draft.reply_text  # 引用头
    assert draft.reply_html and "Sounds good" in draft.reply_html
    assert "写道" in draft.reply_html  # reply_html 也含引用


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


def test_draft_forward_requires_extra_to(cli_runner, seeded_db):
    # forward 模式必须显式收件人 (不从原邮件推导) → 无 --extra-to 报 E_INVALID_ARG
    r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "forward",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] in ("E_INVALID_ARG", "E_INVALID_ARGUMENT")


def test_draft_truly_invalid_mode_rejected(cli_runner, seeded_db):
    r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "bogus",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] in ("E_INVALID_ARG", "E_INVALID_ARGUMENT")


def test_draft_forward_dry_run_plan(cli_runner, seeded_db):
    # forward + extra-to + body-file: plan 含 Fwd: 主题 + to=extra-to + reply_source=body-file
    import os
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".md")
    os.write(fd, b"please see forwarded message below")
    os.close(fd)
    try:
        r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "forward",
                    "--extra-to", "x@y.com", "--body-file", path, "--dry-run",
                    "-o", "json", db_path=seeded_db)
        data = _last_json(r.output)
        assert data["status"] == "success", r.output
        plan = data["data"]
        assert plan["mode"] == "forward"
        assert plan["to"] == ["x@y.com"]
        assert plan["subject"].startswith("Fwd:")
        assert plan["reply_source"] == "body-file"
    finally:
        os.unlink(path)


def test_draft_body_file_overrides_suggestion(cli_runner, seeded_db, monkeypatch):
    # --body-file 优先于 SQLite reply_suggestion_md
    import os
    import tempfile

    _bypass_auth(monkeypatch)
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    fake_backend = _FakeBackend()
    _patch_backend(monkeypatch, fake_backend)
    fd, path = tempfile.mkstemp(suffix=".md")
    os.write(fd, "用户编辑后的正文".encode("utf-8"))
    os.close(fd)
    try:
        r = _invoke(cli_runner, "email", "draft", "12345", "--body-file", path,
                    "-o", "json", db_path=seeded_db)
        data = _last_json(r.output)
        assert data["status"] == "success", r.output
        draft = fake_backend.appended[0]
        assert draft.reply_text == "用户编辑后的正文"
        assert _REPLY_MD not in (draft.reply_text or "")
    finally:
        os.unlink(path)


def test_draft_forward_dry_run_prefills_intro(cli_runner, seeded_db):
    # 前端打开转发面板: dry-run + 无 body + 无收件人 — plan 必须返回 forward_intro_html
    # 供 editor 预填。引用块 header 来自 record metadata, 与有无正文/收件人无关。
    r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "forward",
                "--dry-run", "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    plan = data["data"]
    assert plan["mode"] == "forward"
    assert plan["subject"].startswith("Fwd:")
    assert plan["forward_intro_html"] is not None
    assert "Forwarded message" in plan["forward_intro_html"]


def test_draft_forward_body_html_no_duplicate_intro(cli_runner, seeded_db, monkeypatch):
    # 前端转发发送/存草稿: editor HTML (经 --body-html-file) 已含预填引用块, _prepare_draft
    # 不该再单独构造 forward_intro — 否则 build_outgoing_mime 二次 append → 引用块重复。
    # 断言 DraftRequest.forward_intro_html/text 为空, reply_html = 用户正文 (含一份引用块)。
    import os
    import tempfile

    _bypass_auth(monkeypatch)
    fake_backend = _FakeBackend()
    _patch_backend(monkeypatch, fake_backend)
    fd, path = tempfile.mkstemp(suffix=".html")
    os.write(fd, b"<p>FYI</p><div>---------- Forwarded message ----------</div><p>orig</p>")
    os.close(fd)
    try:
        r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "forward",
                    "--to", "x@y.com", "--body-html-file", path,
                    "-o", "json", db_path=seeded_db)
        data = _last_json(r.output)
        assert data["status"] == "success", r.output
        draft = fake_backend.appended[0]
        assert draft.forward_intro_html is None
        assert draft.forward_intro_text is None
        # 用户正文里只有一份引用块
        assert (draft.reply_html or "").count("Forwarded message") == 1
    finally:
        os.unlink(path)


def test_draft_reply_includes_original_quote(cli_runner, seeded_db):
    # reply/reply-all dry-run: reply_html = LLM suggestion + 原邮件引用 (Mail.app/Outlook
    # 都会在回复正文下方附原文; 原邮件本身含整条线程, 故引一层即带全部历史)。
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "reply",
                "--dry-run", "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    plan = data["data"]
    # suggestion 在前, 原邮件引用在后 (回复引用头 "写道")
    assert "Sounds good" in plan["reply_html"]
    assert "写道" in plan["reply_html"]
    assert plan["reply_text"].startswith(_REPLY_MD)
    assert "写道" in plan["reply_text"]


def test_draft_reply_body_html_no_duplicate_quote(cli_runner, seeded_db, monkeypatch):
    # 前端回复发送: editor HTML (经 --body-html-file) 已含预填的 suggestion+引用,
    # _prepare_draft 不该再追加引用 (explicit_body 跳过) → reply_text 即用户正文原样。
    import os
    import tempfile

    _bypass_auth(monkeypatch)
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    fake_backend = _FakeBackend()
    _patch_backend(monkeypatch, fake_backend)
    fd, path = tempfile.mkstemp(suffix=".html")
    os.write(fd, "<p>我的回复</p><div>在 X 写道：</div><blockquote>原文</blockquote>".encode("utf-8"))
    os.close(fd)
    try:
        r = _invoke(cli_runner, "email", "draft", "12345", "--mode", "reply-all",
                    "--to", "x@y.com", "--body-html-file", path,
                    "-o", "json", db_path=seeded_db)
        data = _last_json(r.output)
        assert data["status"] == "success", r.output
        draft = fake_backend.appended[0]
        # 引用只有用户正文里的一份 (seeded body "body text" 不应被再次追加)
        assert "body text" not in (draft.reply_html or "")
        assert (draft.reply_html or "").count("写道") == 1
    finally:
        os.unlink(path)
