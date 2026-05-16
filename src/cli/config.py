"""CLI 配置 factory — 不依赖 src.config import-time singleton (RFC v2 §5.4 / C9).

priority: --flag > env (MAILAGENT_*) > config_path .env > 默认 .env
"""

from __future__ import annotations

import os
from typing import Optional

from src.config import Config


def load_cli_config(
    config_path: Optional[str] = None,
    env_overrides: Optional[dict] = None,
    flag_overrides: Optional[dict] = None,
) -> Config:
    """Build a fresh Config instance respecting CLI flag/env/file priority.

    与 ``from src.config import config`` 全局 singleton 不同：
    后者在 ``import`` 时已固定 .env，CLI 的 ``--config x.toml`` flag 无法覆盖。
    这个 factory 让 CLI 起独立实例。

    Args:
        config_path: ``--config`` flag 指定的 env 文件路径；空则用 ``.env``。
        env_overrides: 来自 ``MAILAGENT_*`` 环境变量的覆盖 (key 已转 attr 名)。
        flag_overrides: 来自 CLI 长 flag 的覆盖 (key 已转 attr 名)。

    Returns:
        Config 实例（pydantic Settings）。
    """
    env_file = config_path or os.environ.get("MAILAGENT_CONFIG") or ".env"
    base = Config(_env_file=env_file)  # type: ignore[call-arg]
    for key, value in (env_overrides or {}).items():
        if value is not None:
            setattr(base, key, value)
    for key, value in (flag_overrides or {}).items():
        if value is not None:
            setattr(base, key, value)
    return base
