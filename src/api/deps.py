"""FastAPI 依赖注入 — EmailRepository + config 单例。

设计依据: REMOTE-ACCESS §3.2 (deps.py 职责) + 实现规格 serve_api_note。

约束 (实现规格 gotcha #13 WAL concurrency):
  - EmailRepository 每次调用 open 一个短命连接 (timeout=30) 再 close，与 mail-sync
    writer 在 WAL 模式下并发安全。**不要**在 API 进程里 hold 长命写连接。
  - 因此这里把 EmailRepository 做成 **轻量单例**: repo 对象本身无状态 (只持 db_path)，
    真正的 sqlite 连接是 per-call 的 (见 email_repository._connect)，共享一个 repo 实例零风险。
  - config 复用 main venv 的 import-time 单例 (src.config.config)，由 MAILAGENT_ENV_FILE /
    SYNC_STORE_DB_PATH 等 env 决定 db 路径 (serve-api 与 serve 进程读同一个 db)。

**lazy import 纪律** (与 CLI src/cli/config.py 一致): src.config 在 import 期就执行
``config = Config()``，缺 5 个必填 env (NOTION_TOKEN 等) 会 ValidationError。为让
``import src.api.deps`` / ``import src.api.app`` 在没有 .env 的裸 worktree 里也能成功
(测试 / CI / 框架自检)，这里**不在模块顶层** import config 单例 —— 只在 get_settings /
get_repository 被实际调用时 (= 真实请求到来，运行环境已有 .env) 才触发。
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 仅类型提示，运行期不 import (避免裸 worktree import 即 Config())
    from src.config import Config
    from src.repository import EmailRepository


def get_settings() -> "Config":
    """返回 main venv 的 config 单例 (pydantic Settings)。

    FastAPI ``Depends(get_settings)`` 用。复用 import-time 单例而非每次新建，
    与 mail-sync / CLI 行为一致 (同一份 .env → 同一份 db_path)。

    lazy: 在调用点才 import src.config，避免模块加载即构造 Config() (缺 .env 时
    会 ValidationError)。
    """
    from src.config import config as _config_singleton

    return _config_singleton


@lru_cache(maxsize=1)
def _build_repository() -> "EmailRepository":
    """构造 EmailRepository 单例 (lazy, 进程内只建一次)。

    repo 实例只持 db_path，无活跃连接 — 真正的 sqlite 连接是 per-call 短命的，
    所以单例与 mail-sync writer 在 WAL 下并发安全 (实现规格 gotcha #13)。
    """
    from src.config import config as _config_singleton
    from src.repository import EmailRepository

    return EmailRepository(db_path=_config_singleton.sync_store_db_path)


def get_repository() -> "EmailRepository":
    """返回进程内 EmailRepository 单例。

    FastAPI ``Depends(get_repository)`` 用。所有读端点经此拿 repo，统一 db_path 来源。
    """
    return _build_repository()
