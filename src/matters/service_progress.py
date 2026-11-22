"""Matter curated progress lane mixin for MatterService."""

from __future__ import annotations

from typing import Any, Mapping

from .event_changes import truncated_text
from .events import PROGRESS_ADDED, PROGRESS_REMOVED, PROGRESS_RESTORED, PROGRESS_UPDATED
from .models import (
    MATTER_PROGRESS_BODY_MAX_CHARS,
    MATTER_PROGRESS_KINDS,
    MATTER_PROGRESS_TITLE_MAX_CHARS,
    normalize_progress_refs,
)
from .proposal_scope import SCOPE_NOTHING, scope_from_progress
from .resource_identity import MatterError
from .service_common import Actor

# 进展条目的可编辑字段（task 08-25）。撤销的前像只快照这些 —— `deleted_at` 有意不在内：
# 删除 / 恢复的反向操作是另一颗按钮（operation restore / delete），不是 patch 回一个时间戳。
PROGRESS_PATCH_FIELDS = {"kind", "title", "body", "happened_at", "refs"}


class _MatterProgressMixin:
    """Curated progress lane CRUD and validation methods for MatterService."""

    # ==================== curated 进展 lane（task 08-25）====================
    # 🔴 与 `matter_item` 的关系见 `MatterProgressKind` 的 docstring：item 是**工作对象**，
    # progress 是**叙事节点**。进展不进搜索投影（v1 有意不做）—— 检索面现在按 items /
    # notes / stakeholders 三个桶组织，加第四个桶要重建 fts5 并动 `matched_fields` 这层
    # 对外契约，而「进展里搜关键词」还没有被点名的需求。

    def add_progress(
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
        now = self.clock_ms()
        fields = self._progress_insert_fields(data, now)
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(
                conn, dedupe_key, PROGRESS_ADDED, include_progress=True
            )
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 记一条进展：纯追加，没有任何既有对象被改 → 不作废任何提案，
                # stale base 也不构成冲突（auto-rebase），与 create_item 同判据。
                scope=SCOPE_NOTHING,
            )
            progress_id = self.repository.insert_progress(
                conn,
                {
                    "matter_id": matter["id"],
                    **fields,
                    "actor_kind": actor.kind,
                    "actor_id": actor.actor_id,
                    "source": source or "desktop_ui",
                    "created_at": now,
                    "updated_at": now,
                },
            )
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=PROGRESS_ADDED,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                # 🔴 正文**不进**事件 payload：进展本身就是那段正文的家，抄一份到操作日志
                # 等于同一段话两处存（改一处漏一处），而操作日志要回答的是「谁动了哪条」。
                payload={
                    "progress_id": progress_id,
                    "kind": fields["kind"],
                    "title": truncated_text(fields["title"]),
                },
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            return self._mutation(
                after,
                [event_id],
                progress=self.repository.get_progress(
                    conn, matter["id"], progress_id
                ),
                undo=self._undo_descriptor(
                    "matter_progress_mutate",
                    "撤销新增进展",
                    {
                        "public_id": public_id,
                        "operation": "delete",
                        "progress_id": progress_id,
                    },
                    after,
                    event_id,
                ),
            )

    def update_progress(
        self, public_id: str, progress_id: int, patch: Mapping[str, Any], **mutation: Any
    ) -> dict[str, Any]:
        return self._mutate_progress(
            public_id, progress_id, patch, PROGRESS_UPDATED, **mutation
        )

    def delete_progress(
        self, public_id: str, progress_id: int, **mutation: Any
    ) -> dict[str, Any]:
        return self._mutate_progress(
            public_id,
            progress_id,
            {"deleted_at": self.clock_ms()},
            PROGRESS_REMOVED,
            **mutation,
        )

    def restore_progress(
        self, public_id: str, progress_id: int, **mutation: Any
    ) -> dict[str, Any]:
        return self._mutate_progress(
            public_id, progress_id, {"deleted_at": None}, PROGRESS_RESTORED, **mutation
        )

    def list_progress(
        self,
        public_id: str,
        *,
        kind: str | None = None,
        include_deleted: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            return self.repository.list_progress(
                conn,
                matter["id"],
                kind=kind,
                include_deleted=include_deleted,
                limit=limit,
            )

    def _mutate_progress(
        self,
        public_id: str,
        progress_id: int,
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
        changes = self._progress_patch_fields(patch)
        with self._transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind, include_progress=True)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            progress = self.repository.get_progress(conn, matter["id"], progress_id)
            if not progress:
                raise MatterError(
                    "E_CHILD_NOT_FOUND", f"progress {progress_id} not found"
                )
            changes["updated_at"] = now
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 只有打到**同一条**进展的并发写才算冲突（auto-rebase，形照 item）。
                scope=scope_from_progress([progress_id]),
            )
            if not self.repository.update_progress(
                conn, matter["id"], progress_id, changes
            ):
                raise MatterError(
                    "E_CHILD_NOT_FOUND", f"progress {progress_id} not found"
                )
            progress_after = self.repository.get_progress(
                conn, matter["id"], progress_id
            )
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=event_kind,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                payload={
                    "progress_id": progress_id,
                    "fields": sorted(patch),
                    "kind": (progress_after or progress).get("kind"),
                    "title": truncated_text((progress_after or progress).get("title")),
                },
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            if event_kind == PROGRESS_REMOVED:
                reverse_input = {
                    "public_id": public_id,
                    "operation": "restore",
                    "progress_id": progress_id,
                }
            elif event_kind == PROGRESS_RESTORED:
                reverse_input = {
                    "public_id": public_id,
                    "operation": "delete",
                    "progress_id": progress_id,
                }
            else:
                reverse_input = {
                    "public_id": public_id,
                    "operation": "update",
                    "progress_id": progress_id,
                    "patch": {
                        key: progress.get(key)
                        for key in patch
                        if key in PROGRESS_PATCH_FIELDS
                    },
                }
            return self._mutation(
                after,
                [event_id],
                progress=progress_after,
                undo=self._undo_descriptor(
                    "matter_progress_mutate",
                    "撤销进展变更",
                    reverse_input,
                    after,
                    event_id,
                ),
            )

    def _progress_insert_fields(
        self, data: Mapping[str, Any], now: int
    ) -> dict[str, Any]:
        """新建一条进展的列值（三条写入口共用，含提案 accept 的 backstop）。"""
        kind = str(data.get("kind") or "")
        self._require_value("kind", kind, MATTER_PROGRESS_KINDS)
        return {
            "kind": kind,
            "title": self._require_progress_title(data.get("title")),
            "body": self._require_progress_body(data.get("body")),
            # 缺省 = 现在。补记往事的人自己给 happened_at；不给就是「刚发生」。
            "happened_at": self._require_epoch_ms(
                "happened_at", data.get("happened_at")
            )
            or now,
            "refs_json": self._dump(self._require_progress_refs(data.get("refs"))),
        }

    def _progress_patch_fields(self, patch: Mapping[str, Any]) -> dict[str, Any]:
        """进展编辑的列值。未知键一律拒 —— 静默丢弃会让「改了但没生效」无从发现。"""
        changes: dict[str, Any] = {}
        for key, value in patch.items():
            if key == "kind":
                kind = str(value or "")
                self._require_value("kind", kind, MATTER_PROGRESS_KINDS)
                changes["kind"] = kind
            elif key == "title":
                changes["title"] = self._require_progress_title(value)
            elif key == "body":
                changes["body"] = self._require_progress_body(value)
            elif key == "happened_at":
                happened_at = self._require_epoch_ms("happened_at", value)
                if happened_at is None:
                    raise MatterError(
                        "E_INVALID_ARG", "progress happened_at cannot be cleared"
                    )
                changes["happened_at"] = happened_at
            elif key == "refs":
                changes["refs_json"] = self._dump(self._require_progress_refs(value))
            elif key == "deleted_at":
                # 软删 / 恢复由 delete_progress / restore_progress 内部下发，不走外部 patch
                # 白名单（REST / 工具的 patch schema 里没有这个键）。
                changes["deleted_at"] = value
            else:
                raise MatterError(
                    "E_INVALID_ARG", f"progress field is not editable: {key}"
                )
        if not changes:
            raise MatterError("E_INVALID_ARG", "progress patch is empty")
        return changes

    @staticmethod
    def _require_progress_title(value: Any) -> str:
        title = str(value or "").strip()
        if not title:
            raise MatterError("E_INVALID_ARG", "progress title is required")
        if len(title) > MATTER_PROGRESS_TITLE_MAX_CHARS:
            raise MatterError(
                "E_INVALID_ARG",
                f"progress title exceeds {MATTER_PROGRESS_TITLE_MAX_CHARS} characters",
            )
        return title

    @classmethod
    def _require_progress_body(cls, value: Any) -> str | None:
        body = cls._optional_text(value)
        if body is not None and len(body) > MATTER_PROGRESS_BODY_MAX_CHARS:
            raise MatterError(
                "E_INVALID_ARG",
                f"progress body exceeds {MATTER_PROGRESS_BODY_MAX_CHARS} characters",
            )
        return body

    @staticmethod
    def _require_progress_refs(value: Any) -> list[dict[str, Any]]:
        if value is None:
            return []
        if not isinstance(value, (list, tuple)):
            raise MatterError("E_INVALID_ARG", "progress refs must be an array")
        try:
            return [dict(ref) for ref in normalize_progress_refs(value)]
        except ValueError as exc:
            raise MatterError("E_INVALID_ARG", f"progress refs: {exc}") from exc
