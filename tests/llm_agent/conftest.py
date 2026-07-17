"""tests/llm_agent 域 fixtures —— provider registry 隔离 + api 鉴权导入兜底。

背景（主仓 cwd 下 4 条测试确定性失败、干净 worktree / CI / 全量 `pytest tests` 通过）：

1. **provider registry 泄漏**：主仓 ``data/agent_config.db`` 是 dev 期真实 registry 库
   （含 seed 的 default provider 行）。``LLMClient.classify`` 先走
   ``provider_routing.resolve_route``——主仓 cwd 下解析出真实 ProviderRoute → 走 per-provider
   真实客户端路径，这些测试注入在 legacy ``client._client`` / ``client._http`` 上的 fake 不被
   使用 → anthropic SDK streaming 内部断言挂 / openai 腿 fake.requests 为空 IndexError。
   干净树 ``resolve_route`` 返回 None 走 legacy 路径故过；全量跑时前置 fixture 顺序掩盖。
   → 下面 autouse fixture 把 ``MAILAGENT_AGENT_CONFIG_DB_PATH`` 钉到 per-test 空 tmp 库 +
   重置 store/route 双缓存，让 ``resolve_route`` 对 legacy 裸 id 恒返回 None（走 legacy 腿）。
   自 seed registry 的用例（test_provider_routing.py 的「route 命中」测试）有自己的
   ``_isolated`` autouse fixture（同键 env，per-test 覆盖本 fixture）→ 照常工作、不受影响。

2. **api 鉴权导入**：test_provider_routing.py::test_url_contract_across_runtime_and_probe_faces
   在函数体内 ``from src.api.routers.llm_providers import ...`` → 触发 ``src.api.app`` →
   ``src.api.auth``，后者在 import 时若「一种鉴权方式都没配、也没声明 dev bypass」即 RuntimeError。
   全量 ``pytest tests`` 下 ``tests/api/conftest.py`` 在 collection 期 setdefault 了这些 env
   （src.api.* import 前），隔离跑 tests/llm_agent 时无人设 → import 即挂。
   → 镜像 tests/api/conftest.py 的 import-time setdefault（模块级，collection 期即生效）。
"""

from __future__ import annotations

import os

import pytest

# --- MUST run before any src.api.* import (import-time env reads) -------------
# src/api/auth.py 在 import 时 fail-closed：未配 CF_AUDIENCE / MAILAGENT_LOCAL_API_TOKEN
# 且未声明 dev bypass → RuntimeError。test_url_contract 在函数体 import api router 会触发它。
# 镜像 tests/api/conftest.py：auth bypass **仅 dev 允许**，测试套件即 dev/CI 上下文。
os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")

# test_url_contract 函数体内 ``from src.api.routers.llm_providers import ...`` 会先加载
# 该 router 模块，其顶层 ``from src.api.app import APIError`` → src.api.app 尾部
# ``app.include_router(llm_providers.router)`` 反过来引用尚在初始化的 router 模块 → 循环
# import AttributeError。正常 app 启动 / 全量 `pytest tests` 下 src.api.app 先被导入（按序
# include 全部 router），故无此问题。这里在设好鉴权 env 后**先**把 src.api.app 导入一遍，
# 让导入图按正确顺序落定（镜像 tests/api/conftest.py 的 `from src.api.app import app`）。
from src.api.app import app as _app  # noqa: E402,F401 — 仅预热导入图，避免循环 import


@pytest.fixture(autouse=True)
def _isolate_llm_provider_registry(monkeypatch, tmp_path):
    """把 provider registry（agent_config.db）钉到 per-test 空 tmp 库 + 重置双缓存。

    保证本域测试永不对着 dev 机真实 ``data/agent_config.db`` 解析路由——那会把
    ``classify`` 送去 per-provider 真实客户端腿、绕过测试注入的 fake。空库下
    ``resolve_route`` 对 legacy 裸 id 返回 None（走 legacy 腿），带冒号显式 ref 抛
    ProviderRouteError（各测试自行断言）。

    test_provider_routing.py 的「route 命中」用例自带 ``_isolated`` autouse fixture
    （设同一 env 键到自己的 tmp 库并自行 seed），per-test 覆盖本 fixture，照常工作。
    """
    from src.agent_config import llm_providers
    from src.llm_agent import provider_routing as pr

    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    llm_providers.reset_llm_provider_store_cache()
    pr.reset_provider_route_cache()
    yield
    llm_providers.reset_llm_provider_store_cache()
    pr.reset_provider_route_cache()
