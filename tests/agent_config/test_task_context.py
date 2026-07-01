"""issue #31/#32 Part2 增量1 — 身份注入 helper 契约（零 LLM / 零真实库）。

build_task_identity_context 是 reports / llm 分类 / digest 的共用注入点：
- flag off / 无内容 → 返回 ""（调用点 prepend "" = 字节级回退到 Part1 通用 prompt）；
- 有内容 → 拼成 "## User identity ...\\n\\n<doc>\\n\\n" 块；
- seed_if_absent=False → 缺失文档跳过、绝不从后台写库。
"""

from __future__ import annotations

from types import SimpleNamespace

from src.agent_config import task_context


class _FakeStore:
    def __init__(self, docs: dict[str, str]) -> None:
        self._docs = docs

    def get_profile_doc(self, name, *, seed_if_absent=True):
        assert seed_if_absent is False, "后台任务必须只读、不得触发 seed 写库"
        if name not in self._docs:
            raise KeyError(name)
        return SimpleNamespace(content=self._docs[name])


def _patch(monkeypatch, *, enabled: bool, docs: dict[str, str]) -> None:
    monkeypatch.setattr(
        task_context, "cfg", SimpleNamespace(task_identity_docs_enabled=enabled)
    )
    monkeypatch.setattr(
        "src.agent_config.get_agent_config_store", lambda: _FakeStore(docs)
    )


def test_injects_soul_and_user(monkeypatch):
    _patch(
        monkeypatch,
        enabled=True,
        docs={"soul": "# SOUL\nZane 的助手", "user": "# USER\n偏好简洁"},
    )
    out = task_context.build_task_identity_context()
    assert out.startswith("## User identity")
    assert "Zane 的助手" in out
    assert "偏好简洁" in out
    assert out.endswith("\n\n")


def test_flag_off_returns_empty(monkeypatch):
    _patch(monkeypatch, enabled=False, docs={"soul": "# SOUL\nZane"})
    assert task_context.build_task_identity_context() == ""


def test_empty_or_whitespace_docs_return_empty(monkeypatch):
    _patch(monkeypatch, enabled=True, docs={"soul": "   ", "user": ""})
    assert task_context.build_task_identity_context() == ""


def test_missing_doc_skipped_without_write(monkeypatch):
    # user 缺失（KeyError, seed_if_absent=False）→ 只注入 soul，不抛、不写库
    _patch(monkeypatch, enabled=True, docs={"soul": "# SOUL\nonly soul"})
    out = task_context.build_task_identity_context()
    assert "only soul" in out
    assert "偏好" not in out


def test_unknown_doc_names_filtered(monkeypatch):
    _patch(monkeypatch, enabled=True, docs={"soul": "# SOUL\nx"})
    # 非法 doc 名被 PROFILE_DOC_NAMES 过滤，不报错、不查库
    out = task_context.build_task_identity_context(doc_names=["soul", "bogus"])
    assert "# SOUL" in out
