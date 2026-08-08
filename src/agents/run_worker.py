"""``AgentRunWorker`` —— custom agent headless run 的执行外壳（S4 W2, ADR D1/D2/D4）。

形状抄 ``src/sync/job_worker.py``（asyncio 主循环 + stop_event + 串行, 并发=1），但**不跑**
并发=1 也天然满足 per-agent 串行；若未来提高并发，必须先加 per-agent 锁。
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

from src.agents.run_state import derive_agent_run_state
from src.agents.trigger import Budget, parse_budget

if TYPE_CHECKING:
    from src.reports.store import ReportStore
    from src.sync.async_jobs import AsyncJob, AsyncJobRepository

# gateway loopback 默认端口（与 ai_gateway_proxy._resolve_gateway_port / config.ts 同源）。
_DEFAULT_AI_GATEWAY_PORT = 8300
# serve-api loopback 默认端口（island announce 端点所在；同 island_agent.resolve_api_port）。
_DEFAULT_SERVE_API_PORT = 8200
# httpx 总超时 = spec.maxRunSeconds + 余量（drain 有界，超时兜底防 worker 卡死）。
_HTTP_MARGIN_SEC = 30
_CONNECT_TIMEOUT_SEC = 10.0
# 岛通知短连接超时（fire-and-forget 语义，失败不阻断 job 终态）。
_ANNOUNCE_TIMEOUT_SEC = 5.0


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
        """跑单个 agent_run：set token → poke → 映射终态 → 岛结果通知。**绝不悬挂 running**（全路径写终态）。"""
        job_id = job.job_id
        status = "failed"
        result: Optional[dict] = None
        last_error: Optional[str] = None
        try:
            claim_token = secrets.token_urlsafe(32)
            self.repo.set_claim_token(job_id, claim_token)
            timeout_s = self._resolve_timeout(job)
            try:
                resp = await self._poke_gateway(job_id, claim_token, timeout_s)
                status, result, last_error = self._map_response(resp)
            except _GatewayPokeError as exc:
                status, result, last_error = "failed", None, exc.code
        except Exception as exc:  # noqa: BLE001 — 兜底：任何未预期异常也不留 running
            logger.error(f"[agent-run-worker] execute crash job_id={job_id}: {exc}", exc_info=True)
            status, result, last_error = "failed", None, f"E_WORKER_CRASH: {type(exc).__name__}"
        self._mark(job_id, status, result=result, last_error=last_error)
        # 终态落库后推灵动岛「运行结果」通知（completed/error）。绝不放在 _mark 前（通知失败不得
        # 影响 job 终态）、也不放进 _mark（那是纯 DB 写, 无 agent/触发源上下文）。终态已落库，
        # 通知是 best-effort：整体兜一层，任何未预期异常都不得逃出 _execute 杀死 worker 主循环
        # （run() 不 guard _execute，靠此处「自身吞尽异常」契约）。
        try:
            await self._announce_terminal(job, status, result, last_error)
        except Exception as exc:  # noqa: BLE001 — 通知路径绝不影响 job 终态 / worker 存活
            logger.warning(f"[agent-run-worker] announce_terminal crash job_id={job_id}: {exc}")

    def _mark(
        self, job_id: int, status: str, *, result: Optional[dict] = None, last_error: Optional[str] = None
    ) -> None:
        try:
            self.repo.mark_terminal(job_id, status=status, result=result, last_error=last_error)
        except Exception as exc:  # noqa: BLE001 — mark 失败只 log（下轮 recover 兜底不了本条, 但不杀 worker）
            logger.error(f"[agent-run-worker] mark_terminal failed job_id={job_id}: {exc}")
        self._stats[status] = self._stats.get(status, 0) + 1

    # ── 灵动岛「运行结果」通知（S5 W1, ADR-004 P7）──────────────────────────────────

    async def _announce_terminal(
        self, job: "AsyncJob", status: str, result: Optional[dict], last_error: Optional[str]
    ) -> None:
        """终态后推灵动岛「运行结果」通知（completed/error）。**通知失败仅 warning 绝不影响 job 终态**。

        读态经 ``derive_agent_run_state`` 单源判定（P6）：``completed`` → kind=completed；``failed``
        → kind=error；``paused_*`` → **不发**（审批卡链路已 announce，防双卡）。POST loopback serve-api
        ``/api/island/agent/announce``（本地 token）；端点自身双 flag（island_agent_enabled +
        ping_island_enabled）no-op 语义在服务端保持不变（此处不重复门控，off 时端点静默 no-op）。
        """
        now = self.now_fn()
        try:
            state = derive_agent_run_state(
                {"status": status, "result": result, "finished_at": now, "updated_at": now},
                now_fn=self.now_fn,
            )
        except Exception:  # noqa: BLE001 — 读态推导失败 → 保守不发
            return
        if state == "completed":
            kind = "completed"
        elif state == "failed":
            kind = "error"
        else:
            return  # paused_* → 审批链路已 announce, 不重发
        agent_id = str((job.params or {}).get("agent_id") or job.target_key or "")
        title, summary = self._announce_text(job, agent_id, kind, result, last_error)
        session_id = self._session_id_of(result)
        try:
            await self._post_announce(kind, session_id, title, summary)
        except Exception as exc:  # noqa: BLE001 — 通知失败绝不影响 job 终态（已在 _mark 落库）
            logger.warning(f"[agent-run-worker] island announce failed job_id={job.job_id}: {exc}")

    def _announce_text(
        self, job: "AsyncJob", agent_id: str, kind: str, result: Optional[dict], last_error: Optional[str]
    ) -> tuple[str, str]:
        """岛卡 title/summary：title=「{agent 名} · {触发源}」；summary=结果摘要 / 错误码。"""
        name = self._agent_title(agent_id) or agent_id or "Agent"
        trigger_kind = str((job.params or {}).get("trigger_kind") or "")
        trigger_label = {
            "cron": "定时",
            "email_filter": "邮件",
            "calendar_event_change": "日历变化",
            "calendar_before_start": "会前",
            "manual": "手动",
        }.get(
            trigger_kind, trigger_kind or "触发"
        )
        title = f"{name} · {trigger_label}"
        if kind == "completed":
            summary = str((result or {}).get("summary") or "").strip() or "运行已完成"
        else:
            summary = (last_error or "").strip() or "运行失败"
        return title, summary

    def _agent_title(self, agent_id: str) -> Optional[str]:
        """从 report_agent 行取 title（岛卡展示用）。读失败/无 title → None（回退 agent_id）。"""
        if not agent_id or self.store is None:
            return None
        try:
            row = self.store.get_agent(agent_id)
            return ((row.get("title") or "").strip() or None) if row else None
        except Exception:  # noqa: BLE001 — title 读失败不阻断通知
            return None

    @staticmethod
    def _session_id_of(result: Optional[dict]) -> int:
        """result_json 里的 sessionId（岛卡关联）；缺失/非法 → 0（通知类卡不强依赖真 session）。"""
        try:
            return int((result or {}).get("sessionId") or 0)
        except (TypeError, ValueError):
            return 0

    async def _post_announce(self, kind: str, session_id: int, title: str, summary: str) -> None:
        """POST serve-api ``/api/island/agent/announce``（loopback + 本地 token, 沿 island.py 纪律）。"""
        url = f"http://127.0.0.1:{self._serve_api_port()}/api/island/agent/announce"
        payload = {"kind": kind, "sessionId": session_id, "title": title, "summary": summary}
        headers = {}
        token = os.environ.get("MAILAGENT_LOCAL_API_TOKEN", "").strip()
        if token:
            headers["X-MailAgent-Local-Token"] = token
        async with httpx.AsyncClient(timeout=_ANNOUNCE_TIMEOUT_SEC) as client:
            await client.post(url, json=payload, headers=headers)

    @staticmethod
    def _serve_api_port() -> int:
        """serve-api loopback 端口（env MAILAGENT_API_PORT，缺省/非法 → 8200）——同 island_agent.resolve_api_port。"""
        raw = os.environ.get("MAILAGENT_API_PORT")
        if raw is None:
            return _DEFAULT_SERVE_API_PORT
        try:
            n = int(raw)
        except (TypeError, ValueError):
            return _DEFAULT_SERVE_API_PORT
        return n if n > 0 else _DEFAULT_SERVE_API_PORT

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
        """从 gateway 响应挑 sessionId/steps/outcome/summary/usage 透传进 result_json。

        🔴 读侧纪律（ADR D4, codex P1-4）：这里透传的 ``outcome='paused_handoff'``（配合
        _map_response 补写的 ``approval_state='pending'``）意味着 ``status=succeeded`` 的行
        **永不得渲染为「成功完成」** —— 任何展示面只允许经 ``src/agents/run_state.py``
        ``derive_agent_run_state`` 读态（expired 亦在彼处按龄推导, 不写库）。
        """
        out: dict[str, Any] = {}
        for key in ("sessionId", "steps", "outcome", "summary", "usage", "approvalTtlSec"):
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
