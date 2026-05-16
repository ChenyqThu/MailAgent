"""CliContext - CLI 进程内的依赖注入 + 长寿命对象集中点 (RFC v2 §6.3).

US-002 完整实现；US-001 阶段只用到 from_flags 工厂（其他属性 lazy-init 不会触发）。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from src.config import Config
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
