"""P2-L3 B —— ``POST /agent/policy/evaluate`` 上的资料库免卡通道端到端（design §5.3）。

单测钉的是判据（tests/agent_config/test_policy_library.py），这里钉的是**接线**：路由真的把
``file_id`` 经 LibraryService 反查成虚拟路径再交给 policy，而不是拿模型给的 path 当真。

fixtures 全合成（假 LibraryService，零磁盘 / 零 PII）。
"""

from __future__ import annotations

import pytest


class _FakeLibraryService:
    """只实现 policy 反查用到的那一个方法。"""

    def __init__(self, rows: dict[int, dict]):
        self.rows = rows
        self.calls: list[list[int]] = []

    def files(self, file_ids):
        self.calls.append(list(file_ids))
        return [self.rows[i] for i in file_ids if i in self.rows]


@pytest.fixture()
def fake_library(monkeypatch):
    def _install(rows):
        import src.api.routers.library as library_router

        svc = _FakeLibraryService(rows)
        monkeypatch.setattr(library_router, "get_library_service", lambda: svc)
        return svc

    return _install


def _row(path: str, *, status: str = "present"):
    return {"id": 7, "path": path, "status": status}


def _evaluate(client, action, mode="cron_headless"):
    resp = client.post(
        "/api/agent/policy/evaluate",
        json={"capability": "domain_write", "action": action, "contextMode": mode},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def test_append_to_agent_docs_auto_allows_through_the_endpoint(client, fresh_agent_cfg, fake_library):
    svc = fake_library({7: _row("agent-docs/atlas/log.md")})
    data = _evaluate(client, {"tool": "library_append", "file_id": 7, "size_bytes": 42})
    assert data == {"decision": "auto_allow", "rule_id": None}
    assert svc.calls == [[7]], "file_id 必须真的经 LibraryService 反查"


def test_floor_overwrite_of_a_my_docs_file_asks_even_with_a_forged_path(
    client, fresh_agent_cfg, fake_library
):
    """🔴 地板：模型塞的 path 不作数 —— 反查出来的真实路径在 my-docs ⇒ 弹卡。"""
    fake_library({7: _row("my-docs/private.md")})
    data = _evaluate(
        client,
        {"tool": "library_write", "file_id": 7, "path": "agent-docs/looks-fine.md", "size_bytes": 42},
    )
    assert data == {"decision": "ask", "rule_id": None}


def test_floor_trashed_row_asks(client, fresh_agent_cfg, fake_library):
    """地板：非 present 的行反查不出路径 ⇒ 弹卡。"""
    fake_library({7: _row("agent-docs/atlas/log.md", status="trashed")})
    data = _evaluate(client, {"tool": "library_append", "file_id": 7, "size_bytes": 42})
    assert data == {"decision": "ask", "rule_id": None}


def test_floor_library_service_failure_asks(client, fresh_agent_cfg, monkeypatch):
    """地板：资料库读不了（库锁 / 未初始化）→ 弹卡，不 500。"""
    import src.api.routers.library as library_router

    def _boom():
        raise RuntimeError("library.db unavailable")

    monkeypatch.setattr(library_router, "get_library_service", _boom)
    data = _evaluate(client, {"tool": "library_append", "file_id": 7, "size_bytes": 42})
    assert data == {"decision": "ask", "rule_id": None}


def test_floor_manual_chat_asks(client, fresh_agent_cfg, fake_library):
    fake_library({7: _row("agent-docs/atlas/log.md")})
    data = _evaluate(
        client, {"tool": "library_append", "file_id": 7, "size_bytes": 42}, mode="manual_chat"
    )
    assert data == {"decision": "ask", "rule_id": None}


@pytest.mark.parametrize("tool", ["library_move", "library_delete"])
def test_floor_move_and_delete_ask(client, fresh_agent_cfg, fake_library, tool):
    fake_library({7: _row("agent-docs/atlas/log.md")})
    data = _evaluate(client, {"tool": tool, "file_id": 7, "size_bytes": 0})
    assert data == {"decision": "ask", "rule_id": None}


def test_non_domain_write_capability_never_touches_the_library(client, fresh_agent_cfg, monkeypatch):
    """非 domain_write 的评估一趟 LibraryService 都不建（构造它要开 library.db）。"""
    import src.api.routers.library as library_router

    def _boom():
        raise AssertionError("get_library_service must not be called for capability=web")

    monkeypatch.setattr(library_router, "get_library_service", _boom)
    resp = client.post(
        "/api/agent/policy/evaluate",
        json={
            "capability": "web",
            "action": {"origin": "https://example.com"},
            "contextMode": "cron_headless",
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == {"decision": "ask", "rule_id": None}
