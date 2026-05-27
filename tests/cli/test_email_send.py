"""CLI ``mailagent email send`` 测试 (真实发送, 复用 draft 构造).

二次确认: --yes 跳过; json 模式 (前端) 无 --yes 报 E_INVALID_ARG (确认 UI 留前端).
backend.send_email mock 成 fake, 不真连 SMTP.
"""
from __future__ import annotations

import json
import sqlite3
import time

import pytest

from tests.cli.conftest import extract_last_json_object as _last_json


def _invoke(cli_runner, *args, db_path):
    from src.cli.main import app
    return cli_runner.invoke(app, ["--db-path", str(db_path), *args])


@pytest.fixture(autouse=True)
def _set_user_email(monkeypatch):
    from src.config import config as cfg
    monkeypatch.setattr(cfg, "user_email", "me@mycorp.com")


def _seed_reply_suggestion(db_path, internal_id, reply_md):
    from src.llm_agent.store import LLMProcessingStore

    LLMProcessingStore(str(db_path))  # _init 建 llm_processing 表
    conn = sqlite3.connect(str(db_path))
    labels = {"reply_suggestion_md": reply_md}
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


class _FakeSendBackend:
    """fake IMailBackend: 只实现 send_email, 记录 DraftRequest."""

    def __init__(self, ok=True):
        self.sent = []
        self.ok = ok

    def send_email(self, draft):
        from src.mail.backend.types import SendResult
        self.sent.append(draft)
        if self.ok:
            return SendResult(
                success=True, message_id="<sent-1@mailagent.local>",
                method="smtp_davmail",
            )
        return SendResult(success=False, error="SMTP send failed: boom")


def _patch_backend(monkeypatch, fake):
    from src.mail.backend import factory as factory_mod
    monkeypatch.setattr(factory_mod, "create_backend", lambda *a, **k: fake)


def _bypass_auth(monkeypatch):
    monkeypatch.setattr("src.cli.context.CliContext.require_auth", lambda self: None)


_REPLY_MD = "Hi Alice,\n\nConfirmed, thanks."


def test_send_requires_yes_in_json_mode(cli_runner, seeded_db, monkeypatch):
    # 前端 (json) 无 --yes → E_INVALID_ARG, 不真发
    _bypass_auth(monkeypatch)
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    fake = _FakeSendBackend()
    _patch_backend(monkeypatch, fake)
    r = _invoke(cli_runner, "email", "send", "12345", "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    assert data["error"]["code"] in ("E_INVALID_ARG", "E_INVALID_ARGUMENT")
    assert fake.sent == []


def test_send_with_yes_invokes_backend(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    fake = _FakeSendBackend()
    _patch_backend(monkeypatch, fake)
    r = _invoke(cli_runner, "email", "send", "12345", "--yes",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "success", r.output
    assert data["data"]["sent"] is True
    assert data["data"]["message_id"] == "<sent-1@mailagent.local>"
    assert len(fake.sent) == 1
    assert "alice@example.com" in fake.sent[0].to


def test_send_backend_failure_surfaces_error(cli_runner, seeded_db, monkeypatch):
    _bypass_auth(monkeypatch)
    _seed_reply_suggestion(seeded_db, 12345, _REPLY_MD)
    fake = _FakeSendBackend(ok=False)
    _patch_backend(monkeypatch, fake)
    r = _invoke(cli_runner, "email", "send", "12345", "--yes",
                "-o", "json", db_path=seeded_db)
    data = _last_json(r.output)
    assert data["status"] == "error"
    msg = data["error"]["message"].lower()
    assert "失败" in data["error"]["message"] or "fail" in msg
