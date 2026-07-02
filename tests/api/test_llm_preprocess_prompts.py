"""GET /api/llm/preprocess-prompts — mailbox 分类 prompt 文件只读展示（#8-ext, v1.1.0 dogfood）。

供 Agents 页预处理配置抽屉的「分类 Prompt 查看器」：读 LLM_INBOX_PROMPT_PATH /
LLM_SENT_PROMPT_PATH 两个 .md 文件，缺文件 graceful（exists:false，不 500）。
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Iterator

import pytest
from fastapi.testclient import TestClient

import src.api.routers.llm as llm_router
from src.api.app import app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _stub_settings(monkeypatch, inbox_path: str, sent_path: str) -> None:
    monkeypatch.setattr(
        llm_router,
        "get_settings",
        lambda: SimpleNamespace(
            llm_inbox_prompt_path=inbox_path, llm_sent_prompt_path=sent_path
        ),
    )


def test_preprocess_prompts_reads_both_files(client, monkeypatch, tmp_path):
    inbox = tmp_path / "inbox.md"
    inbox.write_text("# 收件箱规则\n优先看发件人", encoding="utf-8")
    sent = tmp_path / "sent.md"
    sent.write_text("# 发件箱规则", encoding="utf-8")
    _stub_settings(monkeypatch, str(inbox), str(sent))

    r = client.get("/api/llm/preprocess-prompts")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["inbox"]["exists"] is True
    assert "收件箱规则" in data["inbox"]["text"]
    assert data["sent"]["exists"] is True
    assert data["sent"]["path"].endswith("sent.md")


def test_preprocess_prompts_missing_file_graceful(client, monkeypatch, tmp_path):
    _stub_settings(monkeypatch, str(tmp_path / "nope.md"), "")

    r = client.get("/api/llm/preprocess-prompts")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["inbox"]["exists"] is False
    assert data["inbox"]["text"] == ""
    # 路径未配置 → path 空、exists false（不 abspath 空串）
    assert data["sent"] == {"path": "", "exists": False, "text": ""}


def test_preprocess_prompts_truncates_huge_file(client, monkeypatch, tmp_path):
    big = tmp_path / "big.md"
    big.write_text("x" * (llm_router._PROMPT_VIEW_MAX_CHARS + 100), encoding="utf-8")
    _stub_settings(monkeypatch, str(big), "")

    r = client.get("/api/llm/preprocess-prompts")
    assert r.status_code == 200
    text = r.json()["data"]["inbox"]["text"]
    assert text.endswith("…(truncated)")
    assert len(text) < llm_router._PROMPT_VIEW_MAX_CHARS + 50
