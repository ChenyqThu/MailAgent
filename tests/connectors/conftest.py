"""connector 单元测试的共用夹具。

🔴 `MAILAGENT_AGENT_CONFIG_DB_PATH` 必须**在 import 期**就钉到 tmp：08-05 WP-12 起
`registry.get_connector_def` 会读 `connector` 行（行优先、目录兜底），没钉住的话单测会去摸
开发机真库（甚至在裸 worktree 上 seed 一个 ./data/agent_config.db 出来）。镜像
`tests/api/conftest.py` 的同款 import-time setdefault。
"""

from __future__ import annotations

import os
import tempfile

os.environ.setdefault(
    "MAILAGENT_AGENT_CONFIG_DB_PATH",
    os.path.join(tempfile.mkdtemp(prefix="mailagent-test-connectors-"), "agent_config.db"),
)

import pytest  # noqa: E402


@pytest.fixture()
def fresh_agent_cfg(tmp_path, monkeypatch):
    """每测试一个干净 agent_config.db（覆盖 env + reset 单例）——镜像 tests/api 的同名夹具。"""
    from src.agent_config import store as acstore

    monkeypatch.setenv("MAILAGENT_AGENT_CONFIG_DB_PATH", str(tmp_path / "agent_config.db"))
    acstore.reset_agent_config_store_cache()
    yield acstore.get_agent_config_store()
    acstore.reset_agent_config_store_cache()
