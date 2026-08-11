"""P6-B D3/D17：全局 Matter Agent 任务契约 —— DB 行有值就用它，否则回落代码默认。"""

from __future__ import annotations

import pytest

from src.matters import run_spec


class _Doc:
    def __init__(self, content: str) -> None:
        self.content = content


class _Store:
    def __init__(self, content: str | None) -> None:
        self._content = content

    def get_profile_doc(self, name, *, seed_if_absent=True):
        if self._content is None:
            raise KeyError(f"profile doc not found: {name}")
        return _Doc(self._content)


@pytest.fixture
def patch_store(monkeypatch):
    def _apply(content: str | None):
        import src.agent_config.store as store_module

        monkeypatch.setattr(store_module, "get_agent_config_store", lambda: _Store(content))

    return _apply


def test_falls_back_to_builtin_contract_when_row_absent(patch_store):
    """从没编辑过 == 跟随代码默认（而不是被一份历史快照冻住）。"""
    patch_store(None)
    assert run_spec._task_contract() == run_spec._TASK_CONTRACT


def test_falls_back_when_row_is_blank(patch_store):
    """空内容就是「恢复默认」的表示法。"""
    patch_store("   \n  ")
    assert run_spec._task_contract() == run_spec._TASK_CONTRACT


def test_custom_contract_replaces_builtin_rather_than_appending(patch_store):
    """🔴 替换不是拼接 —— 拼接会让同一份准则出现两遍。"""
    patch_store("【任务契约】只做我说的这件事。")
    contract = run_spec._task_contract()
    assert contract == "【任务契约】只做我说的这件事。"
    assert "matter_update_propose" not in contract


def test_unreadable_store_does_not_break_the_run(monkeypatch):
    """配置库读不出来时跟进 run 仍要能跑 —— 自定义 prompt 是可选项。"""
    import src.agent_config.store as store_module

    def _boom():
        raise RuntimeError("agent_config.db is locked")

    monkeypatch.setattr(store_module, "get_agent_config_store", _boom)
    assert run_spec._task_contract() == run_spec._TASK_CONTRACT


def test_matter_agent_doc_is_not_part_of_standing_identity():
    """🔴 它绝不能进 PROFILE_DOC_NAMES —— 那 4 份是恒注入每次对话的可信身份，
    把跟进任务契约塞进去会污染所有普通对话。"""
    from src.agent_config.store import (
        MATTER_AGENT_DOC_NAME,
        PROFILE_DOC_NAMES,
        STORABLE_DOC_NAMES,
    )

    assert MATTER_AGENT_DOC_NAME not in PROFILE_DOC_NAMES
    assert MATTER_AGENT_DOC_NAME in STORABLE_DOC_NAMES


def test_matter_agent_doc_has_no_seed_template():
    """没有 seed 模板才能让"行内容为空"成为回落信号。"""
    from src.agent_config.store import MATTER_AGENT_DOC_NAME
    from src.agent_config.templates import SEED_TEMPLATES

    assert MATTER_AGENT_DOC_NAME not in SEED_TEMPLATES
