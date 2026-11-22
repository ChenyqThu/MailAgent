"""Matter update proposals review and scoped CAS ledger mixin for MatterService."""

from __future__ import annotations

import json
import sqlite3
import time
from typing import Any, Mapping

from loguru import logger

from .event_changes import (
    ITEM_CHANGE_FIELDS,
    MATTER_CHANGE_FIELDS,
    build_changes,
    truncated_text,
)
from .events import (
    PROGRESS_ADDED,
    RESOURCE_LINKED,
    UPDATE_ACCEPTED,
    UPDATE_REJECTED,
    UPDATE_SUPERSEDED,
)
from .models import (
    MATTER_HEALTH_VALUES,
    MATTER_ITEM_STATUSES,
    MATTER_PRIORITIES,
    MATTER_STATUSES,
    MATTER_UPDATE_REVIEW_STATUSES,
    MatterActorKind,
    MatterItemKind,
    MatterResourceSummarySource,
    normalize_goal_checks,
)
from .proposal_scope import (
    SCOPE_EVERYTHING,
    SCOPE_NOTHING,
    MatterWriteScope,
    proposal_scope,
    scope_from_payload,
    scope_to_payload,
)
from .resource_identity import MatterError
from .resource_proposal import (
    ResourceProposalError,
    apply_allowed_providers,
    new_resource_spec,
    normalize_new_resource,
)
from .service_common import Actor, proposal_change_count


class _MatterUpdateMixin:
    """Update review, application, and version-scope CAS methods for MatterService."""

    # ── P4: Updates 评审面（D9）────────────────────────────────────────────────

    def list_updates_page(
        self,
        public_id: str,
        *,
        review_status: str | None = None,
        stale: bool | None = None,
        cursor: int | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        if review_status is not None:
            self._require_value(
                "review_status", review_status, MATTER_UPDATE_REVIEW_STATUSES
            )
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            clauses = ["matter_id=?"]
            params: list[Any] = [matter["id"]]
            if review_status is not None:
                clauses.append("review_status=?")
                params.append(review_status)
            if stale is not None:
                clauses.append("is_stale=?")
                params.append(1 if stale else 0)
            if cursor is not None:
                clauses.append("id < ?")
                params.append(cursor)
            params.append(limit + 1)
            rows = conn.execute(
                f"SELECT * FROM matter_update WHERE {' AND '.join(clauses)} "
                "ORDER BY id DESC LIMIT ?",
                params,
            ).fetchall()
            next_cursor = int(rows[limit - 1]["id"]) if len(rows) > limit else None
            items = []
            for row in rows[:limit]:
                full = self.repository._update_row(row)
                items.append(
                    {
                        "id": full["id"],
                        "review_status": full["review_status"],
                        "summary": full["summary"],
                        "created_at": full["created_at"],
                        "change_count": proposal_change_count(
                            full["changes"], full["summary"]
                        ),
                        "is_stale": bool(full["is_stale"]),
                        "agent_run_id": full["agent_run_id"],
                        "confidence": full["confidence"],
                        "anchored_matter_version": full["anchored_matter_version"],
                        "created_by_kind": full["created_by_kind"],
                    }
                )
            return {"items": items, "next_cursor": next_cursor}

    def list_live_updates(
        self,
        *,
        review_status: str = "pending",
        limit: int = 200,
    ) -> dict[str, Any]:
        """跨事项的提案聚合（工作台一次进入只发这一个请求，替代 N + P 次逐条取）。

        返回的是**完整**提案行（含 `changes`）——看板待审阅卡要数引用条数、判有没有字段级
        变化（`MatterFocus` 的 `update.changes`），只给摘要的话前端还得对每条再取一次，
        N+1 就没消掉。

        🔴 `change_count` 必须在这里补上：它是派生字段（不是表列），原来只有 `list_updates_page`
        的摘要投影产出，而详情页的提案横幅与看板卡都读它 —— 少补一个键，那两处当场变成
        「变化 undefined 项」。
        """
        self._require_value(
            "review_status", review_status, MATTER_UPDATE_REVIEW_STATUSES
        )
        with self.repository.connect() as conn:
            grouped = self.repository.list_live_matter_updates(
                conn, review_status=review_status, limit=limit
            )
        return {
            "items": [
                {
                    "matter_public_id": public_id,
                    "updates": [
                        {
                            **update,
                            "change_count": proposal_change_count(
                                update["changes"], update["summary"]
                            ),
                            # 表列是 0/1；摘要投影与前端 `MatterUpdate.is_stale: boolean`
                            # 都按真布尔，这里跟着归一（新契约不留 0/1 与 true/false 两种真值）。
                            "is_stale": bool(update["is_stale"]),
                        }
                        for update in updates
                    ],
                }
                for public_id, updates in grouped.items()
            ]
        }

    def get_update_detail(self, public_id: str, update_id: int) -> dict[str, Any]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            return {"update": self._require_update(conn, matter, update_id)}

    def accept_update(
        self,
        public_id: str,
        update_id: int,
        *,
        selected_change_ids: list[str] | None = None,
        edited_changes: list[Mapping[str, Any]] | None = None,
        edited_summary: str | None = None,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        """接受提案（D9 单事务十步；version 恰 bump 一次；其余 pending 转 superseded）。"""
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(conn, dedupe_key, UPDATE_ACCEPTED)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            update = self._require_update(conn, matter, update_id)
            if update["review_status"] != "pending":
                raise MatterError(
                    "E_UPDATE_ALREADY_REVIEWED",
                    f"update is already {update['review_status']}",
                )
            # 🔴 判据只认物化的 `is_stale`（由 `_mark_stale_proposals` 按目标集重叠写下）。
            # 这里原本还叠了一条 `anchored_matter_version != matter.version` —— 那是"版本号
            # 前进即作废"的另一副面孔：不删掉它，收窄就不生效（无关写入照样把版本号推前，
            # 提案照样被拒）。`expected_version` 的乐观并发保护是另一套（下面 E_VERSION_CONFLICT），
            # 不受影响。
            if bool(update["is_stale"]):
                raise MatterError(
                    "E_UPDATE_STALE",
                    "proposal anchor is stale",
                    hint="Re-run the follow-up agent to get a fresh proposal.",
                )
            if int(matter["version"]) != int(expected_version):
                raise self._version_conflict()
            changes = [c for c in (update["changes"] or []) if isinstance(c, Mapping)]
            by_id = {str(c.get("id")): dict(c) for c in changes}
            if selected_change_ids is None:
                selected = [str(c.get("id")) for c in changes]
            else:
                selected = [str(value) for value in selected_change_ids]
                unknown = sorted(set(selected) - set(by_id))
                if unknown:
                    raise MatterError(
                        "E_INVALID_ARG", f"unknown change ids: {unknown}"
                    )
            selected_set = set(selected)
            edits: dict[str, dict[str, Any]] = {}
            for entry in edited_changes or []:
                edit = dict(entry)
                edit_id = str(edit.get("change_id") or "")
                if edit_id not in by_id:
                    raise MatterError(
                        "E_INVALID_ARG",
                        f"edited change references unknown id: {edit_id}",
                    )
                if edit_id not in selected_set:
                    raise MatterError(
                        "E_INVALID_ARG", f"edited change {edit_id} is not selected"
                    )
                edits[edit_id] = edit
            direct_changes: dict[str, Any] = {
                "updated_at": now,
                "last_activity_at": now,
            }
            applied_events: list[tuple[str, dict[str, Any], int | None, int | None]] = []
            warnings: list[str] = []
            for change_id in selected:
                change = dict(by_id[change_id])
                edit = edits.get(change_id)
                if edit is not None and "after" in edit:
                    change["after"] = edit["after"]
                if edit is not None and edit.get("text") is not None:
                    change["text"] = edit["text"]
                self._apply_accepted_change(
                    conn,
                    matter,
                    update_id,
                    change_id,
                    change,
                    direct_changes=direct_changes,
                    applied_events=applied_events,
                    warnings=warnings,
                    actor=actor,
                    source=source,
                    now=now,
                )
            resolved_summary = (
                edited_summary if edited_summary is not None else update.get("summary")
            )
            reviewed_result = {
                "edited_summary": edited_summary,
                "edited_changes": [edits[cid] for cid in selected if cid in edits],
                "accepted_change_ids": selected,
            }
            conn.execute(
                "UPDATE matter_update SET review_status='accepted', "
                "reviewed_result_json=?, accepted_change_ids_json=?, reviewed_at=?, "
                "reviewed_by_kind=?, reviewed_by_id=?, accepted_at=?, review_reason=? "
                "WHERE id=?",
                (
                    self._dump(reviewed_result),
                    self._dump(selected),
                    now,
                    actor.kind,
                    actor.actor_id,
                    now,
                    reason,
                    update_id,
                ),
            )
            from .attention import AttentionService

            AttentionService(self.repository, clock_ms=self.clock_ms).resolve_subject(
                conn,
                matter_id=int(matter["id"]),
                kind="needs_review",
                subject_key=f"update:{update_id}",
                state="resolved",
                now=now,
                actor=actor,
                source=source,
            )
            # 行动项派发交付的提案：采纳 ⇒ 那次派发 done（同一个事务，否则会出现「提案
            # 已采纳、行动项还显示在等 agent 交付」）。与派发无关的提案整段 no-op。
            self._settle_dispatch_for_update(
                conn, matter, update, accepted=True, actor=actor, source=source, now=now
            )
            direct_changes["latest_accepted_update_id"] = update_id
            if resolved_summary is not None:
                direct_changes.update(
                    {
                        "current_summary": resolved_summary,
                        "summary_at": now,
                        "summary_by_kind": actor.kind,
                        "summary_by_id": actor.actor_id,
                    }
                )
            if not self._cas_update(conn, matter["id"], expected_version, direct_changes):
                raise self._version_conflict()
            self.refresh_search_projection(conn, matter["id"])
            event_ids = [
                self._append_event(
                    conn,
                    matter_id=matter["id"],
                    kind=UPDATE_ACCEPTED,
                    actor=actor,
                    source=source,
                    dedupe_key=dedupe_key,
                    reason=reason,
                    update_id=update_id,
                    payload=self._with_narrative(
                        {
                            "update_id": update_id,
                            "accepted_change_ids": selected,
                        },
                        # 接受提案是**跟进的成果落地**，最该有正文的一条。落库的是
                        # `resolved_summary`（owner 编辑过就用编辑后的），与写进
                        # `current_summary` 的完全是同一段 —— 这段不进时间线时，
                        # 用户只看得到「采纳 3 项」这个数字。
                        resolved_summary,
                    ),
                    happened_at=now,
                    reverses_event_id=reverses_event_id,
                )
            ]
            for index, (kind, payload, item_id, resource_id) in enumerate(applied_events):
                event_ids.append(
                    self._append_event(
                        conn,
                        matter_id=matter["id"],
                        kind=kind,
                        actor=actor,
                        source=source,
                        dedupe_key=f"{dedupe_key}:chg:{index}",
                        reason=None,
                        item_id=item_id,
                        resource_id=resource_id,
                        update_id=update_id,
                        payload=payload,
                        happened_at=now,
                    )
                )
            # superseded 自动化（v1 简化）：同 matter 其余 pending 全部转 superseded。
            others = conn.execute(
                "SELECT id, item_dispatch_id FROM matter_update WHERE matter_id=? "
                "AND review_status='pending' AND id != ?",
                (matter["id"], update_id),
            ).fetchall()
            for row in others:
                conn.execute(
                    "UPDATE matter_update SET review_status='superseded', "
                    "reviewed_at=?, reviewed_by_kind=?, reviewed_by_id=? WHERE id=?",
                    (now, actor.kind, actor.actor_id, row["id"]),
                )
                # 被作废的那份如果是一次行动项派发的交付，它的派发行必须一起收尾 ——
                # 否则那一行停在 `proposed` 且没有任何面看得见它（详见 helper 的 🔴 段）。
                self._settle_dispatch_for_update(
                    conn,
                    matter,
                    {"id": int(row["id"]), "item_dispatch_id": row["item_dispatch_id"]},
                    accepted=False,
                    actor=actor,
                    source=source,
                    now=now,
                    code="proposal_superseded",
                )
                AttentionService(
                    self.repository, clock_ms=self.clock_ms
                ).resolve_subject(
                    conn,
                    matter_id=int(matter["id"]),
                    kind="needs_review",
                    subject_key=f"update:{int(row['id'])}",
                    state="resolved",
                    now=now,
                    actor=Actor(kind="system"),
                    source="matter_review",
                )
                event_ids.append(
                    self._append_event(
                        conn,
                        matter_id=matter["id"],
                        kind=UPDATE_SUPERSEDED,
                        actor=actor,
                        source=source,
                        dedupe_key=f"{dedupe_key}:superseded:{row['id']}",
                        reason=None,
                        update_id=int(row["id"]),
                        payload={
                            "update_id": int(row["id"]),
                            "superseded_by": update_id,
                        },
                        happened_at=now,
                    )
                )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            result = self._mutation(
                after, event_ids, update=self._get_update_row(conn, update_id)
            )
            result["warnings"].extend(warnings)
            return result

    def reject_update(
        self,
        public_id: str,
        update_id: int,
        *,
        reason: str,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        """拒绝提案：不应用、留档 reason（可空）、version 照 bump（REST #3）、无 undo。stale 行可拒。"""
        reason_text = self._optional_text(reason)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(conn, dedupe_key, UPDATE_REJECTED)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            update = self._require_update(conn, matter, update_id)
            if update["review_status"] != "pending":
                raise MatterError(
                    "E_UPDATE_ALREADY_REVIEWED",
                    f"update is already {update['review_status']}",
                )
            if int(matter["version"]) != int(expected_version):
                raise self._version_conflict()
            conn.execute(
                "UPDATE matter_update SET review_status='rejected', reviewed_at=?, "
                "reviewed_by_kind=?, reviewed_by_id=?, rejected_at=?, review_reason=? "
                "WHERE id=?",
                (now, actor.kind, actor.actor_id, now, reason_text, update_id),
            )
            from .attention import AttentionService

            AttentionService(self.repository, clock_ms=self.clock_ms).resolve_subject(
                conn,
                matter_id=int(matter["id"]),
                kind="needs_review",
                subject_key=f"update:{update_id}",
                state="dismissed",
                now=now,
                actor=actor,
                source=source,
            )
            # 驳回一次派发交付 ⇒ 那次派发 canceled（error 记 `proposal_rejected`）。
            # 重派是 owner 的显式动作，不在这里自动开一轮。
            self._settle_dispatch_for_update(
                conn, matter, update, accepted=False, actor=actor, source=source, now=now
            )
            if not self._cas_update(
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now},
                # 拒绝一份提案不写任何业务状态 —— 不该顺带作废并排等审的另一份。
                scope=SCOPE_NOTHING,
            ):
                raise self._version_conflict()
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=UPDATE_REJECTED,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason_text,
                update_id=update_id,
                payload={"update_id": update_id},
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            return self._mutation(
                after, [event_id], update=self._get_update_row(conn, update_id)
            )

    def _field_change_columns(
        self, change_id: str, field: object, value: Any
    ) -> dict[str, Any]:
        """一条 ``kind=field`` 变更 → 要写进 matter 的列。值非法抛 MatterError。

        accept 落库与 propose 入库预检共用这一份判据：坏值在提案入库时就剔掉并回给
        Agent，不留到 owner 点「接受」时才让整份提案失败。"""
        if field == "status":
            self._require_value("status", str(value), MATTER_STATUSES)
            return {"status": str(value)}
        if field == "health":
            self._require_value("health", str(value), MATTER_HEALTH_VALUES)
            return {"health": str(value)}
        if field == "priority":
            self._require_value("priority", str(value), MATTER_PRIORITIES)
            return {"priority": str(value)}
        if field == "due_at":
            if value is not None and not isinstance(value, int):
                raise MatterError(
                    "E_INVALID_ARG", f"change {change_id}: due_at must be int|null"
                )
            # A3 backstop：提案里的 due_at 同样可能是 agent 写的 epoch 秒
            #（propose 侧已 fail-closed 剔除，这里防旧存量/直连 REST）。
            return {"due_at": self._require_epoch_ms("due_at", value)}
        if field == "waiting_context":
            return {"waiting_context_json": self._dump(value) if value is not None else None}
        if field in ("background", "goal"):
            # S3：背景与目标（v61 起两个独立字段）。owner 在评审界面看到全文 diff 后
            # 才会 accept ——「Agent 只能提案、owner 拍板」这条约束在**评审**这一步
            # 兑现，而不是靠让字段不可写。
            return {field: str(value or "")}
        if field == "goal_checks":
            # S3：完成标志。归一走与 patch 路径**同一个**函数 —— 提案里带非法形状
            # （超 20 条 / 超 200 字 / 非对象）时在这里也必须炸，不能因为「是提案
            # 来的」就绕过护栏。
            # 🔴 ValueError → MatterError 与 patch 路径同款包装：不包的话 REST 的
            # `_call` 只认 MatterError，护栏会以 500 而不是 400 的形态漏出去。
            try:
                return {"goal_checks_json": self._dump(list(normalize_goal_checks(value)))}
            except ValueError as exc:
                raise MatterError("E_INVALID_ARG", f"change {change_id}: {exc}") from exc
        raise MatterError(
            "E_INVALID_ARG", f"change {change_id}: field not allowed: {field}"
        )

    def _action_item_patch(
        self, change_id: str, change: Mapping[str, Any]
    ) -> dict[str, Any]:
        """一条改既有行动项的 ``kind=action`` 变更 → item 补丁。值非法抛 MatterError。

        ``after`` 是对象时按键取；是标量时落到 ``target.field`` 指的那一列（没写
        field 才按老约定当 status）—— Agent 写 ``{field: "title", after: "新标题"}``
        时，把新标题当状态去校验会让整份提案接受失败。accept 与 propose 预检共用。"""
        allowed_keys = {
            "title", "description", "status", "priority", "due_at", "completed_at",
        }
        target = change.get("target")
        target_field = target.get("field") if isinstance(target, Mapping) else None
        after = change.get("after")
        item_patch: dict[str, Any] = {}
        if isinstance(after, Mapping):
            item_patch = {key: after[key] for key in after if key in allowed_keys}
        elif isinstance(after, (str, int)):
            if target_field is None:
                item_patch = {"status": after}
            elif target_field in allowed_keys:
                item_patch = {str(target_field): after}
            else:
                raise MatterError(
                    "E_INVALID_ARG",
                    f"action change {change_id}: field not allowed: {target_field}",
                )
        elif after is not None:
            raise MatterError(
                "E_INVALID_ARG",
                f"action change {change_id}: unsupported after shape",
            )
        if change.get("text") is not None and "title" not in item_patch:
            item_patch["title"] = str(change["text"])
        if "status" in item_patch:
            self._require_value("status", str(item_patch["status"]), MATTER_ITEM_STATUSES)
        if "priority" in item_patch and item_patch["priority"] is not None:
            self._require_value(
                "priority", str(item_patch["priority"]), MATTER_PRIORITIES
            )
        for ts_field in ("due_at", "completed_at"):
            if ts_field in item_patch:
                item_patch[ts_field] = self._require_epoch_ms(
                    ts_field, item_patch[ts_field]
                )
        return item_patch

    def _apply_accepted_change(
        self,
        conn: sqlite3.Connection,
        matter: Mapping[str, Any],
        update_id: int,
        change_id: str,
        change: Mapping[str, Any],
        *,
        direct_changes: dict[str, Any],
        applied_events: list[tuple[str, dict[str, Any], int | None, int | None]],
        warnings: list[str],
        actor: Actor,
        source: str,
        now: int,
    ) -> None:
        """逐 change 应用（D9 步骤 4）：field→matter 列；action→item；resource→link
        确认；progress→curated 进展行；fact/inference 只留档不落结构化状态。"""
        kind = str(change.get("kind") or "")
        if kind in ("fact", "inference"):
            return
        if kind == "progress":
            # task 08-25：跟进 run 对进展的**唯一**通道。它拿不到写工具（结构红线 §1），
            # 所以这条 change 只有「追加」一种形态 —— 更正既有进展要 owner 在场，走对话。
            spec = change.get("progress")
            if not isinstance(spec, Mapping):
                raise MatterError(
                    "E_INVALID_ARG",
                    f"progress change {change_id} missing progress payload",
                )
            # backstop：propose 侧已按同一套判据 fail-closed 剔过一轮（§2.2 三道门的第三道）。
            fields = self._progress_insert_fields(spec, now)
            progress_id = self.repository.insert_progress(
                conn,
                {
                    "matter_id": matter["id"],
                    **fields,
                    # 🔴 行的 actor 是 **agent** 而不是点「接受」的那个人：这段脉络是
                    # Agent 写的，owner 只是放行。审计事件那一侧照旧记 owner（下面
                    # `applied_events` 用 accept 的 actor），两件事各自如实。
                    "actor_kind": MatterActorKind.AGENT.value,
                    "actor_id": None,
                    "source": source or "matter_review",
                    "created_at": now,
                    "updated_at": now,
                },
            )
            applied_events.append(
                (
                    PROGRESS_ADDED,
                    {
                        "progress_id": progress_id,
                        "kind": fields["kind"],
                        "title": truncated_text(fields["title"]),
                        "via_update_id": update_id,
                    },
                    None,
                    None,
                )
            )
            return
        if kind == "field":
            target = change.get("target")
            field = target.get("field") if isinstance(target, Mapping) else None
            direct_changes.update(
                self._field_change_columns(change_id, field, change.get("after"))
            )
            # 接受提案落下来的字段变更也要能写成句子（"状态 进行中 → 等待中"）。
            # 前像取 `matter`（进 accept 事务时的快照）—— 同一次 accept 里两条 change 撞同
            # 一个字段是罕见的边角，那时两条事件的 from 都指向接受前的状态，语义仍然自洽。
            applied_events.append(
                (
                    "matter_updated",
                    {
                        "fields": [field],
                        "via_update_id": update_id,
                        "changes": build_changes(
                            [field],
                            matter,
                            {field: direct_changes.get(field)},
                            allowed=MATTER_CHANGE_FIELDS,
                        ),
                    },
                    None,
                    None,
                )
            )
            return
        if kind == "action":
            target = change.get("target")
            if target is None:
                title = self._optional_text(change.get("text") or change.get("after"))
                if not title:
                    raise MatterError(
                        "E_INVALID_ARG", f"action change {change_id} missing title text"
                    )
                item_id = self.repository.insert_item(
                    conn,
                    {
                        "matter_id": matter["id"],
                        "kind": MatterItemKind.ACTION.value,
                        "title": title,
                        "description": self._optional_text(change.get("reason")),
                        "position": 0,
                        **self._normalize_item(
                            MatterItemKind.ACTION.value, {"status": "open"}
                        ),
                        "created_by_kind": actor.kind,
                        "created_by_id": actor.actor_id,
                        "created_at": now,
                        "updated_at": now,
                    },
                )
                applied_events.append(
                    (
                        "item_created",
                        {
                            "kind": "action",
                            "via_update_id": update_id,
                            "title": truncated_text(title),
                        },
                        item_id,
                        None,
                    )
                )
                return
            item_id = target.get("id") if isinstance(target, Mapping) else None
            item = (
                self.repository.get_item(conn, matter["id"], int(item_id))
                if isinstance(item_id, int)
                else None
            )
            if item is None or item.get("deleted_at") is not None:
                raise MatterError(
                    "E_INVALID_STATE",
                    f"action change {change_id}: target item {item_id} not found",
                )
            item_patch = self._action_item_patch(change_id, change)
            if not item_patch:
                warnings.append(f"action_change_noop:{change_id}")
                return
            item_patch["updated_at"] = now
            self.repository.update_item(conn, matter["id"], int(item_id), item_patch)
            patched_fields = sorted(k for k in item_patch if k != "updated_at")
            applied_events.append(
                (
                    "item_updated",
                    {
                        "fields": patched_fields,
                        "via_update_id": update_id,
                        "kind": item.get("kind"),
                        "title": truncated_text(
                            item_patch.get("title", item.get("title"))
                        ),
                        "changes": build_changes(
                            patched_fields, item, item_patch, allowed=ITEM_CHANGE_FIELDS
                        ),
                    },
                    int(item_id),
                    None,
                )
            )
            return
        if kind == "resource":
            spec = new_resource_spec(change)
            if spec is not None:
                self._apply_new_resource_link(
                    conn,
                    matter,
                    update_id,
                    change_id,
                    spec,
                    applied_events=applied_events,
                    warnings=warnings,
                    actor=actor,
                    now=now,
                )
                return
            target = change.get("target")
            resource_id = target.get("id") if isinstance(target, Mapping) else None
            link = (
                self.repository.get_resource_link(
                    conn, matter["id"], int(resource_id), live_only=True
                )
                if isinstance(resource_id, int)
                else None
            )
            if link is None:
                warnings.append(f"resource_change_skipped:{change_id}")
                return
            conn.execute(
                "UPDATE matter_resource SET confirmed_at=COALESCE(confirmed_at, ?), "
                "updated_at=? WHERE id=?",
                (now, now, link["id"]),
            )
            resource = self.repository.get_resource(conn, int(resource_id)) or {}
            applied_events.append(
                (
                    "resource_updated",
                    {
                        "via_update_id": update_id,
                        "confirmed": True,
                        "title": truncated_text(resource.get("title")),
                        "resource_kind": resource.get("kind"),
                    },
                    None,
                    int(resource_id),
                )
            )
            return
        raise MatterError(
            "E_INVALID_ARG", f"change {change_id}: unsupported kind {kind}"
        )

    def _apply_new_resource_link(
        self,
        conn: sqlite3.Connection,
        matter: Mapping[str, Any],
        update_id: int,
        change_id: str,
        spec: Mapping[str, Any],
        *,
        applied_events: list[tuple[str, dict[str, Any], int | None, int | None]],
        warnings: list[str],
        actor: Actor,
        now: int,
    ) -> None:
        """接受一条「新建资料关联」的 change：upsert resource + 建 link + 直接 confirmed。

        owner 是在审阅界面上按下接受的，等于已经审过这份资料 —— 不再走 discovery 那条
        suggested → 手动确认的二段流程（那是给 Agent **自动**挂上来的建议用的）。

        🔴 第二道白名单（``apply_allowed_providers``，静态目录全集）：propose 时已按「已连接
        connector」裁过一遍，这里再验一次身份形状，任意 provider 字符串结构上进不了库。
        失败不抛 —— 单条 change 落不了地不该把整份接受事务掀掉，如实记 warning。

        幂等：同一 external_key 已有 live link → 只确认、不重复建（``resource_already_linked``）；
        整份接受被重放由 ``accept_update`` 的 ``_replay`` 挡在更外层。
        """
        try:
            normalized = normalize_new_resource(
                spec,
                allowed_providers=apply_allowed_providers(),
                exists=lambda provider, kind, key: self.repository.resource_available(
                    conn, provider, kind, key
                ),
            )
        except ResourceProposalError as exc:
            warnings.append(f"resource_link_rejected:{change_id}:{exc.reason}")
            return
        # 提案侧的 `summary` → 资料行的 `sum`（批 M6，H3§6.2「建议阶段就带 sum，用户确认
        # 关联时一并写入，不再等下一次跟进运行」）。🔴 两套键名有意不合并：`summary` 是提案
        # wire 契约（zod / DTO / changes_json 四份手抄，有 parity 闸），`sum` 是 resource 表的
        # 列名；这里是唯一的翻译点。`sum_src` 固定 'agent' —— 邮件类的 'mail' 由
        # `_resource_summary_fields` 从邮件侧推导，模型无从伪造（normalize 已把邮件类的
        # summary 丢成 None）。
        spec_values = dict(normalized)
        summary = spec_values.pop("summary", None)
        # `diff`（批 M7，H3§5.4）与 `summary` 一样是提案 wire 契约上的键、不是 resource
        # 的列 —— 它落的是**版本轨迹**，不是资料行，所以在进 `_upsert_resource` 之前摘掉。
        diff = spec_values.pop("diff", None)
        if summary:
            spec_values["sum"] = summary
            spec_values["sum_src"] = MatterResourceSummarySource.AGENT.value
        resource, _ = self._upsert_resource(conn, spec_values, now)
        resource_id = int(resource["id"])
        # 🔴 顺序：必须在 `_upsert_resource` **之后**（要 resource_id），而 upsert 可能刚把
        # `sum` 覆盖成新版本的摘要 —— 上一版的那份早在 `fetch_url_resource` 检出新 hash
        # 时就已留档，所以这里只补那一行缺的「变了什么」，不再动摘要。
        # 写不进去（这份资料还没有过版本变化 ⇒ 轨迹为空）就静默丢弃：没有"上一版"就没有
        # 差异可言，凭空造一行会把首次关联谎报成一次版本变更。
        if diff:
            self.repository.fill_latest_version_diff(conn, resource_id, diff)
        live = self.repository.get_resource_link(
            conn, matter["id"], resource_id, live_only=True
        )
        if live is not None:
            conn.execute(
                "UPDATE matter_resource SET confirmed_at=COALESCE(confirmed_at, ?), "
                "updated_at=? WHERE id=?",
                (now, now, live["id"]),
            )
            warnings.append(f"resource_already_linked:{change_id}")
            applied_events.append(
                (
                    "resource_updated",
                    {
                        "via_update_id": update_id,
                        "confirmed": True,
                        "title": truncated_text(resource.get("title")),
                        "resource_kind": resource.get("kind"),
                    },
                    None,
                    resource_id,
                )
            )
            return
        deleted = self.repository.get_resource_link(conn, matter["id"], resource_id)
        if deleted is not None:
            # owner 曾经解除过关联，现在又接受了同一份 —— 复活那一行（与 discovery 同习语），
            # 不新插一条，否则 (matter_id, resource_id) 会撞唯一约束。
            conn.execute(
                "UPDATE matter_resource SET deleted_at=NULL, confirmed_at=?, "
                "added_by_kind=?, added_by_id=?, updated_at=? WHERE id=?",
                (now, actor.kind, actor.actor_id, now, deleted["id"]),
            )
            link_id = int(deleted["id"])
        else:
            link_id = self.repository.insert_resource_link(
                conn,
                {
                    "matter_id": matter["id"],
                    "resource_id": resource_id,
                    "relation_type": None,
                    "pinned": 0,
                    # 提案是 Agent 写的，link 的来源如实记 agent（owner 的动作是"接受"，
                    # 留在 update_accepted 事件与 via_update_id 上）。
                    "added_by_kind": "agent",
                    "added_by_id": None,
                    "confidence": None,
                    "provenance_json": self._dump(
                        {"via_update_id": update_id, "change_id": change_id}
                    ),
                    "confirmed_at": now,
                    "sub_state": "none",
                    "created_at": now,
                    "updated_at": now,
                },
            )
        applied_events.append(
            (
                RESOURCE_LINKED,
                {
                    "link_id": link_id,
                    "via_update_id": update_id,
                    "confirmed": True,
                    "title": truncated_text(resource.get("title")),
                    "resource_kind": resource.get("kind"),
                },
                None,
                resource_id,
            )
        )

    def _require_update(
        self, conn: sqlite3.Connection, matter: Mapping[str, Any], update_id: int
    ) -> dict[str, Any]:
        row = conn.execute(
            "SELECT * FROM matter_update WHERE id=? AND matter_id=?",
            (update_id, matter["id"]),
        ).fetchone()
        if row is None:
            raise MatterError("E_CHILD_NOT_FOUND", f"update {update_id} not found")
        return self.repository._update_row(row)

    def _get_update_row(
        self, conn: sqlite3.Connection, update_id: int
    ) -> dict[str, Any] | None:
        row = conn.execute(
            "SELECT * FROM matter_update WHERE id=?", (update_id,)
        ).fetchone()
        return self.repository._update_row(row) if row else None

    def _cas_update(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        expected_version: int,
        changes: Mapping[str, Any],
        *,
        scope: MatterWriteScope | None = None,
    ) -> bool:
        """cas_update_matter 的**唯一** service 出口：bump 成功即触发 stale 钩子（D9）。

        所有 bump version 的写路径都必须走这里 —— 与本次写入**目标有重叠**的 pending 提案
        随之失效（is_stale 物化，幂等 UPDATE），accept 对 stale 行硬拒 E_UPDATE_STALE。

        `scope` = 本次写入实际触及的对象集（matter 字段 / item id / resource id）。
        🔴 缺省 `None` 是 **fail-closed**：调用方没声明触及了什么 ⇒ 当作触及一切 ⇒ 照旧作废
        全部 pending 提案。收窄是逐个调用点显式声明出来的，不是默认得来的。
        """
        ok = self.repository.cas_update_matter(conn, matter_id, expected_version, changes)
        if ok:
            effective_scope = scope if scope is not None else SCOPE_EVERYTHING
            new_version = int(expected_version) + 1
            self._mark_stale_proposals(conn, matter_id, new_version, effective_scope)
            self._record_version_scope(conn, matter_id, new_version, effective_scope)
        return ok

    def _cas_update_rebase(
        self,
        conn: sqlite3.Connection,
        matter: Mapping[str, Any],
        expected_version: int,
        changes: Mapping[str, Any],
        *,
        scope: MatterWriteScope,
    ) -> None:
        """子实体写入的 CAS：stale base 只在**目标重叠**时才算冲突（0813 A2）。

        动机：Agent 并行追加 9 个子实体（item/stakeholder/resource）时，第一笔就把
        matter.version 推前，其余 8 笔全被钝化的 matter 级 CAS 拒掉 —— 但追加与
        「别人没碰过的行」的编辑根本没有可失去的更新。判据换成版本账本的 gap scan：

        - `expected_version == 当前` → 与旧行为逐字节一致；
        - `expected_version < 当前` → 取 (expected, current] 之间每次 bump 落下的
          `MatterWriteScope`（`_record_version_scope` 账本），有任何一笔与本次写入目标
          重叠（含 wildcard 级写入，如归档/接受提案）→ `E_VERSION_CONFLICT`；账本
          覆盖不完整（老库存量 / 账本写入失败过）→ 同样冲突（fail-closed，即旧行为）；
          全不重叠 → 以**当前**版本重放（auto-rebase），bump 照常。
        - `expected_version > 当前` → 凭空的未来版本，直接冲突。

        🔴 只给子实体路径用。matter 级字段写（patch_matter/归档/接受提案…）保持严格
        CAS —— 「两处同时改 matter 的 state/goal 必须被挡」是拍板过的语义。
        """
        current = int(matter["version"])
        expected = int(expected_version)
        if expected != current:
            if expected > current or self._gap_conflicts(
                conn, int(matter["id"]), expected, current, scope
            ):
                raise self._version_conflict()
        if not self._cas_update(conn, int(matter["id"]), current, changes, scope=scope):
            raise self._version_conflict()

    def _gap_conflicts(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        expected: int,
        current: int,
        scope: MatterWriteScope,
    ) -> bool:
        """(expected, current] 区间内是否存在与 `scope` 重叠的写入（或判据缺失）。"""
        entries = self._load_version_scopes(conn, matter_id)
        gap = {version: entry for version, entry in entries if expected < version <= current}
        if set(gap) != set(range(expected + 1, current + 1)):
            return True  # 账本盖不住整个 gap → fail closed（等价于旧的严格 CAS）
        return any(entry.overlaps(scope) for entry in gap.values())

    #: 每个事项在版本账本里最多保留的 bump 条目数。9 笔并行写的 gap 是个位数；64 只是
    #: 防账本无界增长的护栏 —— 比它更老的 stale base 会因覆盖不完整而回到严格 CAS。
    VERSION_SCOPE_RETENTION = 64

    @staticmethod
    def _version_scope_state_key(matter_id: int) -> str:
        return f"matter_version_scopes:{matter_id}"

    def _load_version_scopes(
        self, conn: sqlite3.Connection, matter_id: int
    ) -> list[tuple[int, MatterWriteScope]]:
        try:
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key=?",
                (self._version_scope_state_key(matter_id),),
            ).fetchone()
        except sqlite3.OperationalError:
            return []
        if row is None or not row[0]:
            return []
        try:
            parsed = json.loads(row[0])
        except (TypeError, ValueError):
            return []
        if not isinstance(parsed, list):
            return []
        entries: list[tuple[int, MatterWriteScope]] = []
        for item in parsed:
            if not isinstance(item, Mapping):
                continue
            version = item.get("version")
            if isinstance(version, bool) or not isinstance(version, int):
                continue
            # scope 形状不对 → scope_from_payload fail-closed 成 wildcard，
            # gap scan 会把它当成与一切重叠的写入（保守拒绝）。
            entries.append((int(version), scope_from_payload(item.get("scope"))))
        return entries

    def _record_version_scope(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        new_version: int,
        scope: MatterWriteScope,
    ) -> None:
        """把这次 bump 的目标集追加进 sync_state 账本（`matter_version_scopes:{id}`）。

        账本是**可丢**的簿记（丢了 = stale 写回到严格 CAS，绝不会放过真冲突），所以任何
        写入失败只降级不阻断业务写；键落 sync_state 沿用 `alert.*`/`davmail.*` 先例，
        不 bump DB_VERSION。
        """
        try:
            entries = [
                {"version": version, "scope": scope_to_payload(entry_scope)}
                for version, entry_scope in self._load_version_scopes(conn, matter_id)
                if version < new_version
            ]
            entries.append({"version": new_version, "scope": scope_to_payload(scope)})
            entries = entries[-self.VERSION_SCOPE_RETENTION :]
            conn.execute(
                "INSERT OR REPLACE INTO sync_state(key, value, updated_at) VALUES (?,?,?)",
                (
                    self._version_scope_state_key(matter_id),
                    self._dump(entries),
                    time.time(),
                ),
            )
        except sqlite3.OperationalError as exc:
            logger.warning(
                f"[matters] version scope ledger write failed matter_id={matter_id}: {exc}"
            )

    def _mark_stale_proposals(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        new_version: int,
        scope: MatterWriteScope,
    ) -> None:
        """把与本次写入**目标有重叠**的 pending 提案标 stale。

        判据是「证据变了」而不是「版本号前进了」：owner 在评审期间点 12 次「接受资料建议」+
        4 次改标签，不该把正等着他审的那份提案作废掉。反过来，任何推导不出目标的情况
        （`scope.wildcard` / 提案 changes_json 形状认不出）都按重叠处理 —— 见
        `proposal_scope` 模块的 fail-closed 纪律。

        🔴 提案里「新建资料关联」那种 change 要**查库**才知道是不是纯追加：accept 会复活
        owner 解除过的 link（`_apply_new_resource_link`），所以身份解析器必须在场。
        """
        candidates = conn.execute(
            "SELECT id, changes_json FROM matter_update "
            "WHERE matter_id=? AND review_status='pending' AND is_stale=0 "
            "AND anchored_matter_version < ?",
            (matter_id, new_version),
        ).fetchall()
        if not candidates:
            return
        now = self.clock_ms()
        for row in candidates:
            touched = proposal_scope(
                row["changes_json"],
                resolve_new_resource=lambda spec: self._existing_link_resource_id(
                    conn, matter_id, spec
                ),
            )
            if not scope.overlaps(touched):
                continue
            conn.execute(
                "UPDATE matter_update SET is_stale=1, stale_at=?, "
                "stale_reason='matter_version_advanced' WHERE id=?",
                (now, int(row["id"])),
            )

    def _existing_link_resource_id(
        self, conn: sqlite3.Connection, matter_id: int, spec: Mapping[str, Any]
    ) -> int | None:
        """提案里那份「新建关联」的资料，本事项**已经**有过一条 link 吗？

        返回既有 `resource_id`（含 owner 解除过的 soft-deleted 行 —— 那正是 accept 会去
        复活的那一行），从没关联过则 None（= 真·全新，纯追加）。身份归一走 accept 侧同一个
        `normalize_new_resource`（accept 白名单是 propose 白名单的超集，所以服务端已归一
        入库的 spec 在这里必然过），推导不出 → 抛出，由 `proposal_scope` fail closed。
        """
        normalized = normalize_new_resource(
            spec, allowed_providers=apply_allowed_providers()
        )
        row = conn.execute(
            "SELECT mr.resource_id FROM matter_resource mr "
            "JOIN resource r ON r.id=mr.resource_id "
            "WHERE mr.matter_id=? AND r.provider=? AND r.external_key=? "
            "ORDER BY mr.id DESC LIMIT 1",
            (matter_id, normalized["provider"], normalized["external_key"]),
        ).fetchone()
        return int(row[0]) if row is not None else None
