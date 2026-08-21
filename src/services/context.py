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

import threading
from typing import TYPE_CHECKING, Optional, Protocol, runtime_checkable

if TYPE_CHECKING:
    from src.config import Config
    from src.mail.backend.base import IMailBackend
    from src.mail.sync_store import SyncStore
    from src.notion.sync import NotionSync
    from src.repository import EmailRepository


# ── backend 进程级单例 (task 08-20-perf-draft-delete) ──────────────────────────
# serve-api 的 ServiceContext 是 per-request 的 (NotionSync httpx client 绑 event
# loop, 见 src/api/deps.py::get_service_ctx), 但 backend 跟着 per-request 重建 =
# 每个写请求都 create_backend() → probe_readiness() (两次 IMAP 连接 + drafts/sent
# SPECIAL-USE 探测, 实测 1.3-3.6s, 占删草稿端到端 43-65%)。
#
# DavMailBackend 可以安全进程级共享:
#   - 同步 imaplib, 不绑 event loop (NotionSync 的隔离理由对它不成立);
#   - IMAP 连接不是实例状态 —— 每个操作 `with imap_session(...)` 独立开/关,
#     asyncio.to_thread 并发下线程间不共享连接;
#   - 跨调用的实例状态只有已探测的文件夹名 (drafts/sent, probe 一次后稳定) 与
#     latency/marker 数值缓存, 并发写幂等。
# mail-sync (serve) 进程的 watcher backend 不经这里 (main 启动序列直调
# create_backend), 生命周期不变。
#
# 语义即模块级 @lru_cache, 但 Config (pydantic) / SyncStore 不可哈希 → 手写
# dict + lock, 按 (backend 名, db 路径) key: serve-api 全程同一 config 单例 →
# 进程内恰一个 backend; 测试各自 tmp db → 天然隔离互不串。probe 失败不缓存
# (异常上抛), 下个请求重试 — 与 per-request 时代的自愈行为一致。首建持锁:
# 并发首请求串行化, 只跑一次 probe。
_process_backends: dict[tuple[str, str], "IMailBackend"] = {}
_process_backends_lock = threading.Lock()


def _process_backend(config: "Config", sync_store: "SyncStore") -> "IMailBackend":
    key = (
        str(getattr(config, "mailagent_backend", "applescript")),
        str(getattr(config, "sync_store_db_path", "")),
    )
    with _process_backends_lock:
        backend = _process_backends.get(key)
        if backend is None:
            from src.mail.backend.factory import create_backend

            backend = create_backend(config, sync_store)
            _process_backends[key] = backend
        return backend


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
        """Mail backend (davmail / applescript) via 进程级单例工厂 —— 尊重
        ``MAILAGENT_BACKEND`` env,避免意外唤起 Mail.app GUI (同 CliContext.backend)。

        task 08-20: ctx 本身 per-request (NotionSync loop 隔离), 但 backend 经
        ``_process_backend`` 进程级复用 —— 砍掉每写请求的 create_backend +
        probe_readiness 慢链 (1.3-3.6s), 惠及删草稿/归档/移动等全部写端点。"""
        if self._backend is None:
            self._backend = _process_backend(self._config, self.sync_store)
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
