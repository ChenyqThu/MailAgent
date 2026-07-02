"""CliContext - CLI 进程内的依赖注入 + 长寿命对象集中点 (RFC v2 §6.3).

US-002 完整实现；US-001 阶段只用到 from_flags 工厂（其他属性 lazy-init 不会触发）。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.backend.base import IMailBackend
    from src.mail.sync_store import SyncStore
    from src.notion.sync import NotionSync
    from src.repository import EmailRepository


@dataclass
class CliContext:
    """长寿命对象集中点。lazy-init 但每个进程一次。"""

    output: str = "text"
    quiet: bool = False
    verbose: bool = False
    db_path: Optional[str] = None
    api_key: Optional[str] = None
    config_path: Optional[str] = None
    no_color: bool = False

    # lazy-init caches
    _email_repo: Optional["EmailRepository"] = None
    _sync_store: Optional["SyncStore"] = None
    _notion_sync: Optional["NotionSync"] = None
    _cli_config: Optional["Config"] = None
    _backend: Optional["IMailBackend"] = None
    _started_at: float = field(default_factory=time.monotonic)

    @classmethod
    def from_flags(
        cls,
        *,
        output: str = "text",
        quiet: bool = False,
        verbose: bool = False,
        db_path: Optional[str] = None,
        api_key: Optional[str] = None,
        config_path: Optional[str] = None,
        no_color: bool = False,
    ) -> "CliContext":
        """从 typer @app.callback() 的 flags 构造。"""
        from src.cli.config import load_cli_config

        ctx = cls(
            output=output,
            quiet=quiet,
            verbose=verbose,
            db_path=db_path,
            api_key=api_key,
            config_path=config_path,
            no_color=no_color,
        )
        # 注意: ``--api-key`` flag 是用户**提供**的 token (落在 ``ctx.api_key``),
        # **不是**服务端 expected token。expected 只读 env/.env 中的
        # ``MAILAGENT_CLI_API_KEY``, 见 src/cli/auth.py:require_auth。
        ctx._cli_config = load_cli_config(
            config_path=config_path,
            flag_overrides={
                "sync_store_db_path": db_path,
            },
        )
        # PR-3 round-6 fix (codex critic 2nd-pass blocker): 进程内的 LLM / Notion /
        # AppleScript 下游链 (AIFieldsWriter / NotionClient / AppleScriptArm /
        # PromptLoader / LLM client) 读 import-time 的全局 ``src.config.config``,
        # 不直接消费 CliContext。这导致 ``mailagent --config other.env llm run ...``
        # 时 LLM/Notion/Mail account 读老 .env. 修法: 把 CLI-scoped cli_config
        # 的字段 push 到全局 cfg 实例上 (mutable BaseSettings), 让下游模块自然
        # 拿到 CLI override。CLI 单进程单次调用, 全局 mutation 可接受。
        _sync_global_cfg_from_cli(ctx._cli_config)
        return ctx

    # ============================================================
    # Properties — 延迟实例化后端依赖（避免 --help / --version 强加载 SQLite）
    # ============================================================

    @property
    def cli_config(self) -> "Config":
        if self._cli_config is None:  # pragma: no cover - from_flags 已注入
            from src.cli.config import load_cli_config
            self._cli_config = load_cli_config()
        return self._cli_config

    @property
    def config(self) -> "Config":
        """``ServiceDeps.config`` 别名 → ``cli_config`` (只读)。

        让 CliContext 结构上满足 ``src/services/context.py::ServiceDeps`` 新增的
        ``config`` 契约: service 层 (A3 ``LlmService``) 经 ``ctx.config`` 拿
        ``attachment_storage_dir`` / ``mailagent_backend`` 等, 而非直接读全局
        ``src.config.config`` —— 这样测试注入的 CLI-scoped cfg (``--db-path`` /
        ``--config`` override) 被尊重 (ServiceContext 同理持有自己的 cfg)。
        """
        return self.cli_config

    @property
    def email_repo(self) -> "EmailRepository":
        if self._email_repo is None:
            from src.repository import AttachmentStore, EmailRepository

            cfg = self.cli_config
            self._email_repo = EmailRepository(
                db_path=cfg.sync_store_db_path,
                attachment_store=AttachmentStore(cfg.attachment_storage_dir),
            )
        return self._email_repo

    @property
    def sync_store(self) -> "SyncStore":
        if self._sync_store is None:
            from src.mail.sync_store import SyncStore

            cfg = self.cli_config
            self._sync_store = SyncStore(cfg.sync_store_db_path)
        return self._sync_store

    @property
    def backend(self) -> "IMailBackend":
        """Mail backend (davmail / applescript), lazy-init via factory.

        关键: 走 factory 保证尊重 `MAILAGENT_BACKEND=davmail` env, 而不是硬编码
        AppleScriptArm — 避免 CLI 命令意外唤起 Mail.app GUI.

        backend 自身即 IMailBackend Protocol 面 (E1 契约收口), 直接调
        ``fetch_email_content_by_id(internal_id, mailbox)`` 等方法.
        """
        if self._backend is None:
            from src.mail.backend.factory import create_backend

            self._backend = create_backend(self.cli_config, self.sync_store)
        return self._backend

    @property
    def notion_sync(self) -> "NotionSync":
        if self._notion_sync is None:
            from src.notion.sync import NotionSync

            self._notion_sync = NotionSync(
                email_repo=self.email_repo,
                sync_store=self.sync_store,
            )
        return self._notion_sync

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self._started_at) * 1000)

    # ============================================================
    # Auth (US-002 完成；US-001 不会用到)
    # ============================================================

    def require_auth(self) -> None:
        from src.cli import auth

        auth.require_auth(self)


def _sync_global_cfg_from_cli(cli_config) -> None:
    """把 CLI-scoped ``cli_config`` 字段 push 到全局 ``src.config.config``.

    PR-3 round-6 修复 (codex critic 2nd-pass blocker #1): 让下游模块 (LLMRunner /
    AIFieldsWriter / NotionClient / AppleScriptArm / PromptLoader / LLM client) 中
    那些读 module-level ``cfg`` 的代码自动拿到 ``--config`` / ``--db-path`` 等
    flag override, 不需要每条 caller 单独 thread Config 实例.

    CLI 单进程单次调用, 全局 mutation 可接受; 服务模式 (main.py / pm2) 不受影响,
    因为它们走 import-time 加载的 .env, 从不调 from_flags.
    """
    from src.config import config as _global_cfg

    try:
        fields = cli_config.model_fields
    except AttributeError:  # pydantic v1 fallback (defensive)
        return
    for field_name in fields:
        try:
            new_val = getattr(cli_config, field_name)
        except Exception:
            continue
        try:
            setattr(_global_cfg, field_name, new_val)
        except Exception:
            # Frozen / immutable fields — 忽略, 这些不影响 CLI 主流程
            pass
