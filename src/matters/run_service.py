"""Matter 跟进 Agent run 编排（P4 lane ①，decisions D3/D4/D6）。

职责（与 ``MatterService`` 同域、共用 repository/事件习语，故子类化复用）：
  - 水位指纹 ``compute_watermark``（D4 形状，键序稳定）+ 便宜比对 ``watermark_diff``；
  - ``enqueue_run``：单事务内幂等重放 / 单活跃合并（coalesce）/ 建 queued 行，事务外
    enqueue ``matter_followup`` async job（同 db 文件 —— job 写必须在 BEGIN IMMEDIATE
    事务外，否则第二连接等锁到超时）；
  - ``cancel_run``：queued → CAS abort job + canceled_at；running → cancel_requested_at
    + best-effort POST loopback gateway ``/api/ai/run/stop``；
  - ``lifecycle_state`` 七值单源（queued/running/ok/noop/warn/fail/canceled）；
  - ``propose_update``：run 语境专属提案落库（防幻觉校验 + 每 run 至多一个 + 不 bump
    matter.version）；
  - worker 终态 helpers（``mark_started`` CAS / ``finish_run`` / dropped 暂存）。

matter 无 runs/day 预算（单活跃 + 合并即节流），**不走** ``run_queue.enqueue_agent_run``。
"""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Mapping, Optional

import httpx
from loguru import logger

from .events import UPDATE_PROPOSED
from .attention import AttentionFact, AttentionService
from .models import MATTER_CHANGE_KINDS, MATTER_RUN_STATUSES, MatterRunTrigger
from .resource_proposal import (
    ResourceProposalError,
    new_resource_spec,
    normalize_new_resource,
    propose_allowed_providers,
)
from .service import Actor, MatterError, MatterService

# gateway loopback 端口解析 —— 同形抄 ai_gateway_proxy._resolve_gateway_port /
# run_worker._gateway_port（两处已注记「同源同形抄写」纪律；此处第三处，同注记）。
_DEFAULT_AI_GATEWAY_PORT = 8300
_RUN_STOP_TIMEOUT_SEC = 5.0

MATTER_FOLLOWUP_JOB_TYPE = "matter_followup"

# lifecycle 七值（status 四值 + 三过程态）；REST 与前端只认它（D3）。
MATTER_RUN_LIFECYCLE_STATES = (
    "queued", "running", "ok", "noop", "warn", "fail", "canceled",
)

# kind=field 提案的字段白名单（D6）：description **永不**允许。
#: 跟进 Agent 的提案能触及的 matter 字段（`kind='field'` 的 `target.field` 值域）。
#:
#: S3（08-18）加了 `description` / `goal_checks` —— 核心目标与完成标志。owner 的裁决是
#: 「main agent（本人在场）直写 + 审批卡；跟进 Agent 只能提案」，所以这两个字段在这里
#: 出现，但**不进** headless run 的直写路径（matter_followup 的矩阵行本来就拒 domain_write）。
#:
#: 🔴 改这个元组必须同步 `proposal_scope.PROPOSAL_TOUCHABLE_FIELDS` —— 那里是提案失效
#: （stale）判据的目标集。漏加 = owner 一边手改核心目标、Agent 的旧提案一边还带着旧文案
#: 等着 accept，accept 时**静默覆盖** owner 刚写的新值。有闸盯着两者一致。
PROPOSAL_FIELD_WHITELIST = (
    "status",
    "health",
    "priority",
    "due_at",
    "waiting_context",
    "description",
    "goal_checks",
)


def lifecycle_state(run: Mapping[str, Any]) -> str:
    """matter_run 行 → 七值读态（派生单源，不落库）。"""
    if run.get("canceled_at") is not None:
        return "canceled"
    if run.get("completed_at") is not None:
        status = run.get("status")
        return status if status in MATTER_RUN_STATUSES else "fail"
    if run.get("started_at") is not None:
        return "running"
    return "queued"


def watermark_diff(
    baseline: Optional[Mapping[str, Any]], current: Mapping[str, Any]
) -> dict[str, Any]:
    """便宜比对（D4）：与上个完成 run 的 output_watermark 比。无基线 = 首跑恒有变化。

    ``computed_at`` / ``matter_version`` / ``latest_accepted_update_id`` 不参与判定
    （version 每次 accept 必涨且必伴随事件；时间戳恒不同）——判据 = resources rev 集
    + ``max_event_id``。``touched_resources`` = 变更 + 新增（metadata_only 分类的输入）。
    """
    cur_resources = {str(k): str(v) for k, v in (current.get("resources") or {}).items()}
    if not baseline:
        touched = sorted(cur_resources)
        return {
            "changed": True,
            "first_run": True,
            "changed_resources": [],
            "added_resources": touched,
            "removed_resources": [],
            "touched_resources": touched,
            "new_events": 0,
        }
    prev_resources = {str(k): str(v) for k, v in (baseline.get("resources") or {}).items()}
    changed = sorted(
        k for k in cur_resources
        if k in prev_resources and cur_resources[k] != prev_resources[k]
    )
    added = sorted(k for k in cur_resources if k not in prev_resources)
    removed = sorted(k for k in prev_resources if k not in cur_resources)
    try:
        prev_max = int(baseline.get("max_event_id") or 0)
    except (TypeError, ValueError):
        prev_max = 0
    try:
        cur_max = int(current.get("max_event_id") or 0)
    except (TypeError, ValueError):
        cur_max = 0
    new_events = max(0, cur_max - prev_max)
    return {
        "changed": bool(changed or added or removed or new_events),
        "first_run": False,
        "changed_resources": changed,
        "added_resources": added,
        "removed_resources": removed,
        "touched_resources": sorted({*changed, *added}),
        "new_events": new_events,
    }


class MatterRunService(MatterService):
    """run 编排面（子类化 ``MatterService`` 复用 repository/事件/校验习语）。"""

    def __init__(self, repository, *, job_repo=None, clock_ms=None, settings=None):
        super().__init__(repository, clock_ms=clock_ms)
        if job_repo is None:
            from src.sync.async_jobs import AsyncJobRepository

            job_repo = AsyncJobRepository(str(repository.db_path))
        self.job_repo = job_repo
        #: 提案 provider 白名单要问「总闸开没开 + 哪些 connector 连着」。None = 惰性取
        #: 全局 config（镜像 run_spec._default_settings 的 settings=None 习语），测试可注入。
        self._settings = settings

    def _resolve_settings(self) -> Any:
        if self._settings is None:
            from src.config import config

            self._settings = config
        return self._settings

    # ── watermark（D4）─────────────────────────────────────────────────────────

    def current_watermark(self, matter_id: int) -> dict[str, Any]:
        with self.repository.connect() as conn:
            matter = self.repository.get_matter_by_id(conn, matter_id)
            if matter is None:
                raise MatterError("E_MATTER_NOT_FOUND", f"matter {matter_id} not found")
            return self._compute_watermark(conn, matter)

    def _compute_watermark(
        self, conn: sqlite3.Connection, matter: Mapping[str, Any]
    ) -> dict[str, Any]:
        """D4 形状（键序稳定；resources 按 key 排序）。

        资源集 = 未删关联 ∩ access_policy ∈ {allowed, metadata_only}（excluded 完全
        不进指纹 —— 不可见即不产生「变化」）。rev 按 kind：thread = "{成员邮件数}:
        {max_internal_id}"；email = "1"（不可变）；其余 = revision（无则 updated_at）。
        """
        resources: dict[str, str] = {}
        rows = conn.execute(
            "SELECT r.id, r.kind, r.external_key, r.revision, r.updated_at "
            "FROM matter_resource mr JOIN resource r ON r.id=mr.resource_id "
            "WHERE mr.matter_id=? AND mr.deleted_at IS NULL "
            "AND r.access_policy IN ('allowed','metadata_only')",
            (matter["id"],),
        ).fetchall()
        for row in rows:
            kind = row["kind"]
            if kind == "email":
                rev = "1"
            elif kind == "thread":
                thread_id = (
                    row["external_key"].split(":", 1)[1]
                    if ":" in row["external_key"] else ""
                )
                member = conn.execute(
                    "SELECT COUNT(*) AS n, COALESCE(MAX(internal_id), 0) AS max_id "
                    "FROM email_metadata WHERE thread_id=?",
                    (thread_id,),
                ).fetchone()
                rev = f"{int(member['n'])}:{int(member['max_id'])}"
            else:
                rev = (
                    str(row["revision"])
                    if row["revision"] is not None
                    else str(row["updated_at"])
                )
            resources[str(row["id"])] = rev
        max_event = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS max_id FROM matter_event WHERE matter_id=?",
            (matter["id"],),
        ).fetchone()
        return {
            "computed_at": datetime.now(timezone.utc).isoformat(),
            "matter_version": int(matter["version"]),
            "max_event_id": int(max_event["max_id"]),
            "latest_accepted_update_id": matter.get("latest_accepted_update_id"),
            "resources": dict(sorted(resources.items())),
        }

    def last_output_watermark(
        self, matter_id: int, *, exclude_run_id: Optional[int] = None
    ) -> Optional[dict[str, Any]]:
        """上一个完成 run 的 output_watermark（无则 None = 空基线 = 首跑恒有变化）。"""
        with self.repository.connect() as conn:
            sql = (
                "SELECT output_watermark_json FROM matter_run "
                "WHERE matter_id=? AND completed_at IS NOT NULL "
                "AND output_watermark_json IS NOT NULL"
            )
            params: list[Any] = [matter_id]
            if exclude_run_id is not None:
                sql += " AND id != ?"
                params.append(exclude_run_id)
            sql += " ORDER BY completed_at DESC, id DESC LIMIT 1"
            row = conn.execute(sql, params).fetchone()
            if row is None:
                return None
            parsed = self.repository._json(row["output_watermark_json"], None)
            return parsed if isinstance(parsed, dict) else None

    def touched_all_metadata_only(
        self, matter_id: int, touched_resource_ids: list[str]
    ) -> bool:
        """「变更集仅 metadata_only 资源」判定（D3 warn 条件之一）。空集 → False。"""
        ids = []
        for raw in touched_resource_ids:
            try:
                ids.append(int(raw))
            except (TypeError, ValueError):
                continue
        if not ids:
            return False
        placeholders = ",".join("?" for _ in ids)
        with self.repository.connect() as conn:
            rows = conn.execute(
                f"SELECT access_policy FROM resource WHERE id IN ({placeholders})",
                tuple(ids),
            ).fetchall()
        return bool(rows) and all(r["access_policy"] == "metadata_only" for r in rows)

    # ── enqueue / cancel（D3）──────────────────────────────────────────────────

    def enqueue_run(
        self,
        public_id: str,
        *,
        expected_version: Optional[int] = None,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
        trigger_kind: str = MatterRunTrigger.MANUAL.value,
    ) -> dict[str, Any]:
        if trigger_kind not in (
            MatterRunTrigger.MANUAL.value,
            MatterRunTrigger.SCHEDULE.value,
        ):
            raise MatterError("E_INVALID_ARG", f"unsupported trigger_kind: {trigger_kind}")
        key = self._dedupe(idempotency_key)
        now = self.clock_ms()
        with self._transaction() as conn:
            matter = self._require_matter(conn, public_id)
            matter_id = int(matter["id"])
            run_key = (
                f"{MATTER_FOLLOWUP_JOB_TYPE}:{matter_id}:manual:{key}"
                if trigger_kind == MatterRunTrigger.MANUAL.value
                else key
            )
            existing = conn.execute(
                "SELECT * FROM matter_run WHERE idempotency_key=?", (run_key,)
            ).fetchone()
            if existing is not None:
                # 幂等重放：同 key 重发返回既有 run（不校验 version、不合并计数）。
                return {
                    "run": self._project_run(conn, dict(existing)),
                    "coalesced": False,
                }
            # expected_version 作 input anchor（D10）：可缺省（gateway 工具面不强制带），
            # 带了但不符 → E_VERSION_CONFLICT（提示先刷新）。不做 CAS bump（run 不是
            # aggregate 变更）。
            if expected_version is not None and int(matter["version"]) != int(
                expected_version
            ):
                raise self._version_conflict()
            active = conn.execute(
                "SELECT * FROM matter_run WHERE matter_id=? "
                "AND completed_at IS NULL AND canceled_at IS NULL "
                "ORDER BY id DESC LIMIT 1",
                (matter_id,),
            ).fetchone()
            if active is not None:
                conn.execute(
                    "UPDATE matter_run SET coalesced_trigger_count="
                    "coalesced_trigger_count+1 WHERE id=?",
                    (active["id"],),
                )
                merged = conn.execute(
                    "SELECT * FROM matter_run WHERE id=?", (active["id"],)
                ).fetchone()
                return {
                    "run": self._project_run(conn, dict(merged)),
                    "coalesced": True,
                }
            watermark = self._compute_watermark(conn, matter)
            cursor = conn.execute(
                "INSERT INTO matter_run (matter_id, agent_profile_id, trigger_kind, "
                "trigger_payload_json, idempotency_key, input_watermark_json, "
                "queued_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (
                    matter_id,
                    matter.get("agent_profile_id"),
                    trigger_kind,
                    self._dump({"source": source, "reason": reason}),
                    run_key,
                    self._dump(watermark),
                    now,
                    now,
                ),
            )
            run_id = int(cursor.lastrowid)
        # 🔴 事务外 enqueue（async_jobs 用独立连接写同一 db 文件；放事务内会等
        # BEGIN IMMEDIATE 的写锁直到超时）。失败 → run 标 fail，错误上抛。
        try:
            job_id, _ = self.job_repo.enqueue(
                job_type=MATTER_FOLLOWUP_JOB_TYPE,
                target_kind="matter",
                target_key=public_id,
                params={
                    "matter_id": matter_id,
                    "matter_run_id": run_id,
                    "trigger_kind": trigger_kind,
                },
                idempotency_key=run_key,
            )
        except Exception as exc:  # noqa: BLE001 — enqueue 失败必须收敛 run，不留悬挂 queued
            logger.error(f"[matter-run] enqueue job failed run_id={run_id}: {exc}")
            self.finish_run(
                run_id, "fail",
                error={"code": "E_ENQUEUE_FAILED", "message": str(exc)},
            )
            raise MatterError(
                "E_INTERNAL", "failed to enqueue matter follow-up job"
            ) from exc
        with self._transaction() as conn:
            conn.execute(
                "UPDATE matter_run SET async_job_id=? WHERE id=?", (job_id, run_id)
            )
            row = conn.execute(
                "SELECT * FROM matter_run WHERE id=?", (run_id,)
            ).fetchone()
            return {"run": self._project_run(conn, dict(row)), "coalesced": False}

    def cancel_run(
        self,
        public_id: str,
        run_id: int,
        *,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        self._dedupe(idempotency_key)
        now = self.clock_ms()
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            row = conn.execute(
                "SELECT * FROM matter_run WHERE id=? AND matter_id=?",
                (run_id, matter["id"]),
            ).fetchone()
            if row is None:
                raise MatterError("E_CHILD_NOT_FOUND", f"run {run_id} not found")
            run = dict(row)
        if run["canceled_at"] is not None or run["completed_at"] is not None:
            raise MatterError("E_INVALID_STATE", "run is already terminal")
        if run["started_at"] is None:
            # queued → CAS abort job（claim 竞态由 expect_status='queued' 裁决：
            # CAS 赢 = job 未被 claim → 直接 canceled；输 = worker 已在跑 → 落
            # running 分支走 cancel_requested。async_job_id 尚未回写（enqueue 窗口）
            # 也按 CAS 赢处理 —— worker 无从认领一个不存在的 job。
            job_id = run.get("async_job_id")
            cas_won = True
            if job_id is not None:
                try:
                    cas_won = self.job_repo.mark_terminal(
                        int(job_id),
                        status="aborted",
                        result={"outcome": "stopped", "reason": reason or "user_cancelled"},
                        expect_status="queued",
                    )
                except Exception as exc:  # noqa: BLE001 — job 侧失败按 CAS 输保守处理
                    logger.warning(f"[matter-run] cancel job CAS failed: {exc}")
                    cas_won = False
            if cas_won:
                with self._transaction() as conn:
                    cursor = conn.execute(
                        "UPDATE matter_run SET canceled_at=?, "
                        "cancel_requested_at=COALESCE(cancel_requested_at, ?) "
                        "WHERE id=? AND started_at IS NULL "
                        "AND completed_at IS NULL AND canceled_at IS NULL",
                        (now, now, run_id),
                    )
                    if cursor.rowcount == 1:
                        row = conn.execute(
                            "SELECT * FROM matter_run WHERE id=?", (run_id,)
                        ).fetchone()
                        return {"run": self._project_run(conn, dict(row))}
            refreshed = self.get_run(run_id)
            if refreshed is None:
                raise MatterError("E_CHILD_NOT_FOUND", f"run {run_id} not found")
            run = refreshed
            if run["canceled_at"] is not None or run["completed_at"] is not None:
                raise MatterError("E_INVALID_STATE", "run is already terminal")
        # running → cancel_requested_at + best-effort gateway stop（sessionId 可能
        # 尚未知 —— chat_session_id 由 worker 终态回写；缺失时跳过 POST，worker 在
        # 终态看到 cancel_requested_at 仍会收敛 canceled）。
        with self._transaction() as conn:
            conn.execute(
                "UPDATE matter_run SET cancel_requested_at="
                "COALESCE(cancel_requested_at, ?) WHERE id=?",
                (now, run_id),
            )
            row = conn.execute(
                "SELECT * FROM matter_run WHERE id=?", (run_id,)
            ).fetchone()
            run = dict(row)
            projection = self._project_run(conn, run)
        self._post_run_stop(run.get("chat_session_id"))
        return {"run": projection}

    def _post_run_stop(self, chat_session_id: Any) -> None:
        """best-effort POST loopback gateway ``/api/ai/run/stop``（失败只 warning）。"""
        if not isinstance(chat_session_id, int) or chat_session_id <= 0:
            return
        url = f"http://127.0.0.1:{self._gateway_port()}/api/ai/run/stop"
        try:
            httpx.post(
                url,
                json={"sessionId": chat_session_id},
                timeout=_RUN_STOP_TIMEOUT_SEC,
            )
        except Exception as exc:  # noqa: BLE001 — best-effort，取消不依赖 stop 成功
            logger.warning(f"[matter-run] run/stop POST failed: {exc}")

    @staticmethod
    def _gateway_port() -> int:
        raw = os.environ.get("MAILAGENT_AI_GATEWAY_PORT")
        if raw is None:
            return _DEFAULT_AI_GATEWAY_PORT
        try:
            n = int(raw)
        except (TypeError, ValueError):
            return _DEFAULT_AI_GATEWAY_PORT
        return n if n > 0 else _DEFAULT_AI_GATEWAY_PORT

    # ── 读面（runs REST / worker）──────────────────────────────────────────────

    def get_run(self, run_id: int) -> Optional[dict[str, Any]]:
        with self.repository.connect() as conn:
            row = conn.execute(
                "SELECT * FROM matter_run WHERE id=?", (run_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_run_projection(self, public_id: str, run_id: int) -> dict[str, Any]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            row = conn.execute(
                "SELECT * FROM matter_run WHERE id=? AND matter_id=?",
                (run_id, matter["id"]),
            ).fetchone()
            if row is None:
                raise MatterError("E_CHILD_NOT_FOUND", f"run {run_id} not found")
            return self._project_run(conn, dict(row))

    def list_runs(
        self,
        public_id: str,
        *,
        cursor: Optional[int] = None,
        limit: int = 50,
        status: Optional[str] = None,
        trigger_kind: Optional[str] = None,
    ) -> dict[str, Any]:
        if status is not None and status not in MATTER_RUN_LIFECYCLE_STATES:
            raise MatterError("E_INVALID_ARG", f"invalid run status filter: {status}")
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            clauses = ["matter_id=?"]
            params: list[Any] = [matter["id"]]
            if trigger_kind:
                clauses.append("trigger_kind=?")
                params.append(trigger_kind)
            if cursor is not None:
                clauses.append("id < ?")
                params.append(cursor)
            params.append(limit + 1)
            rows = conn.execute(
                f"SELECT * FROM matter_run WHERE {' AND '.join(clauses)} "
                "ORDER BY id DESC LIMIT ?",
                params,
            ).fetchall()
            next_cursor = int(rows[limit - 1]["id"]) if len(rows) > limit else None
            items = [self._project_run(conn, dict(row)) for row in rows[:limit]]
            if status is not None:
                # lifecycle 是派生态（非列），窗口内内存过滤（agent_runs state 过滤同口径）。
                items = [item for item in items if item["lifecycle_state"] == status]
            return {"items": items, "next_cursor": next_cursor}

    def _project_run(
        self, conn: sqlite3.Connection, run: Mapping[str, Any]
    ) -> dict[str, Any]:
        out = dict(run)
        out["lifecycle_state"] = lifecycle_state(run)
        for source, target in (
            ("input_watermark_json", "input_watermark"),
            ("output_watermark_json", "output_watermark"),
            ("usage_json", "usage"),
            ("error_json", "error"),
            ("trigger_payload_json", "trigger_payload"),
        ):
            out[target] = self.repository._json(out.pop(source, None), None)
        upd = conn.execute(
            "SELECT id FROM matter_update WHERE agent_run_id=? ORDER BY id LIMIT 1",
            (run["id"],),
        ).fetchone()
        out["update_id"] = int(upd["id"]) if upd else None
        started = run.get("started_at")
        completed = run.get("completed_at")
        out["duration_ms"] = (
            max(0, int(completed) - int(started))
            if started is not None and completed is not None else None
        )
        return out

    # ── worker 终态 helpers（D3/D4）────────────────────────────────────────────

    def mark_started(self, run_id: int) -> bool:
        """started_at CAS。撞 ``uq_matter_run_one_active``（同 matter 另有活跃 run）→ False。"""
        now = self.clock_ms()
        try:
            with self._transaction() as conn:
                cursor = conn.execute(
                    "UPDATE matter_run SET started_at=? WHERE id=? "
                    "AND started_at IS NULL AND completed_at IS NULL "
                    "AND canceled_at IS NULL",
                    (now, run_id),
                )
                return cursor.rowcount == 1
        except sqlite3.IntegrityError:
            return False

    def finish_run(
        self,
        run_id: int,
        status: Optional[str] = None,
        *,
        output_watermark: Optional[Mapping[str, Any]] = None,
        usage: Optional[Mapping[str, Any]] = None,
        model: Optional[str] = None,
        cost_usd: Optional[float] = None,
        error: Optional[Mapping[str, Any]] = None,
        canceled: bool = False,
        chat_session_id: Optional[int] = None,
    ) -> bool:
        """写终态（幂等：已终态的行 no-op 返回 False）。

        ``canceled=True`` → 置 canceled_at、status 保持 NULL（D3）；否则 status 必须
        ∈ ok/noop/warn/fail + completed_at。error 与既有 error_json（propose 暂存的
        dropped）**合并**不覆盖。
        """
        if not canceled and status not in MATTER_RUN_STATUSES:
            raise ValueError(f"invalid matter_run status: {status!r}")
        now = self.clock_ms()
        with self._transaction() as conn:
            row = conn.execute(
                "SELECT * FROM matter_run WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                return False
            run = dict(row)
            if run["completed_at"] is not None or run["canceled_at"] is not None:
                return False
            error_payload = self.repository._json(run.get("error_json"), None)
            if not isinstance(error_payload, dict):
                error_payload = {}
            if error:
                error_payload.update(dict(error))
            sets: dict[str, Any] = {}
            if canceled:
                sets["canceled_at"] = now
            else:
                sets["status"] = status
                sets["completed_at"] = now
            if output_watermark is not None:
                sets["output_watermark_json"] = self._dump(dict(output_watermark))
            if usage is not None:
                sets["usage_json"] = self._dump(dict(usage))
            if model:
                sets["model"] = str(model)
            if cost_usd is not None:
                sets["cost_usd"] = float(cost_usd)
            if error_payload:
                sets["error_json"] = self._dump(error_payload)
            if isinstance(chat_session_id, int) and chat_session_id > 0:
                sets["chat_session_id"] = chat_session_id
            assignments = ", ".join(f"{column}=?" for column in sets)
            conn.execute(
                f"UPDATE matter_run SET {assignments} WHERE id=?",
                (*sets.values(), run_id),
            )
            return True

    def update_id_for_run(self, run_id: int) -> Optional[int]:
        with self.repository.connect() as conn:
            row = conn.execute(
                "SELECT id FROM matter_update WHERE agent_run_id=? ORDER BY id LIMIT 1",
                (run_id,),
            ).fetchone()
            return int(row["id"]) if row else None

    @classmethod
    def dropped_of(cls, run: Mapping[str, Any]) -> list[Any]:
        """error_json.dropped（propose 校验暂存的剔除明细）。"""
        raw = run.get("error_json")
        try:
            parsed = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except (TypeError, json.JSONDecodeError):
            parsed = {}
        dropped = parsed.get("dropped") if isinstance(parsed, dict) else None
        return list(dropped) if isinstance(dropped, list) else []

    def recover_orphaned_runs(self) -> int:
        """worker 启动扫尾：async job 已 failed/aborted 但 run 未终态 → 收敛 fail。"""
        with self.repository.connect() as conn:
            try:
                rows = conn.execute(
                    "SELECT mr.id FROM matter_run mr "
                    "JOIN async_jobs aj ON aj.job_id = mr.async_job_id "
                    "WHERE mr.completed_at IS NULL AND mr.canceled_at IS NULL "
                    "AND aj.job_type=? AND aj.status IN ('failed','aborted')",
                    (MATTER_FOLLOWUP_JOB_TYPE,),
                ).fetchall()
            except sqlite3.OperationalError:
                return 0
        count = 0
        for row in rows:
            if self.finish_run(int(row["id"]), "fail", error={"code": "E_ORPHANED"}):
                count += 1
        if count:
            logger.warning(f"[matter-run] converged {count} orphaned run(s) → fail")
        return count

    # ── propose（D6）──────────────────────────────────────────────────────────

    def propose_update(
        self, public_id: str, run_id: int, payload: Mapping[str, Any]
    ) -> dict[str, Any]:
        """run 语境专属提案落库。**不 bump matter.version**（提案不是 aggregate 变更）。

        matter_id/run_id/from_event_id/to_event_id/anchored_matter_version 全部
        服务端从 run 语境盖章（入参 schema 里根本没有这些字段）。
        """
        now = self.clock_ms()
        with self._transaction() as conn:
            matter = self._require_matter(conn, public_id)
            row = conn.execute(
                "SELECT * FROM matter_run WHERE id=? AND matter_id=?",
                (run_id, matter["id"]),
            ).fetchone()
            if row is None:
                raise MatterError("E_CHILD_NOT_FOUND", f"run {run_id} not found")
            run = dict(row)
            if run["started_at"] is None:
                raise MatterError("E_INVALID_STATE", "run has not started")
            if run["completed_at"] is not None or run["canceled_at"] is not None:
                raise MatterError("E_INVALID_STATE", "run is already terminal")
            existing = conn.execute(
                "SELECT id FROM matter_update WHERE agent_run_id=? LIMIT 1",
                (run_id,),
            ).fetchone()
            if existing is not None:
                raise MatterError(
                    "E_PROPOSAL_EXISTS", "this run already submitted a proposal"
                )
            raw_changes = [
                dict(change)
                for change in (payload.get("changes") or [])
                if isinstance(change, Mapping)
            ]
            validated, dropped = self._validate_changes(conn, matter, raw_changes)
            summary = self._optional_text(payload.get("summary"))
            if dropped:
                self._stash_dropped(conn, run_id, dropped)
            if not validated and summary is None:
                # 全剔 + 无 summary → 不落 Update（终态 warn 由 worker 凭 dropped 判）。
                return {"update_id": None, "dropped": dropped}
            from_row = conn.execute(
                "SELECT to_event_id FROM matter_update WHERE matter_id=? "
                "AND review_status='accepted' "
                "ORDER BY COALESCE(accepted_at, created_at) DESC, id DESC LIMIT 1",
                (matter["id"],),
            ).fetchone()
            from_event_id = from_row["to_event_id"] if from_row else None
            to_row = conn.execute(
                "SELECT MAX(id) AS max_id FROM matter_event WHERE matter_id=?",
                (matter["id"],),
            ).fetchone()
            to_event_id = to_row["max_id"] if to_row else None
            created_by_id = run.get("agent_profile_id") or f"matter:{matter['public_id']}"
            citations = [
                dict(source)
                for change in validated
                for source in (change.get("sources") or [])
                if isinstance(source, Mapping)
            ]
            confidence = payload.get("confidence")
            update_id = self.repository.insert_update(
                conn,
                {
                    "matter_id": matter["id"],
                    "review_status": "pending",
                    "summary": summary,
                    "from_event_id": from_event_id,
                    "to_event_id": to_event_id,
                    "anchored_matter_version": int(matter["version"]),
                    "original_proposal_json": self._dump(dict(payload)),
                    "changes_json": self._dump(validated),
                    "citations_json": self._dump(citations),
                    "confidence": (
                        float(confidence) if isinstance(confidence, (int, float)) else None
                    ),
                    "agent_run_id": run_id,
                    "created_by_kind": "agent",
                    "created_by_id": created_by_id,
                    "created_at": now,
                },
            )
            self._append_event(
                conn,
                matter_id=matter["id"],
                kind=UPDATE_PROPOSED,
                actor=Actor(kind="agent", actor_id=created_by_id),
                source="agent_run",
                dedupe_key=f"matter_run:{run_id}:update_proposed",
                reason=None,
                update_id=update_id,
                payload={
                    "update_id": update_id,
                    "run_id": run_id,
                    "change_count": len(validated),
                },
                happened_at=now,
            )
            AttentionService(self.repository, clock_ms=self.clock_ms)._open_episode_in_conn(
                conn,
                AttentionFact(
                    int(matter["id"]),
                    "needs_review",
                    f"update:{update_id}",
                    "info",
                    "有一条 Agent 提案等待评审",
                    {"update_id": update_id},
                ),
                now,
            )
            return {"update_id": update_id, "dropped": dropped}

    def _validate_changes(
        self,
        conn: sqlite3.Connection,
        matter: Mapping[str, Any],
        changes: list[dict[str, Any]],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """防幻觉校验（D6 逐条）。返回 (保留的 changes, 剔除明细)。

        0812 起多一条通道：``kind=resource`` 除了「确认既有 link」，还能描述一份**新**外部
        资料（``change.resource`` = provider/kind/external_key/title/canonical_url）。新形状
        走 ``resource_proposal`` 单源校验：provider 必须落在「builtin + 已连接 connector」
        白名单里，external_key 按各 provider 既有约定，mailagent 侧还要真的存在。任一环节
        推导不出 → **剔除该 change**（fail-closed，不是放行）。
        """
        linked_resource_ids = {
            int(row["resource_id"])
            for row in conn.execute(
                "SELECT resource_id FROM matter_resource "
                "WHERE matter_id=? AND deleted_at IS NULL",
                (matter["id"],),
            )
        }
        live_item_ids = {
            int(row["id"])
            for row in conn.execute(
                "SELECT id FROM matter_item WHERE matter_id=? AND deleted_at IS NULL",
                (matter["id"],),
            )
        }
        validated: list[dict[str, Any]] = []
        dropped: list[dict[str, Any]] = []

        def drop(change: Mapping[str, Any], reason: str, **extra: Any) -> None:
            dropped.append(
                {
                    "id": str(change.get("id") or ""),
                    "kind": str(change.get("kind") or ""),
                    "reason": reason,
                    **extra,
                }
            )

        # 🔴 两趟：先把 kind=resource 的**新建**形状裁完，第二趟才轮到 fact —— 否则
        # 「fact 引用同一份提案里正在新建的 resource」这条合法引用会因为次序而认不出来。
        # 第一趟只记结论，change 的原始顺序由第二趟保持。
        new_resources, resource_errors = self._validate_new_resources(conn, changes)

        for change in changes:
            change_id = str(change.get("id") or "")
            kind = str(change.get("kind") or "")
            if kind not in MATTER_CHANGE_KINDS:
                drop(change, "invalid_kind")
                continue
            if kind == "resource" and change_id in resource_errors:
                error = resource_errors[change_id]
                drop(change, error.reason, detail=error.detail)
                continue
            if kind == "resource" and change_id in new_resources:
                # 归一后的身份回写进 change —— accept 侧读的是这份服务端产物，不是模型原话。
                change["resource"] = dict(new_resources[change_id])
            kept_sources: list[dict[str, Any]] = []
            foreign_sources: list[Any] = []
            for source in change.get("sources") or []:
                if not isinstance(source, Mapping):
                    continue
                resource_id = source.get("resource_id")
                source_change_id = source.get("change_id")
                if isinstance(resource_id, int) and resource_id in linked_resource_ids:
                    kept_sources.append(dict(source))
                elif (
                    resource_id is None
                    and isinstance(source_change_id, str)
                    and source_change_id in new_resources
                ):
                    # 本提案正在新建的资料：还没有 resource_id，用 change_id 引用。
                    kept_sources.append(dict(source))
                else:
                    foreign_sources.append(
                        resource_id if resource_id is not None else source_change_id
                    )
            change["sources"] = kept_sources
            if kind == "fact" and not kept_sources:
                drop(change, "fact_without_source", foreign_sources=foreign_sources)
                continue
            if kind == "field":
                target = change.get("target")
                field = target.get("field") if isinstance(target, Mapping) else None
                if field not in PROPOSAL_FIELD_WHITELIST:
                    drop(change, "field_not_allowed", field=field)
                    continue
                # A3：due_at 必须是 epoch 毫秒。在 propose 侧就剔除（agent 当轮拿到
                # dropped 明细能自纠），不让秒值躺进提案等 owner accept 时才炸。
                if field == "due_at":
                    try:
                        self._require_epoch_ms("due_at", change.get("after"))
                    except MatterError:
                        drop(
                            change, "timestamp_not_epoch_ms",
                            field="due_at", value=change.get("after"),
                        )
                        continue
            if kind == "inference":
                change["is_inference"] = True
            if kind == "action":
                target = change.get("target")
                if target is not None:
                    item_id = (
                        target.get("id") if isinstance(target, Mapping) else None
                    )
                    if not isinstance(item_id, int) or item_id not in live_item_ids:
                        drop(change, "action_target_missing", target_id=item_id)
                        continue
                after = change.get("after")
                if isinstance(after, Mapping):
                    bad_ts = None
                    for ts_field in ("due_at", "completed_at"):
                        if ts_field in after:
                            try:
                                self._require_epoch_ms(ts_field, after.get(ts_field))
                            except MatterError:
                                bad_ts = ts_field
                                break
                    if bad_ts is not None:
                        drop(
                            change, "timestamp_not_epoch_ms",
                            field=bad_ts, value=after.get(bad_ts),
                        )
                        continue
            validated.append(change)
        return validated, dropped

    def _validate_new_resources(
        self, conn: sqlite3.Connection, changes: list[dict[str, Any]]
    ) -> tuple[dict[str, dict[str, Any]], dict[str, ResourceProposalError]]:
        """第一趟：裁 ``kind=resource`` 里描述**新**资料的那些条。

        返回 ``({change_id: 归一后的 spec}, {change_id: 失败原因})``。既有形状
        （``target.id`` 确认既有 link）不出现在任何一张表里 —— 那条分支一字未动。
        """
        allowed = propose_allowed_providers(self._resolve_settings())
        kept: dict[str, dict[str, Any]] = {}
        errors: dict[str, ResourceProposalError] = {}
        for change in changes:
            if str(change.get("kind") or "") != "resource":
                continue
            spec = new_resource_spec(change)
            if spec is None:
                continue
            change_id = str(change.get("id") or "")
            target = change.get("target")
            if isinstance(target, Mapping) and target.get("id") is not None:
                # 「确认既有 link」与「新建关联」是互斥的两个形态（gateway zod 也这么拒）。
                # 两个都给 = 说不清要做哪件事 —— 不猜，剔除。
                errors[change_id] = ResourceProposalError(
                    "resource_spec_invalid",
                    "a resource change confirms target.id or proposes resource, never both",
                )
                continue
            try:
                kept[change_id] = normalize_new_resource(
                    spec,
                    allowed_providers=allowed,
                    exists=lambda provider, kind, key: self.repository.resource_available(
                        conn, provider, kind, key
                    ),
                )
            except ResourceProposalError as exc:
                errors[change_id] = exc
        return kept, errors

    def _stash_dropped(
        self, conn: sqlite3.Connection, run_id: int, dropped: list[dict[str, Any]]
    ) -> None:
        """把剔除明细并进 run.error_json（worker 终态时凭它判 warn 并保留进最终 error_json）。"""
        row = conn.execute(
            "SELECT error_json FROM matter_run WHERE id=?", (run_id,)
        ).fetchone()
        payload = self.repository._json(row["error_json"], None) if row else None
        if not isinstance(payload, dict):
            payload = {}
        payload["dropped"] = [*payload.get("dropped", []), *dropped]
        conn.execute(
            "UPDATE matter_run SET error_json=? WHERE id=?",
            (self._dump(payload), run_id),
        )
