"""Lazy single-task worker pool for local `stdio` MCP connectors (Phase 5 WP-5B.4).

Each `stdio` connector spawns at most one dedicated `asyncio.Task` on first
``list_tools`` or ``call_tool``. That single task enters BOTH
``stdio_client(StdioServerParameters(...))`` and ``mcp.Client(transport)`` and
serves queued requests sequentially until ``STDIO_IDLE_TTL_SECONDS`` elapses
without activity or explicit ``close_connector`` / ``close_all`` shutdown.

Keeping enter + use + exit strictly inside one ``asyncio.Task`` preserves
``anyio`` cancel-scope invariants across requests.
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass
from typing import Any, Optional

from loguru import logger

#: Idle timeout (seconds) after which an unused stdio subprocess is reaped.
STDIO_IDLE_TTL_SECONDS = 300.0

#: Longer default idle TTL (seconds) for interactive managed local runtimes
#: (`browser_use` / `desktop_use`) so browser/UI sessions are not reaped mid-task.
LONG_SESSION_STDIO_CONNECTORS: dict[str, float] = {
    "browser_use": 600.0,
    "desktop_use": 600.0,
}

#: Maximum pagination rounds when listing remote tools over stdio.
_LIST_TOOLS_MAX_PAGES = 20


def _default_idle_ttl() -> float:
    return STDIO_IDLE_TTL_SECONDS


@dataclass
class _StdioWorker:
    connector_id: str
    signature: tuple[Any, ...]
    loop: asyncio.AbstractEventLoop
    queue: "asyncio.Queue[Optional[tuple[str, Any, asyncio.Future[Any]]]]"
    idle_ttl: float
    task: Optional["asyncio.Task[None]"] = None


class StdioSessionPool:
    """Lazy, idle-reaping actor pool for local `stdio` MCP subprocesses."""

    def __init__(self, *, idle_ttl_seconds: Optional[float] = None) -> None:
        self._explicit_idle_ttl: Optional[float] = (
            float(idle_ttl_seconds)
            if idle_ttl_seconds is not None and float(idle_ttl_seconds) > 0
            else None
        )
        self._workers: dict[str, _StdioWorker] = {}

    def _effective_idle_ttl(
        self, connector_id: str, idle_ttl_seconds: Optional[float] = None
    ) -> float:
        if idle_ttl_seconds is not None:
            val = float(idle_ttl_seconds)
            if val > 0:
                return val
        if self._explicit_idle_ttl is not None:
            return self._explicit_idle_ttl
        return LONG_SESSION_STDIO_CONNECTORS.get(connector_id, _default_idle_ttl())

    @staticmethod
    def _signature(cmd: dict[str, Any], env: dict[str, str]) -> tuple[Any, ...]:
        command = str(cmd.get("command") or "").strip()
        args = tuple(str(a) for a in (cmd.get("args") or []))
        cwd = str(cmd["cwd"]).strip() if cmd.get("cwd") else None
        env_items = tuple(sorted((str(k), str(v)) for k, v in (env or {}).items()))
        return (command, args, cwd, env_items)

    async def _ensure_worker(
        self,
        connector_id: str,
        *,
        cmd: dict[str, Any],
        env: dict[str, str],
        timeout_seconds: Optional[float],
        idle_ttl_seconds: Optional[float] = None,
    ) -> _StdioWorker:
        from src.connectors.client import ConnectorError, ConnectorUnconfigured

        command = str(cmd.get("command") or "").strip()
        if not command:
            raise ConnectorUnconfigured(
                f"stdio connector {connector_id!r} has no command configured"
            )
        effective_ttl = self._effective_idle_ttl(connector_id, idle_ttl_seconds)
        sig = self._signature(cmd, env)
        loop = asyncio.get_running_loop()
        existing = self._workers.get(connector_id)
        if existing is not None:
            if (
                existing.loop is loop
                and existing.task is not None
                and not existing.task.done()
                and existing.signature == sig
            ):
                existing.idle_ttl = effective_ttl
                return existing
            if (
                existing.loop is loop
                and existing.task is not None
                and not existing.task.done()
            ):
                await self.close_connector(connector_id)
            else:
                self._workers.pop(connector_id, None)

        queue: asyncio.Queue[Optional[tuple[str, Any, asyncio.Future[Any]]]] = (
            asyncio.Queue()
        )
        ready_fut: asyncio.Future[None] = loop.create_future()
        params_dict = {
            "command": command,
            "args": [str(a) for a in (cmd.get("args") or [])],
            "cwd": str(cmd["cwd"]).strip() if cmd.get("cwd") else None,
            "env": dict(env) if env else None,
        }
        worker = _StdioWorker(
            connector_id=connector_id,
            signature=sig,
            loop=loop,
            queue=queue,
            idle_ttl=effective_ttl,
        )
        worker.task = loop.create_task(
            self._run_worker(
                connector_id,
                params_dict,
                queue,
                ready_fut,
                worker,
                timeout_seconds=timeout_seconds,
            ),
            name=f"mcp-stdio:{connector_id}",
        )
        self._workers[connector_id] = worker
        try:
            await ready_fut
        except Exception as exc:
            self._workers.pop(connector_id, None)
            if isinstance(exc, ConnectorError):
                raise
            raise ConnectorError(
                f"connector {connector_id} stdio launch failed: {exc}",
                code="E_CONNECTOR_NETWORK",
            ) from exc
        return worker

    async def _run_worker(
        self,
        connector_id: str,
        params_dict: dict[str, Any],
        queue: "asyncio.Queue[Optional[tuple[str, Any, asyncio.Future[Any]]]]",
        ready_fut: "asyncio.Future[None]",
        worker: _StdioWorker,
        *,
        timeout_seconds: Optional[float],
    ) -> None:
        from mcp import Client
        from mcp.client.stdio import StdioServerParameters, stdio_client
        from mcp.shared.exceptions import MCPError

        from src.connectors.client import ConnectorError

        params = StdioServerParameters(
            command=params_dict["command"],
            args=params_dict["args"],
            env=params_dict["env"],
            cwd=params_dict["cwd"],
        )
        transport = stdio_client(params, errlog=sys.stderr)
        try:
            async with Client(
                transport,
                read_timeout_seconds=timeout_seconds,
            ) as client:
                if not ready_fut.done():
                    ready_fut.set_result(None)
                while True:
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=worker.idle_ttl)
                    except asyncio.TimeoutError:
                        logger.debug(
                            "[stdio-pool] closing idle stdio connector {} (ttl={}s)",
                            connector_id,
                            worker.idle_ttl,
                        )
                        break
                    if item is None:
                        break
                    op, payload, fut = item
                    try:
                        if op == "list_tools":
                            tools_raw: list[Any] = []
                            cursor: Optional[str] = None
                            for _ in range(_LIST_TOOLS_MAX_PAGES):
                                page = await client.list_tools(cursor=cursor)
                                tools_raw.extend(page.tools)
                                cursor = page.next_cursor
                                if not cursor:
                                    break
                            res: Any = tools_raw
                        elif op == "call_tool":
                            tool_name, arguments = payload
                            res = await client.call_tool(tool_name, arguments or {})
                        else:
                            raise ValueError(f"unknown stdio op {op!r}")
                    except asyncio.CancelledError:
                        if not fut.done():
                            fut.set_exception(
                                ConnectorError(
                                    f"connector {connector_id} stdio request cancelled",
                                    code="E_CONNECTOR_TIMEOUT",
                                )
                            )
                        raise
                    except TimeoutError as exc:
                        if not fut.done():
                            fut.set_exception(
                                ConnectorError(
                                    f"connector {connector_id} stdio request timed out: {exc}",
                                    code="E_CONNECTOR_TIMEOUT",
                                )
                            )
                    except MCPError as exc:
                        if not fut.done():
                            fut.set_exception(
                                ConnectorError(
                                    f"connector {connector_id} MCP protocol error: {exc}",
                                    code="E_CONNECTOR_PROTOCOL",
                                )
                            )
                    except Exception as exc:  # noqa: BLE001 — fail request and tear down broken session
                        if not fut.done():
                            fut.set_exception(
                                ConnectorError(
                                    f"connector {connector_id} stdio error: {exc}",
                                    code="E_CONNECTOR_NETWORK",
                                )
                            )
                        break
                    else:
                        if not fut.done():
                            fut.set_result(res)
        except asyncio.CancelledError:
            if not ready_fut.done():
                ready_fut.set_exception(
                    ConnectorError(
                        f"connector {connector_id} stdio session cancelled",
                        code="E_CONNECTOR_TIMEOUT",
                    )
                )
            raise
        except MCPError as exc:
            if not ready_fut.done():
                ready_fut.set_exception(
                    ConnectorError(
                        f"connector {connector_id} MCP protocol error: {exc}",
                        code="E_CONNECTOR_PROTOCOL",
                    )
                )
        except BaseException as exc:  # noqa: BLE001
            err = ConnectorError(
                f"connector {connector_id} stdio process failed: {exc}",
                code="E_CONNECTOR_NETWORK",
            )
            if not ready_fut.done():
                ready_fut.set_exception(err)
            else:
                logger.warning("[stdio-pool] {} terminated: {}", connector_id, exc)
        finally:
            cur = self._workers.get(connector_id)
            if cur is not None and cur.queue is queue:
                self._workers.pop(connector_id, None)
            while not queue.empty():
                pending = queue.get_nowait()
                if pending is not None and not pending[2].done():
                    pending[2].set_exception(
                        ConnectorError(
                            f"connector {connector_id} stdio worker closed",
                            code="E_CONNECTOR_NETWORK",
                        )
                    )

    async def acquire(
        self,
        connector_id: str,
        *,
        cmd: dict[str, Any],
        env: dict[str, str],
        timeout_seconds: Optional[float] = None,
        idle_ttl_seconds: Optional[float] = None,
    ) -> _StdioWorker:
        """Ensure a pooled stdio worker is running for ``connector_id`` and refresh its idle TTL."""
        return await self._ensure_worker(
            connector_id,
            cmd=cmd,
            env=env,
            timeout_seconds=timeout_seconds,
            idle_ttl_seconds=idle_ttl_seconds,
        )

    async def _request(
        self,
        connector_id: str,
        op: str,
        payload: Any,
        *,
        cmd: dict[str, Any],
        env: dict[str, str],
        timeout_seconds: Optional[float] = None,
        idle_ttl_seconds: Optional[float] = None,
    ) -> Any:
        worker = await self._ensure_worker(
            connector_id,
            cmd=cmd,
            env=env,
            timeout_seconds=timeout_seconds,
            idle_ttl_seconds=idle_ttl_seconds,
        )
        fut: asyncio.Future[Any] = worker.loop.create_future()
        await worker.queue.put((op, payload, fut))
        return await fut

    async def list_tools(
        self,
        connector_id: str,
        *,
        cmd: dict[str, Any],
        env: dict[str, str],
        timeout_seconds: Optional[float] = None,
        idle_ttl_seconds: Optional[float] = None,
    ) -> list[Any]:
        return await self._request(
            connector_id,
            "list_tools",
            None,
            cmd=cmd,
            env=env,
            timeout_seconds=timeout_seconds,
            idle_ttl_seconds=idle_ttl_seconds,
        )

    async def call_tool(
        self,
        connector_id: str,
        tool_name: str,
        arguments: Optional[dict[str, Any]],
        *,
        cmd: dict[str, Any],
        env: dict[str, str],
        timeout_seconds: Optional[float] = None,
        idle_ttl_seconds: Optional[float] = None,
    ) -> Any:
        return await self._request(
            connector_id,
            "call_tool",
            (tool_name, arguments or {}),
            cmd=cmd,
            env=env,
            timeout_seconds=timeout_seconds,
            idle_ttl_seconds=idle_ttl_seconds,
        )

    def active_connector_ids(self) -> list[str]:
        """Inspection helper (tests/observability): returns connector ids with live workers."""
        return [
            cid
            for cid, w in self._workers.items()
            if w.task is not None and not w.task.done()
        ]

    def active_count(self) -> int:
        """Inspection helper (tests/observability): count of live pooled stdio workers."""
        return len(self.active_connector_ids())

    async def invalidate(self, connector_id: str) -> None:
        """Drop a pooled worker (e.g. on runtime mode switch or uninstall)."""
        await self.close_connector(connector_id)

    async def close_connector(self, connector_id: str) -> None:
        worker = self._workers.pop(connector_id, None)
        if worker is None or worker.task is None or worker.task.done():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is worker.loop:
            await worker.queue.put(None)
            try:
                await asyncio.wait_for(worker.task, timeout=5.0)
            except asyncio.TimeoutError:
                worker.task.cancel()
                try:
                    await worker.task
                except asyncio.CancelledError:
                    pass
            except Exception:  # noqa: BLE001
                pass
        elif worker.loop.is_running():
            worker.loop.call_soon_threadsafe(worker.queue.put_nowait, None)

    async def close_all(self) -> None:
        for cid in list(self._workers.keys()):
            await self.close_connector(cid)


stdio_pool = StdioSessionPool()
