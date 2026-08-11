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


def _matter_agent_flags_on() -> bool:
    """matter_followup 执行前 pre-flight 热读（D11：matters AND matter_agent）。

    读 pydantic 单例（重启生效语义与 flag 文档一致）；import/读失败 → fail-closed False
    （job 收敛 failed E_DISABLED，不悬挂）。测试经 monkeypatch 本函数控制。
    """
    try:
        from src.config import config

        return bool(config.matters_enabled) and bool(
            getattr(config, "matter_agent_enabled", False)
        )
    except Exception:  # noqa: BLE001 — 配置不可用 → 保守当 off
        return False


class AgentRunWorker:
    """agent_run / matter_followup 串行执行主循环（认领 → poke gateway → 写终态）。

    P4 泛化：构造器不再硬依赖 ``ReportStore`` 类型 —— title/timeout 经注入的
    resolver 取（缺省 resolver 复用 store 的既有逻辑，report 路径行为字节级不变）；
    ``_execute`` 按 ``job.job_type`` 分派（``matter_followup`` → ``_execute_matter``，
    含 flag pre-flight / 便宜比对 noop 短路 / started CAS / 终态四值映射）。
    """

    def __init__(
        self,
        *,
        repo: "AsyncJobRepository",
        store: Optional["ReportStore"] = None,
        poll_interval_sec: int = 5,
        now_fn: Callable[[], float] = time.time,
        title_resolver: Optional[Callable[["AsyncJob"], Optional[str]]] = None,
        timeout_resolver: Optional[Callable[["AsyncJob"], float]] = None,
    ):
        self.repo = repo
        self.store = store
        self.poll_interval_sec = poll_interval_sec
        self.now_fn = now_fn
        self._title_resolver = title_resolver or self._default_title_resolver
        self._timeout_resolver = timeout_resolver or self._default_timeout_resolver
        self._matter_service_cache = None
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
        self._recover_matter_runs()
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
        if job.job_type == "matter_followup":
            await self._execute_matter(job)
            return
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

    # ── matter_followup 分派（Matters P4, D3/D4）────────────────────────────────

    def _matter_service(self):
        """惰性构造 ``MatterRunService``（repo 同 db 文件；连接 per-call 短命）。"""
        if self._matter_service_cache is None:
            from src.matters.repository import MatterRepository
            from src.matters.run_service import MatterRunService

            self._matter_service_cache = MatterRunService(
                MatterRepository(str(self.repo.db_path))
            )
        return self._matter_service_cache

    def _recover_matter_runs(self) -> None:
        """启动扫尾：failed/aborted 的 matter_followup job 反查 matter_run 收敛 fail。"""
        try:
            self._matter_service().recover_orphaned_runs()
        except Exception as exc:  # noqa: BLE001 — 扫尾失败不阻断 worker 启动
            logger.warning(f"[agent-run-worker] matter orphan sweep failed: {exc}")

    async def _execute_matter(self, job: "AsyncJob") -> None:
        """matter_followup：flag pre-flight → 便宜比对（noop 短路不 poke）→ started CAS
        → poke→map 链 → 终态四值映射（ok/noop/warn/fail + canceled）。

        **绝不悬挂**：任何路径同时收敛 async job 终态 + matter_run 终态。
        """
        job_id = job.job_id
        params = job.params or {}
        run_id = params.get("matter_run_id")
        try:
            svc = self._matter_service()
            if not isinstance(run_id, int):
                self._mark(job_id, "failed", last_error="E_MATTER_RUN_MISSING")
                return
            if not _matter_agent_flags_on():
                # flag off → fail-closed（terminal，不悬挂；D11）。
                svc.finish_run(run_id, "fail", error={"code": "E_DISABLED"})
                self._mark(job_id, "failed", last_error="E_DISABLED")
                return
            run = svc.get_run(run_id)
            matter_id = params.get("matter_id")
            if run is None or run.get("matter_id") != matter_id:
                self._mark(job_id, "failed", last_error="E_MATTER_RUN_MISSING")
                return
            if run.get("canceled_at") is not None or run.get("completed_at") is not None:
                # 已被取消/终态（cancel 竞态窗）→ job 收敛 aborted，不再执行。
                self._mark(
                    job_id, "aborted",
                    result={"outcome": "stopped", "reason": "run_already_terminal"},
                )
                return
            # ① 便宜比对（D4）：无差异 → noop，不 poke gateway、零 LLM token。
            current = svc.current_watermark(int(matter_id))
            from src.matters.run_service import watermark_diff

            baseline_source = svc.last_output_watermark(
                int(matter_id), exclude_run_id=run_id
            )
            diff = watermark_diff(baseline_source, current)
            if not diff["changed"]:
                svc.finish_run(run_id, "noop", output_watermark=current)
                self._mark(job_id, "succeeded", result={"outcome": "noop"})
                return
            metadata_only = svc.touched_all_metadata_only(
                int(matter_id), diff.get("touched_resources") or []
            )
            # ② started CAS（撞 uq_matter_run_one_active → E_RUN_ACTIVE；run 一并收敛
            # fail —— 留着 queued 会永久堵住后续 enqueue 的单活跃检查）。
            if not svc.mark_started(run_id):
                svc.finish_run(run_id, "fail", error={"code": "E_RUN_ACTIVE"})
                self._mark(job_id, "failed", last_error="E_RUN_ACTIVE")
                return
            # ③ 既有 poke→map 链（spec 由 gateway 回拉，_assemble_spec 按 job_type 分派）。
            claim_token = secrets.token_urlsafe(32)
            self.repo.set_claim_token(job_id, claim_token)
            timeout_s = self._resolve_timeout(job)
            try:
                resp = await self._poke_gateway(job_id, claim_token, timeout_s)
            except _GatewayPokeError as exc:
                self._finish_matter_transport_failure(svc, run_id, job_id, exc.code)
                return
            self._map_matter_response(
                svc, run_id, job_id, resp,
                output_watermark=current, metadata_only=metadata_only,
            )
        except Exception as exc:  # noqa: BLE001 — 兜底：不留 running/queued 悬挂
            logger.error(
                f"[agent-run-worker] matter execute crash job_id={job_id}: {exc}",
                exc_info=True,
            )
            try:
                if isinstance(run_id, int):
                    self._matter_service().finish_run(
                        run_id, "fail",
                        error={"code": f"E_WORKER_CRASH: {type(exc).__name__}"},
                    )
            except Exception:  # noqa: BLE001
                pass
            self._mark(
                job_id, "failed", last_error=f"E_WORKER_CRASH: {type(exc).__name__}"
            )

    def _finish_matter_transport_failure(
        self, svc, run_id: int, job_id: int, code: str
    ) -> None:
        """transport 失败（poke 异常 / 非 2xx）→ fail；cancel_requested 在场 → canceled。"""
        run = svc.get_run(run_id) or {}
        if run.get("cancel_requested_at") is not None:
            svc.finish_run(run_id, canceled=True)
            self._mark(
                job_id, "aborted",
                result={"outcome": "stopped", "reason": "user_cancelled"},
            )
            return
        svc.finish_run(run_id, "fail", error={"code": code})
        self._mark(job_id, "failed", last_error=code)

    def _map_matter_response(
        self,
        svc,
        run_id: int,
        job_id: int,
        resp: dict,
        *,
        output_watermark: dict,
        metadata_only: bool,
    ) -> None:
        """gateway 响应 → matter_run 终态四值（D3 映射）+ async job 终态。

        succeeded + 有提案 → ok；无提案 → noop；校验剔除过 change（error_json.dropped，
        propose 端点暂存）或变更集仅 metadata_only 资源 → warn；transport failed/aborted
        → fail（cancel_requested_at 在场 → canceled，status 留 NULL）。
        """
        session_id = resp.get("sessionId") if isinstance(resp.get("sessionId"), int) else None
        ok = bool(resp.get("ok"))
        outcome = resp.get("outcome")
        if ok and outcome == "completed":
            run = svc.get_run(run_id) or {}
            update_id = svc.update_id_for_run(run_id)
            dropped = svc.dropped_of(run)
            degraded = bool(dropped) or metadata_only
            status = "warn" if degraded else ("ok" if update_id is not None else "noop")
            usage = {
                key: resp[key] for key in ("usage", "steps") if resp.get(key) is not None
            }
            svc.finish_run(
                run_id,
                status,
                output_watermark=output_watermark,
                usage=usage or None,
                model=resp.get("model"),
                chat_session_id=session_id,
            )
            result = self._result_json(resp)
            result["matterRunStatus"] = status
            if update_id is not None:
                result["updateId"] = update_id
            self._mark(job_id, "succeeded", result=result)
            return
        # 非 completed（error / ok=false / 未预期 outcome）→ transport 失败语义。
        run = svc.get_run(run_id) or {}
        if run.get("cancel_requested_at") is not None:
            svc.finish_run(run_id, canceled=True, chat_session_id=session_id)
            self._mark(
                job_id, "aborted",
                result={"outcome": "stopped", "reason": "user_cancelled"},
            )
            return
        err = str(resp.get("error") or "E_RUN_ERROR")
        svc.finish_run(
            run_id, "fail", error={"code": err}, chat_session_id=session_id
        )
        self._mark(job_id, "failed", last_error=err)

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
        name = self._title_resolver(job) or agent_id or "Agent"
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

    def _default_title_resolver(self, job: "AsyncJob") -> Optional[str]:
        """缺省 title resolver：report_agent 行 title（既有行为字节级不变）。"""
        agent_id = str((job.params or {}).get("agent_id") or job.target_key or "")
        return self._agent_title(agent_id)

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
        """httpx 总超时 = resolver 给的 run 预算秒数 + 余量（drain 有界，超时兜底防卡死）。"""
        return float(self._timeout_resolver(job)) + _HTTP_MARGIN_SEC

    def _default_timeout_resolver(self, job: "AsyncJob") -> float:
        """缺省 timeout resolver：matter_followup → 1800s 常量（profile budget 不咨询，
        D7）；agent_run → report_agent budget（既有行为字节级不变，缺失/坏 budget → 默认）。"""
        if job.job_type == "matter_followup":
            from src.matters.run_spec import MATTER_FOLLOWUP_MAX_RUN_SECONDS

            return float(MATTER_FOLLOWUP_MAX_RUN_SECONDS)
        budget = Budget()
        agent_id = (job.params or {}).get("agent_id")
        if agent_id and self.store is not None:
            try:
                row = self.store.get_agent(agent_id)
                if row:
                    budget = parse_budget(row.get("budget_json"))
            except Exception as exc:  # noqa: BLE001 — budget 读失败退默认, 不阻断
                logger.debug(f"[agent-run-worker] budget read failed agent={agent_id}: {exc}")
        return budget.max_run_seconds

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
