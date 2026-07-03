"""LlmService —— transport-neutral LLM 分类写操作 (A3: llm run)。

把 ``mailagent llm run`` 的「编排 + 守卫」从 CLI 命令体下沉到这里, 让 CLI (typer) 与
serve-api (FastAPI) 各自退化成「解析 → 调 service → 格式化」的薄壳, 不再 fork CLI 跨传输
复用 (见 plan cli-streamed-brook.md §A3 / docs/reference/architecture/backend-service-migration-matrix.md)。

``run`` 对单封邮件跑 LLM 分类 → 填 Notion AI 字段。dry_run 仍真跑 LLM (烧 token) 只是不
写 Notion —— 与 ``MailWriteService.plan_*`` 的「纯预览不烧资源」语义不同, 故 **无** plan_run。
返回的 ``LlmRunResult`` 字段与现 CLI ``emit`` 的 ``data`` 形状逐字段对齐
(parity golden: tests/cli/test_service_parity.py; schema: docs/cli-schema/llm-run.schema.json)。

backend 选择复刻 CLI ``_maybe_create_davmail_backend``: davmail 模式给 LLMRunner 一个
backend (走 IMAP fetch), applescript 模式 None (LLMRunner 内部 lazy-init AppleScriptArm)。
davmail 模式下 backend probe 失败**不吞** —— 冒泡成 ServiceLLMFailedError (E1 §3.1
Step 3: 防止静默回退到错 id 空间的 AppleScriptArm)。方法同步; serve-api 经
``asyncio.to_thread`` 调用 (``run_for_internal_id`` 是 async, service 内用
``asyncio.run`` 起独立 loop, 落在 worker 线程不撞 uvicorn loop)。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

from src.services.errors import ServiceLLMFailedError, ServiceNotFoundError
from src.services.guards import Actor, require_write_auth

if TYPE_CHECKING:
    from src.services.context import ServiceDeps


@dataclass
class LlmRunResult:
    """``run`` 执行结果 —— 对齐 ``llm_run`` emit 的 data (llm-run.schema.json)。"""

    internal_id: Optional[int]
    page_id: Optional[str]
    mailbox: Optional[str]
    dry_run: bool
    skipped: Optional[str]
    labels: Optional[dict[str, Any]]
    writer_summary: Optional[Any]
    stored_at: Optional[Any]


class LlmService:
    """LLM 分类写操作的应用服务 (A3 范围: run)。

    ``ctx`` 是 ``ServiceDeps`` (CliContext 或 ServiceContext 均满足) —— 经 ``ctx.config``
    拿 db_path / attachment_storage_dir / mailagent_backend, ``ctx.sync_store`` 供 davmail
    backend 构造。读 ``ctx.config`` 而非全局 ``src.config.config`` = 尊重各传输持有的 cfg
    (CLI ``--db-path`` override / serve-api import-time 单例)。
    """

    def __init__(self, ctx: "ServiceDeps") -> None:
        self._ctx = ctx

    def _maybe_davmail_backend(self):
        """davmail 模式返回 DavMailBackend (probe ok) 让 LLMRunner 走 IMAP fetch;
        applescript 模式返回 None (LLMRunner lazy-init AppleScriptArm)。

        复刻 CLI ``src/cli/commands/llm.py::_maybe_create_davmail_backend``, 但经
        ``ctx.config`` / ``ctx.sync_store`` 而非全局 cfg。

        E1 §3.1 Step 3: davmail 模式下 probe 失败**不再吞掉** — 直接冒泡给 run()
        的 try/except 转 ServiceLLMFailedError, 而不是静默回退到会用错 id 空间
        查询 (`whose id`) 的 AppleScriptArm。
        """
        cfg = self._ctx.config
        if getattr(cfg, "mailagent_backend", "applescript") != "davmail":
            return None
        from src.mail.backend.factory import create_backend

        return create_backend(cfg, sync_store=self._ctx.sync_store)

    def run(
        self,
        internal_id: int,
        *,
        dry_run: bool = False,
        force: bool = False,
        no_overwrite: bool = False,
        actor: Actor,
    ) -> LlmRunResult:
        """对单封邮件跑 LLM 分类 → 填 Notion AI 字段。搬自 ``llm_run`` 行 87-142 (行为保持)。

        dry_run=True 仍真跑 LLM 但不写 Notion → **不过** write auth (与 CLI
        ``if not dry_run: require_auth`` 一致); 执行路径过 ``require_write_auth(actor)``。
        llm run **不做** pm2 检测 (原 CLI 无 → 无 allow_concurrent)。``result.ok`` False 时按
        error 文案分流: "not found" / "notion_page_id empty" → NotFound, 否则 LLMFailed。
        """
        if not dry_run:
            require_write_auth(actor)

        from src.llm_agent.runner import LLMRunner

        cfg = self._ctx.config
        runner: Optional[LLMRunner] = None
        try:
            runner = LLMRunner(
                db_path=cfg.sync_store_db_path,
                attachment_storage_dir=cfg.attachment_storage_dir,
                backend=self._maybe_davmail_backend(),
            )
            result = asyncio.run(
                runner.run_for_internal_id(
                    internal_id,
                    dry_run=dry_run,
                    overwrite=not no_overwrite,
                    force=force,
                )
            )
        except Exception as e:  # pragma: no cover - 兜底网关/backend probe 意外异常
            raise ServiceLLMFailedError(
                f"LLMRunner unexpected error: {e!r}",
                hint="网关/依赖故障; 看 pm2 logs 或检查 LLM_API_KEY / LLM_API_BASE "
                "(davmail 模式下也可能是 backend probe 失败, 见异常详情)",
            ) from e
        finally:
            # runner.close() 是 async, 内部 try/except 不重试; asyncio.run 起独立 loop。
            # runner 可能因 backend probe 失败而未构造成功 (仍是 None) — 跳过 close。
            if runner is not None:
                try:
                    asyncio.run(runner.close())
                except Exception:
                    pass

        if not result.get("ok"):
            err = result.get("error") or "unknown LLM error"
            if "not found" in err.lower() or "notion_page_id empty" in err.lower():
                raise ServiceNotFoundError(
                    err,
                    hint="确认 internal_id 已 sync 到 Notion (notion_page_id != null)",
                )
            raise ServiceLLMFailedError(
                err,
                hint=f"retry_count={result.get('retry_count')} status={result.get('status')}",
            )

        return LlmRunResult(
            internal_id=result.get("internal_id"),
            page_id=result.get("page_id"),
            mailbox=result.get("mailbox"),
            dry_run=result.get("dry_run", dry_run),
            skipped=result.get("skipped"),
            labels=result.get("labels"),
            writer_summary=result.get("writer_summary"),
            stored_at=result.get("stored_at"),
        )

    def selftest(self) -> dict[str, Any]:
        """LLM gateway 健康检查 (不烧 token, 不写 Notion, 仅检 cfg)。

        搬自 ``llm_selftest`` (src/cli/commands/llm.py 行 139-165, 逻辑保持不变)。纯配置
        字段读取, 无 I/O / 副作用, 也不需要 ``Actor`` 鉴权 (镜像 CLI 该命令无 auth 的读
        语义)。unhealthy 不是异常 —— CLI 侧 ``emit`` 完 data 后另 ``raise typer.Exit(1)``
        是进程退出码语义, service 层没有这个概念, 直接把 data 返回给调用方判断。
        """
        cfg = self._ctx.config
        reasons: list[str] = []
        healthy = True
        if not cfg.llm_api_key:
            reasons.append("LLM_API_KEY is empty")
            healthy = False
        if not cfg.llm_api_base:
            reasons.append("LLM_API_BASE is empty")
            healthy = False
        if not cfg.llm_model:
            reasons.append("LLM_MODEL is empty")
            healthy = False

        fallback = [
            m.strip() for m in (cfg.llm_fallback_models or "").split(",") if m.strip()
        ]

        return {
            "healthy": healthy,
            "api_base": cfg.llm_api_base,
            "primary_model": cfg.llm_model,
            "fallback_chain": fallback,
            "llm_agent_enabled": cfg.llm_agent_enabled,
            "reasons": reasons,
        }
