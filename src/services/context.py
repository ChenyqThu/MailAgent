"""ServiceContext —— 应用服务层的依赖容器。

持有 service 方法要编排的长寿命领域对象 (EmailRepository / SyncStore / NotionSync
/ backend),lazy-init 每进程一次。两类消费者:

  - **CLI**: ``CliContext`` 已暴露同名的 ``email_repo`` / ``sync_store`` /
    ``notion_sync`` / ``backend`` 属性,**结构上满足** ``ServiceDeps``,故 CLI 适配器
    直接把 ``CliContext`` 传给 service —— 这样保住了现有测试的依赖注入点
    (``ctx._sync_store = mock``,见 tests/cli/test_long_task*.py)。
  - **FastAPI / 独立进程**: 直接 ``ServiceContext(config)`` (见 src/api/deps.py)。

两者共用同一份 service 代码而不互相耦合。``ServiceContext`` 的 lazy 体与
``CliContext`` 对应属性一致 (有意的小幅重复,换取不动 CliContext = 零注入风险)。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional, Protocol, runtime_checkable

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.backend.base import IMailBackend
    from src.mail.sync_store import SyncStore
    from src.notion.sync import NotionSync
    from src.repository import EmailRepository


@runtime_checkable
class ServiceDeps(Protocol):
    """service 层依赖的结构化契约。``ServiceContext`` 与 ``CliContext`` 都满足它。"""

    @property
    def config(self) -> "Config": ...

    @property
    def email_repo(self) -> "EmailRepository": ...

    @property
    def sync_store(self) -> "SyncStore": ...

    @property
    def notion_sync(self) -> "NotionSync": ...

    @property
    def backend(self) -> "IMailBackend": ...


class ServiceContext:
    """非 CLI 传输用的具体 ``ServiceDeps``。lazy-init 镜像 ``CliContext`` 的属性体。"""

    def __init__(self, config: "Config") -> None:
        self._config = config
        self._email_repo: Optional["EmailRepository"] = None
        self._sync_store: Optional["SyncStore"] = None
        self._notion_sync: Optional["NotionSync"] = None
        self._backend: Optional["IMailBackend"] = None

    @property
    def config(self) -> "Config":
        return self._config

    @property
    def email_repo(self) -> "EmailRepository":
        if self._email_repo is None:
            from src.repository import AttachmentStore, EmailRepository

            self._email_repo = EmailRepository(
                db_path=self._config.sync_store_db_path,
                attachment_store=AttachmentStore(self._config.attachment_storage_dir),
            )
        return self._email_repo

    @property
    def sync_store(self) -> "SyncStore":
        if self._sync_store is None:
            from src.mail.sync_store import SyncStore

            self._sync_store = SyncStore(self._config.sync_store_db_path)
        return self._sync_store

    @property
    def backend(self) -> "IMailBackend":
        """Mail backend (davmail / applescript) via factory —— 尊重
        ``MAILAGENT_BACKEND`` env,避免意外唤起 Mail.app GUI (同 CliContext.backend)。"""
        if self._backend is None:
            from src.mail.backend.factory import create_backend

            self._backend = create_backend(self._config, self.sync_store)
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
