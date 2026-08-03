"""tests/memory 共享隔离 fixture。

`test_mem0_engine.py::test_build_config_shape` 经 `build_mem0_config()` →
`src.llm_agent.provider_routing.resolve_route()` 查真实 `agent_config.db` 的
`llm_provider` 表（legacy 无冒号 model ref 也会按 `provider_id='default'` 查一次）。
单独跑 `pytest tests/memory` 时若无人先设 `MAILAGENT_AGENT_CONFIG_DB_PATH`，会读到
开发机真实 provider registry 的 key（`cr_...` 前缀），与测试用的 `_fake_cfg()` 里
`"sk-test"` 断言冲突而红——与 `tests/api` 一起跑时被 `tests/api/conftest.py` 的
session 级隔离顺带掩盖，才没暴露。

镜像 `tests/api/conftest.py` 的隔离手法：在任何 `src.agent_config` /
`src.llm_agent.provider_routing` 被调用前把 env 钉到一个空临时库
（`os.environ.setdefault`——与其它 conftest 一起跑时谁先加载谁生效，反正都是没
seed 过的空库，互不冲突）。同时显式 reset 两处进程内单例缓存
（`get_llm_provider_store()` 的 `lru_cache` + `provider_routing` 自身 30s TTL 快照
缓存）：防止本 conftest 加载前已有代码把单例绑到旧路径，导致改 env 也不生效。
"""
from __future__ import annotations

import os
import tempfile
from typing import Iterator

import pytest

os.environ.setdefault(
    "MAILAGENT_AGENT_CONFIG_DB_PATH",
    os.path.join(
        tempfile.mkdtemp(prefix="mailagent-test-memory-agentcfg-"), "agent_config.db"
    ),
)


@pytest.fixture(autouse=True)
def _isolated_provider_registry_cache() -> Iterator[None]:
    """清 provider registry 的两处进程内单例缓存，确保上面的 env 隔离真正生效。"""
    from src.agent_config.llm_providers import reset_llm_provider_store_cache
    from src.llm_agent.provider_routing import reset_provider_route_cache

    reset_llm_provider_store_cache()
    reset_provider_route_cache()
    yield
    reset_llm_provider_store_cache()
    reset_provider_route_cache()
