"""Matter action-item dispatch lifecycle mixin for MatterService."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Mapping, Sequence

from loguru import logger

from .event_changes import truncated_text
from .events import (
    ITEM_DISPATCHED,
    ITEM_DISPATCH_ANSWERED,
    ITEM_DISPATCH_CANCELED,
    ITEM_DISPATCH_DELIVERED,
    ITEM_DISPATCH_FAILED,
    ITEM_DISPATCH_SETTLED,
)
from .models import (
    MATTER_ITEM_BUILTIN_EXECUTOR,
    MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS,
    MATTER_ITEM_DISPATCH_DEFAULT_PROFILE,
    MATTER_ITEM_DISPATCH_STATES,
    MATTER_ITEM_EXEC_PROFILES,
    MATTER_ITEM_EXECUTOR_AGENT,
    MatterActorKind,
    MatterItemDispatchState,
    MatterItemExecProfile,
    MatterItemKind,
    normalize_computer_use_draft,
)
from .proposal_scope import SCOPE_NOTHING
from .resource_identity import MatterError
from .service_common import Actor

#: 行动项派发 run 的 async job 类型（`AsyncJobRepository.AGENT_JOB_TYPES` 的成员）。
#: 与 `matter_followup` 的区别：那个是 per-**事项**的定时跟进，这个是 per-**行动项**的
#: 一次显式派发（owner 按下去才有）。
MATTER_ITEM_RUN_JOB_TYPE = "matter_item_run"
#: owner 能主动取消的执行态。`proposed` 有意不在内 —— 那一步的逆操作是驳回提案
#: （走评审面、带理由留档），从取消再开一条路会让同一件事有两种记录形态。
CANCELABLE_DISPATCH_STATES = frozenset(
    {
        MatterItemDispatchState.QUEUED.value,
        MatterItemDispatchState.RUNNING.value,
        MatterItemDispatchState.AWAITING_INPUT.value,
    }
)
#: 已经收尾的行动项业务态 —— 派不出去（派给 agent 去推进一件已经完结的事没有意义）。
CLOSED_ITEM_STATUSES = frozenset({"done", "canceled"})
#: `/today` 例外面第四源默认要的两态：等我回答 / 挂了。
#: 🔴 `proposed` 有意不在内 —— 它由既有的「待审提案」源覆盖，两边都进面 = 同一件事出现
#: 两遍（needs_review 去重的既有取向：留源实体）。`queued` / `running` 也不进面：正在跑
#: 的事不需要我处理，去事项详情看就行。
DEFAULT_LIVE_DISPATCH_STATES = (
    MatterItemDispatchState.AWAITING_INPUT.value,
    MatterItemDispatchState.FAILED.value,
)


class _MatterDispatchMixin:
    """Action-item dispatch workflow and executor settlement methods for MatterService."""


    # ==================== 行动项执行契约（task 08-25 批次 3）====================
    # 一条行动项可以被**派发**给一个执行器（现阶段恒 agent）跑一轮 headless run：执行态
    # 落在独立的 `matter_item_dispatch` 行上，由服务端 CAS 推进，交付走既有提案机制。
    #
    # 🔴 这是 matters 的**第四条入口**，姿态是「用户直操作的 REST 动作」——派发 / 回答 /
    # 取消都由 owner 发起，agent 侧只有 report 那一个内部端点。三条既有入口的姿态一个字
    # 不动（结构红线，见 `docs/reference/matters/matters-architecture.md`）。
    #
    # 🔴 **不做 undo 描述符**（D16 四件套里唯一的豁免）：撤销一次派发的语义就是取消它，
    # 而取消本身是一颗独立的按钮 + 一条独立事件。给它再造一个「反向工具调用」只会让
    # 「取消」有两条实现路径，而反向路径没有任何测试会覆盖到。

    def dispatch_item(
        self,
        public_id: str,
        item_id: int,
        *,
        executor_id: str | None = None,
        profile: str | None = None,
        computer_use_draft: Mapping[str, Any] | None = None,
        expected_version: int | None = None,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        """把一条行动项派给执行器，落 queued 派发行 + 事务外 enqueue `matter_item_run`。

        `profile` 缺省 = 取 item 的 `exec_profile`，仍缺省 = `propose_only`（出厂档）。
        派发时**冻结**：owner 之后改了 item 的默认档，已经在跑的这一轮仍按冻结那档结算。
        """
        self._validate_actor(actor)
        resolved_profile = (
            self._require_exec_profile(profile) if profile is not None else None
        )
        normalized_draft: dict[str, list[str]] | None = None
        if computer_use_draft is not None:
            # 仅人类 owner（Matters 域 Actor.kind == "user"）可显式开启 Computer Use 草稿态授权。
            if actor.kind != MatterActorKind.USER.value:
                raise MatterError(
                    "E_AUTH_FAILED",
                    "computer_use_draft requires a user-initiated dispatch",
                )
            try:
                normalized_draft = normalize_computer_use_draft(computer_use_draft)
            except ValueError as exc:
                raise MatterError("E_INVALID_ARG", str(exc)) from exc
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(
                conn, dedupe_key, ITEM_DISPATCHED, include_item=True, include_dispatch=True
            )
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            item = self._require_dispatchable_item(conn, matter, item_id)
            if self.repository.get_active_dispatch(conn, item_id) is not None:
                raise MatterError(
                    "E_DISPATCH_ACTIVE",
                    f"item {item_id} already has an active dispatch",
                    hint="Cancel the running dispatch before starting another one.",
                )
            executor = self._resolve_executor(conn, executor_id)
            if resolved_profile is not None:
                frozen_profile = resolved_profile
            elif item.get("exec_profile"):
                frozen_profile = self._require_exec_profile(item.get("exec_profile"))
            else:
                frozen_profile = str(MATTER_ITEM_DISPATCH_DEFAULT_PROFILE)
            if (
                normalized_draft is not None
                and frozen_profile != MatterItemExecProfile.PROPOSE_ONLY.value
            ):
                raise MatterError(
                    "E_INVALID_STATE",
                    f"computer_use_draft is only permitted with propose_only exec_profile (got {frozen_profile!r})",
                    hint="Set exec_profile='propose_only' before staging a computer-use draft.",
                )
            self._cas_update_rebase(
                conn,
                matter,
                self._anchor_version(matter, expected_version),
                {"updated_at": now, "last_activity_at": now},
                # 派发是纯追加：没有任何既有对象被改 ⇒ 不作废任何 pending 提案
                # （与 create_item / add_progress 同判据）。
                scope=SCOPE_NOTHING,
            )
            dispatch_id = self.repository.insert_dispatch(
                conn,
                {
                    "matter_id": matter["id"],
                    "item_id": item_id,
                    "state": MatterItemDispatchState.QUEUED.value,
                    "executor_kind": MATTER_ITEM_EXECUTOR_AGENT,
                    "executor_id": executor,
                    "exec_profile": frozen_profile,
                    "answers_json": "[]",
                    "attempt_count": 1,
                    "idempotency_key": dedupe_key,
                    "created_by_kind": actor.kind,
                    "created_by_id": actor.actor_id,
                    "dispatched_at": now,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            event_payload: dict[str, Any] = {
                "dispatch_id": dispatch_id,
                "title": truncated_text(item.get("title")),
                "executor_id": executor,
                "exec_profile": frozen_profile,
                "attempt": 1,
            }
            if normalized_draft is not None:
                event_payload["computer_use_draft"] = normalized_draft
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=ITEM_DISPATCHED,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                payload=event_payload,
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            result = self._mutation(
                after,
                [event_id],
                item=self.repository.get_item(conn, matter["id"], item_id),
                dispatch=self.repository.get_dispatch(conn, dispatch_id),
            )
        # 🔴 事务外 enqueue（async_jobs 用独立连接写同一个 db 文件；放事务内会等
        # BEGIN IMMEDIATE 的写锁到超时）。失败 → 派发直接收敛 failed，不留悬挂 queued。
        self._enqueue_dispatch_job(
            public_id,
            matter["id"],
            result["dispatch"],
            attempt=1,
            computer_use_draft=normalized_draft,
        )
        result["dispatch"] = self._reload_dispatch(dispatch_id)
        self._publish_dispatch_changed(public_id, dispatch_id, item_id)
        return result

    def answer_dispatch(
        self,
        public_id: str,
        dispatch_id: int,
        *,
        text: str,
        expected_version: int | None = None,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        """owner 回答反问：`awaiting_input → queued`，问答史追加一轮，再开一轮 run。

        🔴 是**开新 run**而不是唤醒旧 run：headless 的暂停态只活在 gateway 进程内存里，
        重启即丢。持久的只有这一行 —— 下一轮 run 的 prompt 把 `answers` 全带上，agent
        因此不会把同一个问题再问一遍。
        """
        self._validate_actor(actor)
        answer = self._require_dispatch_answer(text)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(
                conn, dedupe_key, ITEM_DISPATCH_ANSWERED, include_dispatch=True
            )
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            dispatch = self._require_dispatch(conn, matter, dispatch_id)
            prior_job_id = dispatch.get("async_job_id")
            prior_computer_use_draft = self._extract_dispatch_computer_use_draft(
                conn, int(matter["id"]), dispatch
            )
            if prior_computer_use_draft is not None:
                if actor.kind != MatterActorKind.USER.value:
                    raise MatterError(
                        "E_AUTH_FAILED",
                        "computer_use_draft requires a user-initiated dispatch",
                    )
                prior_computer_use_draft = self._validate_resumed_computer_use_draft(
                    dispatch, prior_computer_use_draft
                )
            answers = list(dispatch.get("answers") or [])
            question = dispatch.get("question") or {}
            answers.append(
                {
                    "question": (question or {}).get("question"),
                    "answer": answer,
                    "at": now,
                }
            )
            attempt = int(dispatch["attempt_count"]) + 1
            self._cas_update_rebase(
                conn,
                matter,
                self._anchor_version(matter, expected_version),
                {"updated_at": now, "last_activity_at": now},
                scope=SCOPE_NOTHING,
            )
            if not self.repository.cas_dispatch_state(
                conn,
                dispatch_id,
                expect_state=MatterItemDispatchState.AWAITING_INPUT.value,
                changes={
                    "state": MatterItemDispatchState.QUEUED.value,
                    "question_json": None,
                    "answers_json": self._dump(answers),
                    "attempt_count": attempt,
                    "awaiting_since": None,
                    # 新一轮还没有 job —— 留着上一轮的 job id 会让孤儿收敛把这一轮
                    # 按「上一轮已 failed」当场判死。
                    "async_job_id": None,
                    "updated_at": now,
                },
            ):
                raise self._dispatch_state_conflict(dispatch, "answer")
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=ITEM_DISPATCH_ANSWERED,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=int(dispatch["item_id"]),
                payload={
                    "dispatch_id": dispatch_id,
                    "attempt": attempt,
                    # 🔴 回答正文**不进** payload：它的家是派发行的 `answers`，抄一份到
                    # 操作日志就是同一段话两处存（与进展的 body 同一条取舍）。
                    "answered": True,
                },
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            result = self._mutation(
                after, [event_id], dispatch=self.repository.get_dispatch(conn, dispatch_id)
            )
        if prior_computer_use_draft is None and isinstance(prior_job_id, int) and not isinstance(prior_job_id, bool):
            prior_job = self._jobs().get(prior_job_id)
            if prior_job and isinstance(prior_job.params, Mapping):
                raw_draft = prior_job.params.get("computer_use_draft")
                if raw_draft is not None:
                    prior_computer_use_draft = self._validate_resumed_computer_use_draft(
                        dispatch, raw_draft
                    )
        self._enqueue_dispatch_job(
            public_id,
            matter["id"],
            result["dispatch"],
            attempt=attempt,
            computer_use_draft=prior_computer_use_draft,
        )
        result["dispatch"] = self._reload_dispatch(dispatch_id)
        self._publish_dispatch_changed(public_id, dispatch_id, int(dispatch["item_id"]))
        return result

    def cancel_dispatch(
        self,
        public_id: str,
        dispatch_id: int,
        *,
        expected_version: int | None = None,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        """owner 主动取消（queued / running / awaiting_input → canceled）。

        `proposed` 不在这里 —— 那一步的逆操作是**驳回提案**（走评审面，带理由留档），
        从这里再开一条路只会让同一件事有两种记录形态。
        """
        self._validate_actor(actor)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(
                conn, dedupe_key, ITEM_DISPATCH_CANCELED, include_dispatch=True
            )
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            dispatch = self._require_dispatch(conn, matter, dispatch_id)
            state = str(dispatch["state"])
            if state not in CANCELABLE_DISPATCH_STATES:
                raise self._dispatch_state_conflict(dispatch, "cancel")
            self._cas_update_rebase(
                conn,
                matter,
                self._anchor_version(matter, expected_version),
                {"updated_at": now, "last_activity_at": now},
                scope=SCOPE_NOTHING,
            )
            if not self.repository.cas_dispatch_state(
                conn,
                dispatch_id,
                expect_state=state,
                changes={
                    "state": MatterItemDispatchState.CANCELED.value,
                    "question_json": None,
                    "ended_at": now,
                    "updated_at": now,
                },
            ):
                raise self._dispatch_state_conflict(dispatch, "cancel")
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=ITEM_DISPATCH_CANCELED,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=int(dispatch["item_id"]),
                payload={"dispatch_id": dispatch_id, "from_state": state},
                happened_at=now,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            result = self._mutation(
                after, [event_id], dispatch=self.repository.get_dispatch(conn, dispatch_id)
            )
        # 尽力而为地把还没被认领的 job 一起收掉（省一次 LLM 调用）。抢不到 = worker 已在
        # 跑，它下一次 CAS 会撞上 canceled 态并自行收敛，所以这里失败不影响正确性。
        self._abort_dispatch_job(dispatch.get("async_job_id"), reason=reason)
        self._publish_dispatch_changed(public_id, dispatch_id, int(dispatch["item_id"]))
        return result

    def list_dispatches(
        self, public_id: str, *, item_id: int | None = None
    ) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            return self.repository.list_dispatches(
                conn, matter["id"], item_id=item_id
            )

    def list_live_item_dispatches(
        self, *, states: Sequence[str] | None = None, limit: int = 200
    ) -> dict[str, Any]:
        """跨事项的「需要人处理」的派发（`/today` 例外面第四源）。默认 = 等我回答 / 挂了。

        🔴 `failed` 是终态却必须进面 —— 所以这条读面按 **state** 过滤，不按 `ended_at`。
        """
        wanted = [str(state) for state in (states or DEFAULT_LIVE_DISPATCH_STATES)]
        for state in wanted:
            self._require_value("state", state, MATTER_ITEM_DISPATCH_STATES)
        with self.repository.connect() as conn:
            return {
                "items": self.repository.list_live_item_dispatches(
                    conn, states=wanted, limit=limit
                )
            }

    # ── run 语境的内部迁移（不走用户幂等键；调用方是 worker / 内部 report 端点）──────

    def mark_dispatch_started(self, dispatch_id: int, *, async_job_id: int) -> bool:
        """`queued → running`（worker 认领）。False = 已被取消 / 已在跑 / 行不在了。

        🔴 判据是 CAS 的 rowcount，不是「先读一遍看看是不是 queued」—— 读与写之间的窗口
        正是 CAS 要消灭的东西（async_jobs `claim_next` 同一条纪律）。
        """
        now = self.clock_ms()
        with self._transaction() as conn:
            dispatch = self.repository.get_dispatch(conn, dispatch_id)
            started = dispatch is not None and self.repository.cas_dispatch_state(
                conn,
                dispatch_id,
                expect_state=MatterItemDispatchState.QUEUED.value,
                changes={
                    "state": MatterItemDispatchState.RUNNING.value,
                    "async_job_id": int(async_job_id),
                    "updated_at": now,
                },
            )
        # 认领也要广播：少了这一条，行动项上的「执行中」标识要等到交付那一刻才出现 ——
        # 而那正是 owner 最想看到「它已经开始跑了」的那段时间（提交后发，lossy）。
        if started and dispatch is not None:
            self._publish_dispatch_changed(None, dispatch_id, int(dispatch["item_id"]))
        return started

    def deliver_dispatch(
        self,
        dispatch_id: int,
        *,
        update_id: int | None = None,
        question: Mapping[str, Any] | None = None,
        source: str = "agent_run",
    ) -> dict[str, Any]:
        """run 的交付：要么落成提案（`running → proposed`），要么反问（`→ awaiting_input`）。

        🔴 「二选一且必居其一」的分支约束**在这里判**，不进 tool schema 的 oneOf ——
        schema 顶层分支两次把整条工具链打瘫的前科写在 `run_service._validate_changes`
        上方（D11）。这里拒绝得清清楚楚，agent 当轮就能自纠。
        """
        if (update_id is None) == (question is None):
            raise MatterError(
                "E_INVALID_ARG",
                "deliver exactly one of update_id (changes) or question (needs_input)",
            )
        now = self.clock_ms()
        with self._transaction() as conn:
            dispatch = self.repository.get_dispatch(conn, dispatch_id)
            if dispatch is None:
                raise MatterError(
                    "E_CHILD_NOT_FOUND", f"dispatch {dispatch_id} not found"
                )
            if update_id is not None:
                changes = {
                    "state": MatterItemDispatchState.PROPOSED.value,
                    "update_id": int(update_id),
                    "delivered_at": now,
                    "updated_at": now,
                }
                event_kind = ITEM_DISPATCH_DELIVERED
                payload: dict[str, Any] = {
                    "dispatch_id": dispatch_id,
                    "update_id": int(update_id),
                    "attempt": int(dispatch["attempt_count"]),
                }
            else:
                changes = {
                    "state": MatterItemDispatchState.AWAITING_INPUT.value,
                    "question_json": self._dump(self._require_dispatch_question(question)),
                    "awaiting_since": now,
                    "updated_at": now,
                }
                event_kind = ITEM_DISPATCH_DELIVERED
                payload = {
                    "dispatch_id": dispatch_id,
                    "needs_input": True,
                    "attempt": int(dispatch["attempt_count"]),
                }
            if not self.repository.cas_dispatch_state(
                conn,
                dispatch_id,
                expect_state=MatterItemDispatchState.RUNNING.value,
                changes=changes,
            ):
                raise self._dispatch_state_conflict(dispatch, "deliver")
            self._append_event(
                conn,
                matter_id=int(dispatch["matter_id"]),
                kind=event_kind,
                actor=Actor(kind=MatterActorKind.AGENT.value, actor_id=str(dispatch["executor_id"])),
                source=source,
                dedupe_key=(
                    f"item_dispatch:{dispatch_id}:delivered:{dispatch['attempt_count']}"
                ),
                reason=None,
                item_id=int(dispatch["item_id"]),
                update_id=int(update_id) if update_id is not None else None,
                payload=payload,
                happened_at=now,
            )
            result = self.repository.get_dispatch(conn, dispatch_id)
        self._publish_dispatch_changed(None, dispatch_id, int(dispatch["item_id"]))
        return result or {}

    def fail_dispatch(
        self,
        dispatch_id: int,
        *,
        code: str,
        message: str | None = None,
        source: str = "agent_run",
    ) -> bool:
        """收敛成 failed（run 挂了 / 一轮跑完没交付 / 孤儿）。已终态 → False（幂等 no-op）。"""
        now = self.clock_ms()
        with self._transaction() as conn:
            dispatch = self.repository.get_dispatch(conn, dispatch_id)
            if dispatch is None or dispatch.get("ended_at") is not None:
                return False
            if not self.repository.cas_dispatch_state(
                conn,
                dispatch_id,
                expect_state=str(dispatch["state"]),
                changes={
                    "state": MatterItemDispatchState.FAILED.value,
                    "question_json": None,
                    "ended_at": now,
                    "error_json": self._dump(
                        {"code": code, "message": message} if message else {"code": code}
                    ),
                    "updated_at": now,
                },
            ):
                return False
            self._append_event(
                conn,
                matter_id=int(dispatch["matter_id"]),
                kind=ITEM_DISPATCH_FAILED,
                actor=Actor(kind=MatterActorKind.SYSTEM.value),
                source=source,
                dedupe_key=(
                    f"item_dispatch:{dispatch_id}:failed:{dispatch['attempt_count']}"
                ),
                reason=None,
                item_id=int(dispatch["item_id"]),
                payload={
                    "dispatch_id": dispatch_id,
                    "code": code,
                    "attempt": int(dispatch["attempt_count"]),
                },
                happened_at=now,
            )
        self._publish_dispatch_changed(None, dispatch_id, int(dispatch["item_id"]))
        return True

    def recover_orphaned_dispatches(self) -> int:
        """扫尾：job 已 failed/aborted 而派发仍活跃 → 收敛 failed（镜像
        `MatterRunService.recover_orphaned_runs`）。

        🔴 **绝不 requeue**：LLM run 非幂等，重放一轮孤儿等于让 agent 把没做完的事按
        自己的记忆再演一遍（`async_jobs.recover_orphaned_agents` 同一条硬纪律）。
        """
        with self.repository.connect() as conn:
            ids = self.repository.list_orphaned_dispatch_ids(conn)
        count = 0
        for dispatch_id in ids:
            if self.fail_dispatch(dispatch_id, code="claim_expired"):
                count += 1
        if count:
            logger.warning(
                f"[matter-dispatch] converged {count} orphaned dispatch(es) → failed"
            )
        return count

    def _settle_dispatch_for_update(
        self,
        conn: sqlite3.Connection,
        matter: Mapping[str, Any],
        update: Mapping[str, Any],
        *,
        accepted: bool,
        actor: Actor,
        source: str,
        now: int,
        code: str = "proposal_rejected",
    ) -> None:
        """提案评审 → 派发终态（accept ⇒ done / reject·supersede ⇒ canceled）。

        挂在 accept / reject / supersede 的**同一个事务**里：提案与它的派发必须一起落地，
        否则会出现「提案已采纳，而那条行动项还显示在等 agent 交付」。
        与提案无关（`item_dispatch_id` 为空）时整段 no-op —— 跟进 run 的提案走的就是这条。

        🔴 supersede 那条腿不能省：作废一份派发交付的提案而不结算它的派发行，那一行会永远
        停在 `proposed` —— 提案面看不见（已 superseded）、例外面看不见（`proposed` 不进面）、
        owner 取消不了（`proposed` 不在可取消态里），而 partial unique 还把那条行动项的重派
        一起锁死。`code` 就是为了让这种终局在 `error_json` 里说得出自己是怎么来的。
        """
        raw = update.get("item_dispatch_id")
        if not isinstance(raw, int) or isinstance(raw, bool):
            return
        dispatch = self.repository.get_dispatch(conn, raw, matter_id=int(matter["id"]))
        if dispatch is None or dispatch.get("ended_at") is not None:
            return
        changes: dict[str, Any] = {
            "state": (
                MatterItemDispatchState.DONE.value
                if accepted
                else MatterItemDispatchState.CANCELED.value
            ),
            "ended_at": now,
            "updated_at": now,
        }
        if not accepted:
            changes["error_json"] = self._dump({"code": code})
        # 只结算停在 proposed 的那些 —— 期间被 owner 取消 / 被收敛成 failed 的不强推回来。
        if not self.repository.cas_dispatch_state(
            conn,
            raw,
            expect_state=MatterItemDispatchState.PROPOSED.value,
            changes=changes,
        ):
            return
        self._append_event(
            conn,
            matter_id=int(matter["id"]),
            kind=ITEM_DISPATCH_SETTLED,
            actor=actor,
            source=source,
            dedupe_key=f"item_dispatch:{raw}:settled",
            reason=None,
            item_id=int(dispatch["item_id"]),
            update_id=int(update["id"]),
            payload={
                "dispatch_id": raw,
                "update_id": int(update["id"]),
                "accepted": bool(accepted),
            },
            happened_at=now,
        )

    # ── 派发面的私有 helper ────────────────────────────────────────────────────

    def _require_dispatchable_item(
        self, conn: sqlite3.Connection, matter: Mapping[str, Any], item_id: int
    ) -> dict[str, Any]:
        item = self.repository.get_item(conn, int(matter["id"]), item_id)
        if not item or item.get("deleted_at") is not None:
            raise MatterError("E_CHILD_NOT_FOUND", f"item {item_id} not found")
        if str(item.get("kind")) != MatterItemKind.ACTION.value:
            raise MatterError(
                "E_INVALID_ARG", "only action items can be dispatched to an executor"
            )
        if str(item.get("status") or "") in CLOSED_ITEM_STATUSES:
            raise MatterError(
                "E_INVALID_STATE", f"item is already {item.get('status')}"
            )
        return item

    def _require_dispatch(
        self, conn: sqlite3.Connection, matter: Mapping[str, Any], dispatch_id: int
    ) -> dict[str, Any]:
        dispatch = self.repository.get_dispatch(
            conn, dispatch_id, matter_id=int(matter["id"])
        )
        if dispatch is None:
            raise MatterError("E_CHILD_NOT_FOUND", f"dispatch {dispatch_id} not found")
        return dispatch

    @staticmethod
    def _anchor_version(matter: Mapping[str, Any], expected_version: int | None) -> int:
        """`expected_version` 作 input anchor，**可缺省**（抄 `enqueue_run` 的 D10 语义）。

        缺省时以当前版本重放：派发 / 回答 / 取消都会从 `/today` 例外面发起，而那个面只
        认识派发行，拿不到事项版本号 —— 强制带版本等于把这些动作锁死在详情页里。
        """
        return int(matter["version"]) if expected_version is None else int(expected_version)

    @staticmethod
    def _dispatch_state_conflict(
        dispatch: Mapping[str, Any], operation: str
    ) -> MatterError:
        return MatterError(
            "E_INVALID_STATE",
            f"cannot {operation} a dispatch in state {dispatch.get('state')}",
            hint="Reload the matter — someone (or the run itself) already moved it on.",
        )

    @staticmethod
    def _require_exec_profile(value: Any) -> str:
        profile = str(value or "").strip()
        if profile not in MATTER_ITEM_EXEC_PROFILES:
            raise MatterError(
                "E_INVALID_ARG",
                f"exec_profile must be one of {', '.join(MATTER_ITEM_EXEC_PROFILES)}",
            )
        return profile

    @staticmethod
    def _require_dispatch_answer(value: Any) -> str:
        answer = str(value or "").strip()
        if not answer:
            raise MatterError("E_INVALID_ARG", "answer text is required")
        if len(answer) > MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS:
            raise MatterError(
                "E_INVALID_ARG",
                f"answer exceeds {MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS} characters",
            )
        return answer

    def _require_dispatch_question(
        self, question: Mapping[str, Any] | None
    ) -> dict[str, Any]:
        """反问载荷归一：`{question, options?}`。空问题恒拒 —— 一个问不出问题的
        `awaiting_input` 会让 owner 面对一张写着「等你回答」却没有问题的卡片。"""
        text = self._optional_text((question or {}).get("question"))
        if not text:
            raise MatterError("E_INVALID_ARG", "needs_input requires a question")
        if len(text) > MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS:
            raise MatterError(
                "E_INVALID_ARG",
                f"question exceeds {MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS} characters",
            )
        options = [
            option
            for option in (
                self._optional_text(raw) for raw in ((question or {}).get("options") or [])
            )
            if option
        ]
        result: dict[str, Any] = {"question": text}
        if options:
            result["options"] = options
        return result

    def _resolve_executor(
        self, conn: sqlite3.Connection, executor_id: str | None
    ) -> str:
        """执行器校验：内建跟进 Agent，或一个**启用着的** custom agent。

        🔴 派给一个关掉的（或压根不存在的）agent 必须当场报错：它的表现会是「派发出去了、
        永远不动」——而那正是这一整批要终结的失效形态。
        """
        executor = str(executor_id or "").strip() or MATTER_ITEM_BUILTIN_EXECUTOR
        if executor == MATTER_ITEM_BUILTIN_EXECUTOR:
            return executor
        try:
            row = conn.execute(
                "SELECT type, enabled FROM report_agent WHERE id=?", (executor,)
            ).fetchone()
        except sqlite3.OperationalError:
            row = None
        if row is None or str(row["type"] or "") != "custom":
            raise MatterError("E_INVALID_ARG", f"unknown executor: {executor}")
        if not int(row["enabled"] or 0):
            raise MatterError("E_INVALID_STATE", f"executor is disabled: {executor}")
        return executor

    def _jobs(self):
        if self.job_repo is None:
            from src.sync.async_jobs import AsyncJobRepository

            self.job_repo = AsyncJobRepository(str(self.repository.db_path))
        return self.job_repo

    @staticmethod
    def _validate_resumed_computer_use_draft(
        dispatch: Mapping[str, Any], raw_draft: Any
    ) -> dict[str, list[str]]:
        if (
            str(dispatch.get("exec_profile") or "")
            != MatterItemExecProfile.PROPOSE_ONLY.value
        ):
            raise MatterError(
                "E_INVALID_STATE",
                "computer_use_draft is only permitted with propose_only exec_profile",
            )
        try:
            return normalize_computer_use_draft(raw_draft)
        except ValueError as exc:
            raise MatterError("E_INVALID_ARG", str(exc)) from exc

    @staticmethod
    def _extract_dispatch_computer_use_draft(
        conn: sqlite3.Connection, matter_id: int, dispatch: Mapping[str, Any]
    ) -> Any:
        prior_job_id = dispatch.get("async_job_id")
        if isinstance(prior_job_id, int) and not isinstance(prior_job_id, bool):
            try:
                job_row = conn.execute(
                    "SELECT params_json FROM async_jobs WHERE id = ?",
                    (prior_job_id,),
                ).fetchone()
            except sqlite3.OperationalError:
                job_row = None
            if job_row is not None and job_row[0]:
                try:
                    params = json.loads(job_row[0])
                except (TypeError, json.JSONDecodeError):
                    params = None
                if isinstance(params, Mapping) and "computer_use_draft" in params:
                    return params.get("computer_use_draft")

        event_rows = conn.execute(
            "SELECT payload_json FROM matter_event "
            "WHERE matter_id = ? AND kind = ? AND item_id = ? "
            "ORDER BY id DESC LIMIT 20",
            (matter_id, ITEM_DISPATCHED, int(dispatch["item_id"])),
        ).fetchall()
        dispatch_id = int(dispatch["id"])
        for row in event_rows:
            if not row[0]:
                continue
            try:
                payload = json.loads(row[0])
            except (TypeError, json.JSONDecodeError):
                continue
            if (
                isinstance(payload, Mapping)
                and payload.get("dispatch_id") == dispatch_id
                and "computer_use_draft" in payload
            ):
                return payload.get("computer_use_draft")
        return None

    def _enqueue_dispatch_job(
        self,
        public_id: str,
        matter_id: int,
        dispatch: Mapping[str, Any],
        *,
        attempt: int,
        computer_use_draft: Mapping[str, Any] | None = None,
    ) -> None:
        dispatch_id = int(dispatch["id"])
        job_params: dict[str, Any] = {
            "matter_id": int(matter_id),
            "item_id": int(dispatch["item_id"]),
            "dispatch_id": dispatch_id,
            "attempt": int(attempt),
        }
        if computer_use_draft is not None:
            job_params["computer_use_draft"] = dict(computer_use_draft)
        try:
            job_id, _ = self._jobs().enqueue(
                job_type=MATTER_ITEM_RUN_JOB_TYPE,
                target_kind="matter_item",
                target_key=f"{public_id}:{dispatch['item_id']}",
                params=job_params,
                # 每一轮各一个键：回答之后那一轮是**新的一次执行**，与上一轮去重会让
                # 「回答了但没再跑」变成默认行为。
                idempotency_key=f"item_dispatch:{dispatch_id}:attempt:{attempt}",
            )
        except Exception as exc:  # noqa: BLE001 — enqueue 失败必须收敛，不留悬挂 queued
            logger.error(
                f"[matter-dispatch] enqueue job failed dispatch_id={dispatch_id}: {exc}"
            )
            self.fail_dispatch(
                dispatch_id, code="E_ENQUEUE_FAILED", message=str(exc)
            )
            raise MatterError(
                "E_INTERNAL", "failed to enqueue the item dispatch run"
            ) from exc
        with self._transaction() as conn:
            conn.execute(
                "UPDATE matter_item_dispatch SET async_job_id=? WHERE id=?",
                (int(job_id), dispatch_id),
            )

    def _abort_dispatch_job(self, job_id: Any, *, reason: str | None) -> None:
        if not isinstance(job_id, int) or isinstance(job_id, bool):
            return
        try:
            self._jobs().mark_terminal(
                job_id,
                status="aborted",
                result={"outcome": "stopped", "reason": reason or "user_cancelled"},
                expect_status="queued",
            )
        except Exception as exc:  # noqa: BLE001 — 抢不到只是省不下一次调用，不影响正确性
            logger.warning(f"[matter-dispatch] abort job {job_id} failed: {exc}")

    def _reload_dispatch(self, dispatch_id: int) -> dict[str, Any] | None:
        with self.repository.connect() as conn:
            return self.repository.get_dispatch(conn, dispatch_id)

    def _publish_dispatch_changed(
        self, public_id: str | None, dispatch_id: int, item_id: int
    ) -> None:
        """派发状态迁移 → `matter.item.dispatch.changed`（提交后发；lossy 总线，吞错）。

        🔴 payload 用 **public_id**（前端缓存键用的就是它，内部数字 id 对不上 ——
        `matter.attention` 当年发内部 id 的教训）。
        """
        try:
            if public_id is None:
                with self.repository.connect() as conn:
                    row = conn.execute(
                        "SELECT m.public_id FROM matter_item_dispatch d "
                        "JOIN matter m ON m.id = d.matter_id WHERE d.id=?",
                        (dispatch_id,),
                    ).fetchone()
                if row is None:
                    return
                public_id = str(row["public_id"])
            self._safe_publish(
                "matter.item.dispatch.changed",
                data={
                    "public_id": public_id,
                    "dispatch_id": int(dispatch_id),
                    "item_id": int(item_id),
                },
                source="matter-dispatch",
            )
        except Exception as e:  # pragma: no cover — safe_publish 自己已经 swallow
            logger.debug(f"[matters] dispatch.changed publish swallowed: {e}")
