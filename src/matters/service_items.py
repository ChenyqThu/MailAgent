"""Matter items, notes, and timeline projection mixin for MatterService."""

from __future__ import annotations

from typing import Any, Mapping

from .event_changes import ITEM_CHANGE_FIELDS, build_changes, truncated_text
from .events import ITEM_CREATED
from .models import (
    MATTER_ACTOR_KINDS,
    MATTER_ITEM_KINDS,
    MATTER_ITEM_STATUSES,
    MATTER_PRIORITIES,
    MatterItemKind,
)
from .proposal_scope import SCOPE_NOTHING, scope_from_items
from .resource_identity import MatterError
from .service_common import ACTION_ONLY_ITEM_FIELDS, Actor


class _MatterItemMixin:
    """Item CRUD, notes, timeline, and normalization methods for MatterService."""

    def create_item(
        self,
        public_id: str,
        data: Mapping[str, Any],
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        kind = str(data.get("kind") or "")
        title = str(data.get("title") or "").strip()
        self._require_value("kind", kind, MATTER_ITEM_KINDS)
        if not title:
            raise MatterError("E_INVALID_ARG", "item title is required")
        normalized = self._normalize_item(kind, data)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(conn, dedupe_key, "item_created", include_item=True)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 新建 item：纯追加，没有任何既有对象被改 → 不作废任何提案，
                # stale base 也不构成冲突（auto-rebase）。
                scope=SCOPE_NOTHING,
            )
            description = self._optional_text(data.get("description"))
            item_id = self.repository.insert_item(
                conn,
                {
                    "matter_id": matter["id"],
                    "kind": kind,
                    "title": title,
                    "description": description,
                    "position": int(data.get("position") or 0),
                    **normalized,
                    "created_by_kind": actor.kind,
                    "created_by_id": actor.actor_id,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=ITEM_CREATED,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                # title = 句子必需的标识（"新增待解问题「…」"）；光有 item_id 写不出来。
                payload=self._with_narrative(
                    {"kind": kind, "title": truncated_text(title)},
                    # 🔴 只有**备注**是叙述类：它的全部意义就是那段正文。行动项/待解问题的
                    # description 是背景说明，进时间线只会把「新增了什么」这句话淹掉。
                    # 取 description 优先、退回 title：`POST /notes` 在没给标题时把正文
                    # 同时写进两处（`title = body.title or body.text`），两边都得能取到全文
                    # —— payload 里的 title 已经被截到 120 字，它当不了正文。
                    (description or title)
                    if kind == MatterItemKind.NOTE.value
                    else None,
                ),
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            return self._mutation(
                after,
                [event_id],
                item=self.repository.get_item(conn, matter["id"], item_id),
                undo=self._undo_descriptor(
                    "matter_item_mutate",
                    "撤销新增事项条目",
                    {"public_id": public_id, "operation": "delete", "item_id": item_id},
                    after,
                    event_id,
                ),
            )

    def update_item(
        self, public_id: str, item_id: int, patch: Mapping[str, Any], **mutation: Any
    ):
        return self._mutate_item(public_id, item_id, patch, "item_updated", **mutation)

    def delete_item(self, public_id: str, item_id: int, **mutation: Any):
        return self._mutate_item(
            public_id,
            item_id,
            {"deleted_at": self.clock_ms()},
            "item_deleted",
            **mutation,
        )

    def restore_item(self, public_id: str, item_id: int, **mutation: Any):
        return self._mutate_item(
            public_id, item_id, {"deleted_at": None}, "item_restored", **mutation
        )

    def list_items(self, public_id: str, **filters: Any) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            return self.repository.list_items(conn, matter["id"], **filters)

    def timeline(
        self, public_id: str, *, cursor: int | None, limit: int
    ) -> dict[str, Any]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            items, next_cursor = self.repository.list_events(
                conn, matter["id"], cursor=cursor, limit=limit
            )
            return {"items": items, "next_cursor": next_cursor}

    def add_note(
        self, public_id: str, data: Mapping[str, Any], **mutation: Any
    ) -> dict[str, Any]:
        note = dict(data)
        note["kind"] = MatterItemKind.NOTE.value
        return self.create_item(public_id, note, **mutation)

    def _mutate_item(
        self,
        public_id: str,
        item_id: int,
        patch: Mapping[str, Any],
        event_kind: str,
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind, include_item=True)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            item = self.repository.get_item(conn, matter["id"], item_id)
            if not item:
                raise MatterError("E_CHILD_NOT_FOUND", f"item {item_id} not found")
            changes = dict(patch)
            kind = str(changes.get("kind", item["kind"]))
            self._require_value("kind", kind, MATTER_ITEM_KINDS)
            if "title" in changes:
                changes["title"] = str(changes["title"] or "").strip()
                if not changes["title"]:
                    raise MatterError("E_INVALID_ARG", "item title cannot be empty")
            combined = {**item, **changes}
            normalized = self._normalize_item(kind, combined)
            if kind != MatterItemKind.ACTION.value:
                normalized = {
                    key: value for key, value in normalized.items() if key != "kind"
                }
            changes.update(normalized)
            changes["kind"] = kind
            changes["updated_at"] = now
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 只有 target 落在这条 item 上的提案才失效；stale base 也只有在
                # 这条 item 被并发改过时才冲突（auto-rebase）。
                scope=scope_from_items([item_id]),
            )
            if not self.repository.update_item(conn, matter["id"], item_id, changes):
                raise MatterError("E_CHILD_NOT_FOUND", f"item {item_id} not found")
            self.refresh_search_projection(conn, matter["id"])
            item_after = self.repository.get_item(conn, matter["id"], item_id)
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=event_kind,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                payload={
                    "fields": sorted(patch),
                    # 标识（句子必需）+ 值级前后像。delete/restore 的 patch 只有
                    # deleted_at，不在 ITEM_CHANGE_FIELDS 里 → changes 为空数组，
                    # 由事件 kind 自己叙述。
                    "kind": kind,
                    "title": truncated_text((item_after or item).get("title")),
                    "changes": build_changes(
                        patch, item, item_after, allowed=ITEM_CHANGE_FIELDS
                    ),
                },
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            if event_kind == "item_deleted":
                reverse_input = {"public_id": public_id, "operation": "restore", "item_id": item_id}
            elif event_kind == "item_restored":
                reverse_input = {"public_id": public_id, "operation": "delete", "item_id": item_id}
            else:
                reversible_fields = {
                    key: item.get(key)
                    for key in patch
                    if key
                    in {
                        "kind",
                        "title",
                        "description",
                        "position",
                        "status",
                        "priority",
                        "owner_kind",
                        "owner_id",
                        "waiting_on_stakeholder_id",
                        "due_at",
                        "completed_at",
                        "checklist",
                        # 🔴 新增可写字段必须同步进这个前像名单，漏了 = 「撤销成功但那个
                        # 字段一动不动」（patch_matter 踩过这个坑，见 UNDOABLE_PATCH_FIELDS）。
                        "exec_profile",
                        "source_resource_id",
                        "source_locator",
                    }
                }
                reverse_input = {
                    "public_id": public_id,
                    "operation": "update",
                    "item_id": item_id,
                    "patch": reversible_fields,
                }
            return self._mutation(
                after,
                [event_id],
                item=item_after,
                undo=self._undo_descriptor(
                    "matter_item_mutate",
                    "撤销条目变更",
                    reverse_input,
                    after,
                    event_id,
                ),
            )

    def _normalize_item(self, kind: str, data: Mapping[str, Any]) -> dict[str, Any]:
        if kind != MatterItemKind.ACTION.value:
            offending = [
                field
                for field in ACTION_ONLY_ITEM_FIELDS
                if data.get(field) not in (None, [], ())
            ]
            if offending:
                raise MatterError(
                    "E_INVALID_ARG",
                    f"non-action item cannot set action fields: {sorted(offending)}",
                )
            return {
                "status": None,
                "priority": None,
                "owner_kind": None,
                "owner_id": None,
                "waiting_on_stakeholder_id": None,
                "due_at": None,
                "completed_at": None,
                "checklist_json": "[]",
                "exec_profile": None,
                "source_resource_id": data.get("source_resource_id"),
                "source_locator_json": self._dump(data["source_locator"])
                if data.get("source_locator") is not None
                else None,
            }
        status = data.get("status") or "open"
        priority = data.get("priority")
        self._require_value("status", str(status), MATTER_ITEM_STATUSES)
        if priority is not None:
            self._require_value("priority", str(priority), MATTER_PRIORITIES)
        owner_kind = data.get("owner_kind")
        if owner_kind is not None:
            self._require_value("owner_kind", str(owner_kind), MATTER_ACTOR_KINDS)
        checklist = data.get("checklist") or []
        if not isinstance(checklist, list):
            raise MatterError("E_INVALID_ARG", "checklist must be a list")
        seen_ids: set[str] = set()
        normalized_checklist = []
        for entry in checklist:
            if not isinstance(entry, Mapping):
                raise MatterError("E_INVALID_ARG", "checklist entries must be objects")
            entry_id = str(entry.get("id") or "").strip()
            text = str(entry.get("text") or "").strip()
            if not entry_id or not text or entry_id in seen_ids:
                raise MatterError(
                    "E_INVALID_ARG", "checklist entries need unique stable id and text"
                )
            seen_ids.add(entry_id)
            normalized_checklist.append(
                {"id": entry_id, "text": text, "done": bool(entry.get("done"))}
            )
        return {
            "status": str(status),
            "priority": priority,
            "owner_kind": owner_kind,
            "owner_id": data.get("owner_id"),
            "waiting_on_stakeholder_id": data.get("waiting_on_stakeholder_id"),
            "due_at": self._require_epoch_ms("due_at", data.get("due_at")),
            "completed_at": self._require_epoch_ms("completed_at", data.get("completed_at")),
            "checklist_json": self._dump(normalized_checklist),
            # NULL = 没选过 = 出厂档 propose_only。显式落 NULL 而不是把默认值物化进列里：
            # 「owner 明确选了 propose_only」与「还没选过」在未来改默认档时不是一回事。
            "exec_profile": (
                self._require_exec_profile(data.get("exec_profile"))
                if data.get("exec_profile")
                else None
            ),
            "source_resource_id": data.get("source_resource_id"),
            "source_locator_json": self._dump(data["source_locator"])
            if data.get("source_locator") is not None
            else None,
        }
