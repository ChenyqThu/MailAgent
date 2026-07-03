"""``AgentRunWorker`` —— custom agent headless run 的执行外壳（S4 W2, ADR D1/D2/D4）。

形状抄 ``src/sync/job_worker.py``（asyncio 主循环 + stop_event + 串行, 并发=1），但**不跑**
tool loop —— 它只 claim + poke，真正的多轮 tool loop 在 gateway 路径 C（W3）：

    claim_next(AGENT_JOB_TYPES) → set_claim_token(能力令牌) → POST gateway /api/ai/agent-run
    {jobId, claimToken}（poke，不带权威事实）→ gateway 回拉 spec（本 wave 的 /api/agent-runs/
    {id}/spec CAS one-shot）→ drain → 同步响应 {ok,outcome,...} → 映射 async_jobs 终态。

🔴 绝不悬挂 running：任何路径（gateway 未起 / 超时 / 连接拒绝 / 非 2xx / 坏响应 / 未预期异常）
都收敛到结构化 ``failed`` + last_error（``E_GATEWAY_DOWN`` / ``E_RUN_TIMEOUT`` / gateway 错误码
透传）。gateway 端点 W3 才存在——本 wave 全靠 mock httpx 测；真实环境连不上 → E_GATEWAY_DOWN。

并发=1（V1 全局串行 = 天然 per-agent 串行）；孤儿回收走 ``recover_orphaned_agents``（仅 agent
族，不碰维护 job → 无 JobWorker 竞态）。flag ``MAILAGENT_CUSTOM_AGENTS_ENABLED`` 门控启动（off
→ service.py 零启动）。
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import time
from typing import TYPE_CHECKING, Any, Callable, Optional

import httpx
from loguru import logger

from src.agents.trigger import Budget, parse_budget

if TYPE_CHECKING:
    from src.reports.store import ReportStore
    from src.sync.async_jobs import AsyncJob, AsyncJobRepository

# gateway loopback 默认端口（与 ai_gateway_proxy._resolve_gateway_port / config.ts 同源）。
_DEFAULT_AI_GATEWAY_PORT = 8300
# httpx 总超时 = spec.maxRunSeconds + 余量（drain 有界，超时兜底防 worker 卡死）。
_HTTP_MARGIN_SEC = 30
_CONNECT_TIMEOUT_SEC = 10.0


class _GatewayPokeError(Exception):
    """poke gateway 失败的结构化载体（code → async_jobs.last_error）。"""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class AgentRunWorker:
    """agent_run 串行执行主循环（认领 → poke gateway → 写终态）。"""

    def __init__(
        self,
        *,
        repo: "AsyncJobRepository",
        store: "ReportStore",
        poll_interval_sec: int = 5,
        now_fn: Callable[[], float] = time.time,
    ):
        self.repo = repo
        self.store = store
        self.poll_interval_sec = poll_interval_sec
        self.now_fn = now_fn
        self._stop_event = asyncio.Event()
        self._stats = {"claimed": 0, "succeeded": 0, "failed": 0}

    @property
    def stats(self) -> dict:
        return dict(self._stats)

    def stop(self) -> None:
        """请求主循环退出（in-flight poke 跑完即止；下轮不再 claim）。"""
        self._stop_event.set()

    async def run(self) -> None:
        """主循环. 调用方 asyncio.create_task(worker.run())."""
        recovered = self.repo.recover_orphaned_agents()
        logger.info(
            f"[agent-run-worker] starting poll_interval={self.poll_interval_sec}s "
            f"(failed {recovered} orphaned agent_run job(s))"
        )
        while not self._stop_event.is_set():
            try:
                job = self.repo.claim_next(types=self.repo.AGENT_JOB_TYPES)
            except Exception as exc:  # noqa: BLE001 — claim 异常不杀 worker
                logger.error(f"[agent-run-worker] claim crash: {exc}", exc_info=True)
                job = None

            if job is not None:
                self._stats["claimed"] += 1
                await self._execute(job)  # 自身吞尽异常, 恒写终态（下方保证）
                continue  # claim 到 → 立即下一轮（可能还有 queued）

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self.poll_interval_sec)
            except asyncio.TimeoutError:
                continue

        logger.info(f"[agent-run-worker] stopped. stats={self._stats}")

    async def _execute(self, job: "AsyncJob") -> None:
        """跑单个 agent_run：set token → poke → 映射终态。**绝不悬挂 running**（全路径写终态）。"""
        job_id = job.job_id
        try:
            claim_token = secrets.token_urlsafe(32)
            self.repo.set_claim_token(job_id, claim_token)
            timeout_s = self._resolve_timeout(job)
            try:
                resp = await self._poke_gateway(job_id, claim_token, timeout_s)
            except _GatewayPokeError as exc:
                self._mark(job_id, "failed", last_error=exc.code)
                return
            status, result, last_error = self._map_response(resp)
            self._mark(job_id, status, result=result, last_error=last_error)
        except Exception as exc:  # noqa: BLE001 — 兜底：任何未预期异常也不留 running
            logger.error(f"[agent-run-worker] execute crash job_id={job_id}: {exc}", exc_info=True)
            self._mark(job_id, "failed", last_error=f"E_WORKER_CRASH: {type(exc).__name__}")

    def _mark(
        self, job_id: int, status: str, *, result: Optional[dict] = None, last_error: Optional[str] = None
    ) -> None:
        try:
            self.repo.mark_terminal(job_id, status=status, result=result, last_error=last_error)
        except Exception as exc:  # noqa: BLE001 — mark 失败只 log（下轮 recover 兜底不了本条, 但不杀 worker）
            logger.error(f"[agent-run-worker] mark_terminal failed job_id={job_id}: {exc}")
        self._stats[status] = self._stats.get(status, 0) + 1

    # ── poke gateway ──────────────────────────────────────────────────────────────

    async def _poke_gateway(self, job_id: int, claim_token: str, timeout_s: float) -> dict:
        """POST gateway /api/ai/agent-run（poke）→ 返回其 JSON 响应。失败抛 ``_GatewayPokeError``。"""
        url = f"{self._gateway_base()}/api/ai/agent-run"
        payload = {"jobId": job_id, "claimToken": claim_token}
        timeout = httpx.Timeout(timeout_s, connect=_CONNECT_TIMEOUT_SEC)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload)
        except httpx.TimeoutException as exc:
            raise _GatewayPokeError("E_RUN_TIMEOUT") from exc
        except httpx.HTTPError as exc:  # connect refused / DNS / 传输错误 → gateway 未起
            raise _GatewayPokeError("E_GATEWAY_DOWN") from exc
        if resp.status_code != 200:
            raise _GatewayPokeError(
                self._error_code_from(resp, f"E_GATEWAY_HTTP_{resp.status_code}")
            )
        try:
            body = resp.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise _GatewayPokeError("E_GATEWAY_BAD_RESPONSE") from exc
        if not isinstance(body, dict):
            raise _GatewayPokeError("E_GATEWAY_BAD_RESPONSE")
        return body

    def _map_response(self, resp: dict) -> tuple[str, dict, Optional[str]]:
        """gateway {ok, outcome, sessionId, steps, summary?, usage?, error?} → 终态映射（ADR D4）。

        - completed        → succeeded
        - paused_handoff   → succeeded + result.approval_state='pending'（「等审批」≠「成功完成」，
                             读侧凭 approval_state 区分；UI/API 纪律见 ADR D4）
        - error / ok=false → failed + last_error（透传 gateway error 码）
        """
        outcome = resp.get("outcome")
        result = self._result_json(resp)
        if bool(resp.get("ok")) and outcome == "completed":
            return "succeeded", result, None
        if bool(resp.get("ok")) and outcome == "paused_handoff":
            result["approval_state"] = "pending"
            return "succeeded", result, None
        err = resp.get("error") or "E_RUN_ERROR"
        return "failed", result, str(err)

    @staticmethod
    def _result_json(resp: dict) -> dict:
        """从 gateway 响应挑 sessionId/steps/outcome/summary/usage 透传进 result_json。"""
        out: dict[str, Any] = {}
        for key in ("sessionId", "steps", "outcome", "summary", "usage"):
            val = resp.get(key)
            if val is not None:
                out[key] = val
        return out

    @staticmethod
    def _error_code_from(resp: httpx.Response, fallback: str) -> str:
        """从 gateway 非 2xx 响应体抽 error 码（{error:'E_...'} 或 envelope {error:{code}}）→ 透传。"""
        try:
            body = resp.json()
        except (ValueError, json.JSONDecodeError):
            return fallback
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, str) and err:
                return err
            if isinstance(err, dict) and err.get("code"):
                return str(err["code"])
        return fallback

    def _resolve_timeout(self, job: "AsyncJob") -> float:
        """httpx 总超时 = agent budget 的 max_run_seconds + 余量。agent 缺失/坏 budget → 默认预算。"""
        budget = Budget()
        agent_id = (job.params or {}).get("agent_id")
        if agent_id and self.store is not None:
            try:
                row = self.store.get_agent(agent_id)
                if row:
                    budget = parse_budget(row.get("budget_json"))
            except Exception as exc:  # noqa: BLE001 — budget 读失败退默认, 不阻断
                logger.debug(f"[agent-run-worker] budget read failed agent={agent_id}: {exc}")
        return budget.max_run_seconds + _HTTP_MARGIN_SEC

    def _gateway_base(self) -> str:
        return f"http://127.0.0.1:{self._gateway_port()}"

    @staticmethod
    def _gateway_port() -> int:
        """gateway loopback 端口（env MAILAGENT_AI_GATEWAY_PORT，缺省/非法 → 8300）。

        🔴 同源 ``src/api/routers/ai_gateway_proxy._resolve_gateway_port`` —— 同形抄写（避免
        worker 依赖 FastAPI router 模块）；两处必须解析出同一端口（= backend_lifecycle 注入的 env）。
        """
        raw = os.environ.get("MAILAGENT_AI_GATEWAY_PORT")
        if raw is None:
            return _DEFAULT_AI_GATEWAY_PORT
        try:
            n = int(raw)
        except (TypeError, ValueError):
            return _DEFAULT_AI_GATEWAY_PORT
        return n if n > 0 else _DEFAULT_AI_GATEWAY_PORT
