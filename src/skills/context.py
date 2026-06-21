"""SkillContext —— handler 拿领域依赖的注入点（lazy，与 deps.py 同纪律）。

skills 层 transport-neutral：不 import fastapi / cli。依赖（EmailRepository /
ReportStore / ServiceContext / Config / CalendarService）经本 context 懒构造，REST 路由与
MCP in-process client 共用一份。lazy import config → 裸 worktree（无 .env）import skills
不崩，只在真实调用时构造。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from src.config import Config
    from src.reports.store import ReportStore
    from src.repository import EmailRepository
    from src.services.context import ServiceContext


class SkillContext:
    """handler(ctx, params) 的 ctx。各依赖懒构造 + 进程内缓存（只持 db_path，WAL 安全）。"""

    def __init__(
        self,
        *,
        repository: Optional["EmailRepository"] = None,
        report_store: Optional["ReportStore"] = None,
        config: Optional["Config"] = None,
    ) -> None:
        self._repo = repository
        self._report_store = report_store
        self._config = config
        self._service_ctx: Optional["ServiceContext"] = None
        # invoke_skill 在 dispatch 前写入本次调用的 confirm 标志（发信/草稿 handler 据此把
        # 真实 confirm 透传给 service 二次校验，而非硬编码 True —— 防御纵深，见 invoke.py）。
        self.confirm: bool = False

    def config(self) -> "Config":
        if self._config is None:
            from src.config import config as _config_singleton

            self._config = _config_singleton
        return self._config

    def repo(self) -> "EmailRepository":
        if self._repo is None:
            from src.repository import EmailRepository

            self._repo = EmailRepository(db_path=self.config().sync_store_db_path)
        return self._repo

    def report_store(self) -> "ReportStore":
        if self._report_store is None:
            from src.reports.store import ReportStore

            self._report_store = ReportStore(db_path=self.config().sync_store_db_path)
        return self._report_store

    def service_ctx(self) -> "ServiceContext":
        # 每次新建（NotionSync httpx client 绑 event loop，per-call 隔离，见 deps.get_service_ctx）。
        from src.services.context import ServiceContext

        return ServiceContext(self.config())

    def calendar_service(self) -> Any:
        from src.calendar_sync.service import CalendarService

        cfg = self.config()
        return CalendarService(db_path=cfg.sync_store_db_path, cfg=cfg)
