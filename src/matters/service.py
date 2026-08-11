"""Transactional Matter aggregate service."""

from __future__ import annotations

import json
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from .models import (
    MATTER_ACTOR_KINDS,
    MATTER_HEALTH_VALUES,
    MATTER_ITEM_KINDS,
    MATTER_ITEM_STATUSES,
    MATTER_PRIORITIES,
    MATTER_TAG_COLORS,
    MATTER_TAG_DEFAULT_COLOR,
    MATTER_TAG_DEFAULT_SHAPE,
    MATTER_TAG_SHAPES,
    MATTER_ACCESS_POLICIES,
    MATTER_RELATION_TYPES,
    MATTER_RESOURCE_KINDS,
    MATTER_RESOURCE_EXPANSION_REASONS,
    MATTER_RESOURCE_SUBSCRIPTION_STATES,
    MATTER_STATUSES,
    MATTER_UPDATE_REVIEW_STATUSES,
    MatterActorKind,
    MatterItemKind,
    format_public_id,
    normalize_goal_checks,
    normalize_tags,
    person_key_for_email,
)
from .repository import MatterRepository
from .resource_identity import (
    EMAIL_PROVIDER,
    MatterError,
    evidence_fingerprint,
    email_resource_key,
    normalize_resource_key,
    rejection_resource_key,
    thread_resource_key,
)
from .url_fetch import (
    URL_CACHE_METADATA_KEY,
    URL_CACHE_TEXT_KEY,
    cached_url_text,
    content_hash,
    describe_url_cache,
    fetch_readable_url,
)
from .events import (
    AGENT_BINDING_CHANGED,
    CHAT_SCOPE_EXPANDED,
    CHAT_SCOPE_RESTORED,
    MATTER_UPDATED,
    RESOURCE_LINKED,
    RESOURCE_SUGGESTION_ACCEPTED,
    RESOURCE_SUGGESTION_REJECTED,
    UPDATE_ACCEPTED,
    UPDATE_REJECTED,
    UPDATE_SUPERSEDED,
)

TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
ACTION_ONLY_ITEM_FIELDS = {
    "status",
    "priority",
    "owner_kind",
    "owner_id",
    "waiting_on_stakeholder_id",
    "due_at",
    "completed_at",
    "checklist",
}
MANUAL_UPDATE_FIELDS = {"status", "health", "current_summary"}
# P4 绑定三键（D2）：走既有 PATCH 白名单 + 事件 agent_binding_changed；
# schedule_json P5 才有写面（本相位零消费，不进白名单）。
BINDING_PATCH_FIELDS = {
    "agent_profile_id", "agent_enabled", "matter_instructions", "schedule_json",
}
MATTER_INSTRUCTIONS_MAX_CHARS = 4000
DIRECT_PATCH_FIELDS = {
    "title",
    "description",
    "matter_type",
    "priority",
    "tags",
    "goal_checks",
    "due_at",
    "waiting_context",
    "next_attention_at",
    "attention_reason",
}
# D5 bounded projection: context_snapshot resource entries only pass through the
# short structured metadata keys the MailAgent write side actually produces
# (_resolve_source_resource: email -> internal_id/message_id/date_received,
# thread -> thread_id). Free-text keys (cached_excerpt / excerpt / text_excerpt /
# snippet / body ...) are the *source* of the truncated `excerpt` field and must
# never ride out untruncated through metadata — whitelist, 宁缺勿滥.
SNAPSHOT_METADATA_KEYS = ("internal_id", "message_id", "thread_id", "date_received")
RESOURCE_DISCOVERY_MAX_CANDIDATES = 50
RESOURCE_DISCOVERY_SCAN_LIMIT = 500


@dataclass(frozen=True)
class Actor:
    kind: str = MatterActorKind.USER.value
    actor_id: str | None = None


class MatterService:
    def __init__(self, repository: MatterRepository, *, clock_ms=None, url_fetcher=None):
        self.repository = repository
        self.clock_ms = clock_ms or (lambda: int(time.time() * 1000))
        self.url_fetcher = url_fetcher or fetch_readable_url

    def _default_schedule_json(self, now: int) -> str:
        """新建事项的默认跟进排程（D2 方案 A：默认开 + 连排程一起给）。

        `agent_enabled` 的建表默认在 v50 翻成 1，但开关开着而没有排程 = 永远不跑 =
        一个说谎的开关，所以两者必须一起给。
        """
        from datetime import datetime

        from .triggers import default_schedule_entry, dump_trigger_set, parse_trigger_set

        anchor = datetime.fromtimestamp(now / 1000).date().isoformat()
        entries = parse_trigger_set(
            [default_schedule_entry(anchor=anchor)], seed=f"default:{now}"
        )
        return self._dump(dump_trigger_set(entries))

    def create_matter(
        self,
        data: Mapping[str, Any],
        *,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        self._validate_actor(actor)
        title = str(data.get("title") or "").strip()
        status = str(data.get("status") or "inbox")
        health = str(data.get("health") or "unknown")
        priority = str(data.get("priority") or "p1")
        self._require_value("status", status, MATTER_STATUSES)
        self._require_value("health", health, MATTER_HEALTH_VALUES)
        self._require_value("priority", priority, MATTER_PRIORITIES)
        tags = normalize_tags(data.get("tags"))
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, "matter_created")
            if replay:
                return replay
            source_spec = data.get("source_resource")
            source_snapshot = self._resolve_source_resource(conn, source_spec) if source_spec else None
            if not title and source_snapshot:
                title = source_snapshot["title"] or "Untitled Matter"
            if not title:
                raise MatterError("E_INVALID_ARG", "title is required")
            seq = self.repository.allocate_sequence(conn, now)
            public_id = format_public_id(seq)
            matter_id = self.repository.insert_matter(
                conn,
                {
                    "public_id": public_id,
                    "title": title,
                    "description": str(data.get("description") or ""),
                    "matter_type": self._optional_text(data.get("matter_type")),
                    "tags_json": self._dump(tags),
                    "status": status,
                    "health": health,
                    "priority": priority,
                    "owner_id": actor.actor_id,
                    "source": source or "desktop_ui",
                    "due_at": data.get("due_at"),
                    "waiting_context_json": self._dump(data["waiting_context"])
                    if data.get("waiting_context") is not None
                    else None,
                    "last_activity_at": now,
                    "schedule_json": self._default_schedule_json(now),
                    "created_at": now,
                    "updated_at": now,
                },
            )
            linked: list[dict[str, Any]] = []
            warnings: list[str] = []
            if source_snapshot:
                linked, warnings, resource_event_ids = self._link_source_snapshot(
                    conn, matter_id, source_snapshot, actor=actor, now=now,
                    source=source, reason=reason,
                )
            else:
                resource_event_ids = []
            self.refresh_search_projection(conn, matter_id)
            event_id = self._append_event(
                conn,
                matter_id=matter_id,
                kind="matter_created",
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                payload={"public_id": public_id},
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            matter = self.repository.get_matter_by_id(conn, matter_id)
            result = self._mutation(
                matter,
                [event_id, *resource_event_ids],
                resources=linked,
                undo=self._undo_descriptor(
                    "matter_update",
                    "撤销创建：移入废纸篓",
                    {"public_id": public_id, "operation": "trash"},
                    matter,
                    event_id,
                ),
            )
            result["warnings"].extend(warnings)
            return result

    def get_matter(
        self, public_id: str, *, include: Sequence[str] = ()
    ) -> dict[str, Any]:
        with self.repository.connect() as conn:
            matter = self.repository.get_matter(conn, public_id)
            if not matter:
                raise MatterError("E_MATTER_NOT_FOUND", f"matter {public_id} not found")
            result: dict[str, Any] = {"matter": matter}
            include_set = set(include)
            if "items" in include_set:
                result["items"] = self.repository.list_items(
                    conn, matter["id"], include_deleted=True
                )
            if "timeline" in include_set:
                result["timeline"], _ = self.repository.list_events(
                    conn, matter["id"], cursor=None, limit=100
                )
            if "updates" in include_set:
                result["updates"] = self.repository.list_updates(conn, matter["id"])
            if "resources" in include_set:
                result["resources"] = [
                    self._decorate_url_resource(item)
                    for item in self.repository.list_resources(conn, matter["id"], {})
                ]
            if "stakeholders" in include_set:
                result["stakeholders"] = [
                    dict(row)
                    for row in conn.execute(
                        "SELECT * FROM matter_stakeholder WHERE matter_id=? AND deleted_at IS NULL ORDER BY id",
                        (matter["id"],),
                    )
                ]
            if "relations" in include_set:
                result["relations"] = self.list_relations(public_id)
            return result

    def duplicate_candidates(self, data: Mapping[str, Any]) -> list[dict[str, Any]]:
        """Return explainable possible duplicates without mutating any Matter."""
        public_id = str(data.get("matter_id") or "").strip()
        with self.repository.connect() as conn:
            exclude_matter_id = None
            if public_id:
                source = self._require_matter(conn, public_id)
                exclude_matter_id = int(source["id"])
                document = conn.execute(
                    "SELECT * FROM matter_search_document WHERE matter_id=?",
                    (source["id"],),
                ).fetchone()
                title = source["title"]
                text = " ".join(
                    str(document[key] or "")
                    for key in (
                        "title", "description", "current_summary", "items_text",
                        "stakeholders_text", "notes_text",
                    )
                ) if document else title
                stakeholder_emails = {
                    row[0]
                    for row in conn.execute(
                        "SELECT email_normalized FROM matter_stakeholder "
                        "WHERE matter_id=? AND deleted_at IS NULL AND email_normalized IS NOT NULL",
                        (source["id"],),
                    )
                }
                resource_keys = {
                    f"{row[0]}:{row[1]}"
                    for row in conn.execute(
                        "SELECT r.provider,r.external_key FROM matter_resource mr "
                        "JOIN resource r ON r.id=mr.resource_id "
                        "WHERE mr.matter_id=? AND mr.deleted_at IS NULL",
                        (source["id"],),
                    )
                }
                reference_at = int(source["created_at"])
            else:
                title = str(data.get("title") or "").strip()
                text = " ".join(
                    str(data.get(key) or "")
                    for key in ("title", "description", "current_summary")
                )
                stakeholder_emails = self._input_emails(data.get("stakeholders"))
                resource_keys = self._input_resource_keys(data.get("resources"))
                reference_at = int(data.get("reference_at") or self.clock_ms())
            query_terms = self._semantic_terms(text)
            if not query_terms and not stakeholder_emails and not resource_keys:
                return []
            candidates = []
            for row in self.repository.list_duplicate_candidate_rows(
                conn, exclude_matter_id=exclude_matter_id
            ):
                reasons: list[dict[str, Any]] = []
                confidence = 0.0
                candidate_resources = set(row["resource_keys"])
                shared_resources = sorted(resource_keys & candidate_resources)
                if shared_resources:
                    ratio = len(shared_resources) / max(1, len(resource_keys))
                    contribution = min(0.48, 0.32 + ratio * 0.16)
                    confidence += contribution
                    reasons.append({
                        "kind": "resource_overlap",
                        "label": "关联资料重叠",
                        "weight": round(contribution, 3),
                        "evidence": shared_resources[:5],
                    })
                shared_people = sorted(
                    stakeholder_emails & set(row["stakeholder_emails"])
                )
                if shared_people:
                    ratio = len(shared_people) / max(1, len(stakeholder_emails))
                    contribution = min(0.28, 0.18 + ratio * 0.10)
                    confidence += contribution
                    reasons.append({
                        "kind": "stakeholder_overlap",
                        "label": "干系人重叠",
                        "weight": round(contribution, 3),
                        "evidence": shared_people[:5],
                    })
                candidate_text = " ".join(
                    str(row.get(key) or "")
                    for key in (
                        "search_title", "search_description", "search_summary",
                        "items_text", "stakeholders_text", "notes_text",
                    )
                )
                candidate_terms = self._semantic_terms(candidate_text)
                shared_terms = sorted(query_terms & candidate_terms)
                union = query_terms | candidate_terms
                similarity = len(shared_terms) / max(1, len(union))
                if shared_terms and similarity >= 0.04:
                    contribution = min(0.20, 0.08 + similarity * 0.6)
                    confidence += contribution
                    reasons.append({
                        "kind": "semantic_overlap",
                        "label": "主题与上下文相似",
                        "weight": round(contribution, 3),
                        "evidence": shared_terms[:8],
                    })
                age_ms = abs(reference_at - int(row["created_at"]))
                if age_ms <= 30 * 24 * 60 * 60 * 1000 and reasons:
                    confidence += 0.04
                    reasons.append({
                        "kind": "time_proximity",
                        "label": "创建时间接近（30 天内）",
                        "weight": 0.04,
                        "evidence": [],
                    })
                if confidence < 0.18:
                    continue
                candidates.append({
                    "matter": {
                        "public_id": row["public_id"],
                        "title": row["title"],
                        "status": row["status"],
                        "health": row["health"],
                        "priority": row["priority"],
                        "updated_at": row["updated_at"],
                    },
                    "confidence": round(min(confidence, 0.99), 3),
                    "reasons": reasons,
                })
            return sorted(
                candidates,
                key=lambda item: (-item["confidence"], -item["matter"]["updated_at"]),
            )[:20]

    def context_snapshot(
        self, public_id: str, *, prepare_discovery: bool = True
    ) -> dict[str, Any]:
        if prepare_discovery:
            prepared = self.discover_resource_suggestions(
                public_id, limit=10, bump_version=False
            )
            if prepared["local_candidate_count"] == 0:
                self.discover_resource_suggestions(
                    public_id,
                    expand_reason="context_gap",
                    limit=10,
                    bump_version=False,
                )
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            core_fields = (
                "id",
                "public_id",
                "title",
                "matter_type",
                "tags",
                "status",
                "health",
                "priority",
                "due_at",
                "waiting_context",
                "description",
                "current_summary",
                "version",
            )
            core = {field: matter.get(field) for field in core_fields}
            core["type"] = core.pop("matter_type")
            accepted_at = matter.get("created_at")
            if matter.get("latest_accepted_update_id") is not None:
                row = conn.execute(
                    "SELECT accepted_at FROM matter_update WHERE id=?",
                    (matter["latest_accepted_update_id"],),
                ).fetchone()
                if row and row["accepted_at"] is not None:
                    accepted_at = int(row["accepted_at"])
            core["summary_accepted_at"] = accepted_at

            item_rows = conn.execute(
                "SELECT kind,title,status,due_at,owner_kind,owner_id "
                "FROM matter_item WHERE matter_id=? AND deleted_at IS NULL "
                "AND (status IS NULL OR status NOT IN ('done','canceled')) "
                "ORDER BY position,id LIMIT 50",
                (matter["id"],),
            ).fetchall()
            items = [dict(row) for row in item_rows]

            stakeholder_rows = conn.execute(
                "SELECT id,display_name,email_normalized,organization,role,relationship,is_waiting_on "
                "FROM matter_stakeholder WHERE matter_id=? AND deleted_at IS NULL "
                "ORDER BY is_waiting_on DESC,id LIMIT 20",
                (matter["id"],),
            ).fetchall()
            stakeholders = [
                {**dict(row), "is_waiting_on": bool(row["is_waiting_on"])}
                for row in stakeholder_rows
            ]

            resources = []
            visible_resources = [
                joined
                for joined in self.repository.list_resources(conn, matter["id"], {})
                if joined["link"]["pinned"]
                or (
                    joined["link"]["confirmed_at"] is None
                    and joined["link"]["added_by_kind"] == "agent"
                )
            ]
            for joined in visible_resources[:10]:
                resource = joined["resource"]
                metadata = resource.get("metadata") or {}
                excerpt = next(
                    (
                        metadata.get(key)
                        for key in ("cached_excerpt", "excerpt", "text_excerpt", "snippet")
                        if isinstance(metadata.get(key), str)
                    ),
                    None,
                )
                resources.append(
                    {
                        "id": resource["id"],
                        "kind": resource["kind"],
                        "provider": resource["provider"],
                        "external_key": resource["external_key"],
                        "title": resource.get("title"),
                        "canonical_url": resource.get("canonical_url"),
                        "revision": resource.get("revision"),
                        "access_policy": resource.get("access_policy"),
                        # Whitelist projection (D5): free-text metadata never rides
                        # out untruncated — excerpts only leave via `excerpt` below.
                        "metadata": {
                            key: metadata[key]
                            for key in SNAPSHOT_METADATA_KEYS
                            if key in metadata
                        },
                        "excerpt": excerpt[:2000] if excerpt else None,
                    }
                )

            event_rows = conn.execute(
                "SELECT kind,happened_at,actor_kind,payload_json FROM matter_event "
                "WHERE matter_id=? AND happened_at>=? ORDER BY happened_at DESC,id DESC LIMIT 30",
                (matter["id"], accepted_at),
            ).fetchall()
            events = []
            for row in event_rows:
                payload = json.loads(row["payload_json"] or "{}")
                summary_parts = []
                for key in ("fields", "item_id", "resource_id", "stakeholder_id", "relation_id"):
                    if key in payload:
                        summary_parts.append(f"{key}={payload[key]}")
                events.append(
                    {
                        "kind": row["kind"],
                        "happened_at": row["happened_at"],
                        "actor_kind": row["actor_kind"],
                        "summary": ", ".join(summary_parts) or row["kind"],
                    }
                )
            return {
                "matter": core,
                "items": items,
                "stakeholders": stakeholders,
                "resources": resources,
                "events": events,
            }

    def record_chat_scope(
        self,
        public_id: str,
        *,
        scope: str,
        session_id: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        if scope not in {"matter", "global"}:
            raise MatterError("E_INVALID_ARG", f"invalid chat scope: {scope}")
        now = self.clock_ms()
        dedupe_key = f"chat_scope:{session_id}:{self._dedupe(idempotency_key)}"
        kind = CHAT_SCOPE_EXPANDED if scope == "global" else CHAT_SCOPE_RESTORED
        from_scope = "matter" if scope == "global" else "global"
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, kind)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=kind,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                payload={"session_id": session_id, "from": from_scope, "to": scope},
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            return self._mutation(matter, [event_id])

    def list_matters(
        self,
        *,
        filters: Mapping[str, Any],
        cursor: tuple[int, int] | None,
        limit: int,
        sort: str,
    ) -> dict[str, Any]:
        with self.repository.connect() as conn:
            items, next_cursor, total = self.repository.list_matters(
                conn, filters=filters, cursor=cursor, limit=limit, sort=sort
            )
        return {"items": items, "next_cursor": next_cursor, "total": total}

    def list_tags(self) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            return self.repository.list_tags(conn)

    def upsert_tag_style(
        self,
        name: str,
        *,
        color: str,
        shape: str,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        del reverses_event_id
        self._validate_actor(actor)
        tag_name = self._normalize_tag_name(name)
        color = str(color)
        shape = str(shape)
        self._require_value("color", color, MATTER_TAG_COLORS)
        self._require_value("shape", shape, MATTER_TAG_SHAPES)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        replay_payload = {"name": tag_name, "color": color, "shape": shape}
        with self.repository.transaction() as conn:
            replay = self._tag_replay(
                conn, dedupe_key, "tag_style_upsert", replay_payload
            )
            if replay:
                return replay
            self.repository.upsert_tag(
                conn, name=tag_name, color=color, shape=shape, created_at=now
            )
            tag = self._listed_tag(conn, tag_name)
            result = {
                "tag": tag,
                "event_ids": [],
                "warnings": [],
            }
            self._store_tag_mutation(
                conn,
                dedupe_key,
                operation="tag_style_upsert",
                payload=replay_payload,
                result=result,
                now=now,
            )
            return result

    def rename_tag(
        self,
        old_name: str,
        new_name: str,
        *,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        self._validate_actor(actor)
        old_tag_name = self._normalize_tag_name(old_name)
        new_tag_name = self._normalize_tag_name(new_name)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        replay_payload = {"old_name": old_tag_name, "new_name": new_tag_name}
        with self.repository.transaction() as conn:
            replay = self._tag_replay(conn, dedupe_key, "tag_rename", replay_payload)
            if replay:
                return replay
            if old_tag_name == new_tag_name:
                tag = self._listed_tag(conn, new_tag_name)
                result = {
                    "tag": tag,
                    "event_ids": [],
                    "warnings": ["same_name"],
                }
                self._store_tag_mutation(
                    conn,
                    dedupe_key,
                    operation="tag_rename",
                    payload=replay_payload,
                    result=result,
                    now=now,
                )
                return result
            old_defined = self.repository.get_tag(conn, old_tag_name) is not None
            old_referenced = self.repository.tag_is_referenced(
                conn, old_tag_name, include_deleted=True
            )
            if not old_defined and not old_referenced:
                raise MatterError("E_NOT_FOUND", f"tag {old_tag_name} not found")
            self.repository.merge_or_rename_tag_definition(
                conn, old_name=old_tag_name, new_name=new_tag_name, created_at=now
            )
            changed = self.repository.rename_tag_references(
                conn, old_name=old_tag_name, new_name=new_tag_name, updated_at=now
            )
            tag = self._listed_tag(conn, new_tag_name)
            event_ids = self._append_tag_reference_events(
                conn,
                changed,
                dedupe_key=dedupe_key,
                actor=actor,
                source=source,
                reason=reason,
                now=now,
                payload={
                    "fields": ["tags"],
                    "operation": "tag_rename",
                    "old_name": old_tag_name,
                    "new_name": new_tag_name,
                },
                reverses_event_id=reverses_event_id,
            )
            result = {
                "tag": tag,
                "event_ids": event_ids,
                "warnings": [],
                "affected_count": len(changed),
            }
            self._store_tag_mutation(
                conn,
                dedupe_key,
                operation="tag_rename",
                payload=replay_payload,
                result=result,
                now=now,
            )
            return result

    def delete_tag(
        self,
        name: str,
        *,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        self._validate_actor(actor)
        tag_name = self._normalize_tag_name(name)
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        replay_payload = {"name": tag_name}
        with self.repository.transaction() as conn:
            replay = self._tag_replay(conn, dedupe_key, "tag_delete", replay_payload)
            if replay:
                return replay
            defined = self.repository.delete_tag(conn, tag_name)
            referenced = self.repository.tag_is_referenced(
                conn, tag_name, include_deleted=True
            )
            if not defined and not referenced:
                raise MatterError("E_NOT_FOUND", f"tag {tag_name} not found")
            changed = self.repository.remove_tag_references(
                conn, name=tag_name, updated_at=now
            )
            event_ids = self._append_tag_reference_events(
                conn,
                changed,
                dedupe_key=dedupe_key,
                actor=actor,
                source=source,
                reason=reason,
                now=now,
                payload={
                    "fields": ["tags"],
                    "operation": "tag_delete",
                    "name": tag_name,
                },
                reverses_event_id=reverses_event_id,
            )
            result = {
                "deleted": True,
                "name": tag_name,
                "event_ids": event_ids,
                "warnings": [],
                "affected_count": len(changed),
            }
            self._store_tag_mutation(
                conn,
                dedupe_key,
                operation="tag_delete",
                payload=replay_payload,
                result=result,
                now=now,
            )
            return result

    def patch_matter(
        self,
        public_id: str,
        patch: Mapping[str, Any],
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        unknown = (
            set(patch) - DIRECT_PATCH_FIELDS - MANUAL_UPDATE_FIELDS - BINDING_PATCH_FIELDS
        )
        if unknown:
            raise MatterError(
                "E_INVALID_ARG", f"unsupported patch fields: {sorted(unknown)}"
            )
        # D7：核心目标与它的完成标志都是**用户写的**，Agent 只能建议不能落库。
        # 「让 Agent 改写」走的是"产出建议文本 → 落进用户的编辑框待确认"，不是直接写。
        for user_only in ("description", "goal_checks"):
            if user_only in patch and actor.kind != MatterActorKind.USER.value:
                raise MatterError(
                    "E_INVALID_ARG", f"{user_only} can only be changed by a user"
                )
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, "matter_updated")
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            direct_changes: dict[str, Any] = {
                "updated_at": now,
                "last_activity_at": now,
            }
            for field in DIRECT_PATCH_FIELDS:
                if field not in patch:
                    continue
                value = patch[field]
                if field == "title":
                    value = str(value or "").strip()
                    if not value:
                        raise MatterError("E_INVALID_ARG", "title cannot be empty")
                elif field == "priority":
                    value = str(value)
                    self._require_value("priority", value, MATTER_PRIORITIES)
                elif field == "matter_type":
                    value = self._optional_text(value)
                elif field == "tags":
                    field = "tags_json"
                    value = self._dump(normalize_tags(value))
                elif field == "goal_checks":
                    # D5 完成标志。与 description 同权限（`_require_user_actor` 在下面
                    # 统一判）：目标是用户写的，Agent 只能建议不能落库。
                    field = "goal_checks_json"
                    try:
                        value = self._dump(normalize_goal_checks(value))
                    except ValueError as exc:
                        raise MatterError("E_INVALID_ARG", str(exc)) from exc
                elif field == "waiting_context":
                    field = "waiting_context_json"
                    value = self._dump(value) if value is not None else None
                direct_changes[field] = value
            binding = {
                field: patch[field] for field in BINDING_PATCH_FIELDS if field in patch
            }
            binding_warnings: list[str] = []
            if binding:
                binding_changes, binding_warnings = self._normalize_binding_patch(
                    conn, binding
                )
                direct_changes.update(binding_changes)
            manual = {
                field: patch[field] for field in MANUAL_UPDATE_FIELDS if field in patch
            }
            if "status" in manual:
                self._require_value("status", str(manual["status"]), MATTER_STATUSES)
            if "health" in manual:
                self._require_value(
                    "health", str(manual["health"]), MATTER_HEALTH_VALUES
                )
            update_id = None
            if manual:
                reviewed = dict(manual)
                update_id = self.repository.insert_update(
                    conn,
                    {
                        "matter_id": matter["id"],
                        "review_status": "accepted",
                        "summary": manual.get("current_summary"),
                        "from_event_id": None,
                        "to_event_id": None,
                        "anchored_matter_version": expected_version,
                        "original_proposal_json": self._dump(
                            {"kind": "manual", "changes": reviewed}
                        ),
                        "reviewed_result_json": self._dump(reviewed),
                        "changes_json": self._dump(reviewed),
                        "citations_json": "[]",
                        "created_by_kind": actor.kind,
                        "created_by_id": actor.actor_id,
                        "created_at": now,
                        "reviewed_at": now,
                        "reviewed_by_kind": actor.kind,
                        "reviewed_by_id": actor.actor_id,
                        "accepted_at": now,
                        "official_state_version": expected_version + 1,
                    },
                )
                if "status" in manual:
                    direct_changes["status"] = str(manual["status"])
                if "health" in manual:
                    direct_changes["health"] = str(manual["health"])
                if "current_summary" in manual:
                    direct_changes.update(
                        {
                            "current_summary": manual["current_summary"],
                            "summary_at": now,
                            "summary_by_kind": actor.kind,
                            "summary_by_id": actor.actor_id,
                        }
                    )
                direct_changes["latest_accepted_update_id"] = update_id
            if not self._cas_update(
                conn, matter["id"], expected_version, direct_changes
            ):
                raise self._version_conflict()
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind="matter_updated",
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                update_id=update_id,
                payload={"fields": sorted(patch)},
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            event_ids = [event_id]
            if binding:
                event_ids.append(
                    self._append_event(
                        conn,
                        matter_id=matter["id"],
                        kind=AGENT_BINDING_CHANGED,
                        actor=actor,
                        source=source,
                        dedupe_key=f"{dedupe_key}:agent_binding",
                        reason=reason,
                        payload={"fields": sorted(binding)},
                        happened_at=now,
                    )
                )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            before_patch = {
                field: matter.get(field)
                for field in patch
                if field
                in {
                    "title",
                    "description",
                    "matter_type",
                    "tags",
                    "status",
                    "health",
                    "current_summary",
                    "due_at",
                    "waiting_context",
                    "next_attention_at",
                    "attention_reason",
                }
            }
            result = self._mutation(
                after,
                event_ids,
                undo=self._undo_descriptor(
                    "matter_update",
                    "撤销事项更新",
                    {"public_id": public_id, "operation": "patch", "patch": before_patch},
                    after,
                    event_id,
                ),
            )
            result["warnings"].extend(binding_warnings)
            return result

    def archive(self, public_id: str, **mutation: Any) -> dict[str, Any]:
        return self._timestamp_transition(
            public_id, "archive", "archived_at", True, **mutation
        )

    def reopen(self, public_id: str, **mutation: Any) -> dict[str, Any]:
        return self._timestamp_transition(
            public_id, "reopen", "archived_at", False, **mutation
        )

    def trash(self, public_id: str, **mutation: Any) -> dict[str, Any]:
        return self._timestamp_transition(
            public_id, "trash", "deleted_at", True, **mutation
        )

    def restore(self, public_id: str, **mutation: Any) -> dict[str, Any]:
        return self._timestamp_transition(
            public_id, "restore", "deleted_at", False, **mutation
        )

    def permanently_delete(
        self,
        public_id: str,
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
    ) -> dict[str, Any]:
        with self.repository.transaction() as conn:
            matter = self._require_matter(conn, public_id)
            if matter["version"] != expected_version:
                raise self._version_conflict()
            if matter["deleted_at"] is None:
                raise MatterError(
                    "E_INVALID_STATE", "matter must be in Trash before permanent delete"
                )
            if not self._cas_update(
                conn, matter["id"], expected_version, {"updated_at": self.clock_ms()}
            ):
                raise self._version_conflict()
            self.repository.delete_matter(conn, matter["id"])
            return {"deleted": True, "public_id": public_id}

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
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, "item_created", include_item=True)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            if not self._cas_update(
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now, "last_activity_at": now},
            ):
                raise self._version_conflict()
            item_id = self.repository.insert_item(
                conn,
                {
                    "matter_id": matter["id"],
                    "kind": kind,
                    "title": title,
                    "description": self._optional_text(data.get("description")),
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
                kind="item_created",
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                payload={"kind": kind},
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
        with self.repository.transaction() as conn:
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
            if not self._cas_update(
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now, "last_activity_at": now},
            ):
                raise self._version_conflict()
            if not self.repository.update_item(conn, matter["id"], item_id, changes):
                raise MatterError("E_CHILD_NOT_FOUND", f"item {item_id} not found")
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=event_kind,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                payload={"fields": sorted(patch)},
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
                item=self.repository.get_item(conn, matter["id"], item_id),
                undo=self._undo_descriptor(
                    "matter_item_mutate",
                    "撤销条目变更",
                    reverse_input,
                    after,
                    event_id,
                ),
            )

    def _timestamp_transition(
        self,
        public_id: str,
        operation: str,
        column: str,
        set_value: bool,
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
        event_kind = {
            "archive": "matter_archived",
            "reopen": "matter_reopened",
            "trash": "matter_trashed",
            "restore": "matter_restored",
        }[operation]
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            current = matter[column]
            if set_value and current is not None:
                raise MatterError("E_INVALID_STATE", f"matter is already {operation}d")
            if not set_value and current is None:
                raise MatterError("E_INVALID_STATE", f"matter is not {operation}d")
            changes: dict[str, Any] = {
                column: now if set_value else None,
                "updated_at": now,
            }
            by_prefix = "archived" if column == "archived_at" else "deleted"
            changes[f"{by_prefix}_by_kind"] = actor.kind if set_value else None
            changes[f"{by_prefix}_by_id"] = actor.actor_id if set_value else None
            if column == "deleted_at":
                changes["purge_after"] = now + TRASH_RETENTION_MS if set_value else None
            if not self._cas_update(
                conn, matter["id"], expected_version, changes
            ):
                raise self._version_conflict()
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=event_kind,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                payload={},
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            reverse_operation = {
                "archive": "reopen",
                "reopen": "archive",
                "trash": "restore",
                "restore": "trash",
            }[operation]
            return self._mutation(
                after,
                [event_id],
                undo=self._undo_descriptor(
                    "matter_update",
                    f"撤销{operation}",
                    {"public_id": public_id, "operation": reverse_operation},
                    after,
                    event_id,
                ),
            )

    def list_resources(self, public_id: str, **filters: Any) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            return [
                self._decorate_url_resource(item)
                for item in self.repository.list_resources(conn, matter["id"], filters)
            ]

    def fetch_url_resource(
        self, public_id: str, resource_id: int, *, force: bool = False
    ) -> dict[str, Any]:
        now = self.clock_ms()
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            resource = self.repository.get_resource(conn, resource_id)
            link = self.repository.get_resource_link(
                conn, matter["id"], resource_id, live_only=True
            )
        self._validate_url_fetch_resource(resource, link)
        cache = describe_url_cache(resource, now)
        if cache["is_fresh"] and not force:
            return {
                "resource": self._resource_with_url_cache(resource),
                "cache_hit": True,
                "cache": cache,
                "content": cached_url_text(resource),
            }

        fetched = self.url_fetcher(str(resource["canonical_url"]))
        text = str(fetched.get("text") or "")
        fetched_hash = content_hash(text)
        fetched_at = self.clock_ms()
        with self.repository.transaction() as conn:
            matter = self._require_matter(conn, public_id)
            current = self.repository.get_resource(conn, resource_id)
            link = self.repository.get_resource_link(
                conn, matter["id"], resource_id, live_only=True
            )
            self._validate_url_fetch_resource(current, link)
            metadata = dict(current.get("metadata") or {})
            metadata[URL_CACHE_TEXT_KEY] = text
            metadata[URL_CACHE_METADATA_KEY] = {
                "fetched_at": fetched_at,
                "content_hash": fetched_hash,
                "final_url": str(fetched.get("final_url") or current["canonical_url"]),
                "content_type": fetched.get("content_type"),
                "status": fetched.get("status"),
                "truncated": bool(fetched.get("truncated")),
            }
            title = current.get("title") or self._optional_text(fetched.get("title"))
            conn.execute(
                "UPDATE resource SET title=?, metadata_json=?, revision=?, content_hash=?, "
                "last_checked_at=?, updated_at=? WHERE id=?",
                (
                    title,
                    self._dump(metadata),
                    fetched_hash,
                    fetched_hash,
                    fetched_at,
                    fetched_at,
                    resource_id,
                ),
            )
            updated = self.repository.get_resource(conn, resource_id)
        return {
            "resource": self._resource_with_url_cache(updated),
            "cache_hit": False,
            "cache": describe_url_cache(updated, fetched_at),
            "content": text,
        }

    def add_resource(
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
        self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            matter = self._require_matter(conn, public_id)
            snapshot = self._resolve_source_resource(conn, data.get("source_resource")) if data.get("source_resource") else None
            specs = snapshot["resources"] if snapshot else [dict(data)]
            results: list[dict[str, Any]] = []
            warnings: list[str] = list(snapshot.get("warnings", [])) if snapshot else []
            pending: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for spec in specs:
                if spec.get("resource_id") is not None:
                    resource = self.repository.get_resource(conn, int(spec["resource_id"]))
                    if resource is None:
                        raise MatterError(
                            "E_CHILD_NOT_FOUND",
                            f"resource {spec['resource_id']} not found",
                        )
                else:
                    resource, _ = self._upsert_resource(conn, spec, now)
                link = self.repository.get_resource_link(conn, matter["id"], resource["id"], live_only=True)
                if link:
                    results.append({"resource": resource, "link": link})
                    warnings.append("already_linked")
                else:
                    pending.append((resource, spec))
            if not pending:
                result = self._mutation(matter, [], resources=results)
                result["warnings"] = list(dict.fromkeys(warnings))
                return result
            if not self._cas_update(
                conn, matter["id"], expected_version, {"updated_at": now, "last_activity_at": now}
            ):
                raise self._version_conflict()
            event_ids = []
            for resource, spec in pending:
                link_id = self.repository.insert_resource_link(
                    conn,
                    {
                        "matter_id": matter["id"], "resource_id": resource["id"],
                        "relation_type": spec.get("relation_type"), "pinned": 1 if spec.get("pinned") else 0,
                        "added_by_kind": actor.kind, "added_by_id": actor.actor_id,
                        "confidence": spec.get("confidence"),
                        "provenance_json": self._dump(spec.get("provenance") or {}),
                        "confirmed_at": now if spec.get("confirmed") else None,
                        "sub_state": spec.get("sub_state") or "none", "created_at": now, "updated_at": now,
                    },
                )
                event_key = f"matter:{matter['id']}:resource_linked:{resource['id']}"
                existing = self.repository.find_event(conn, event_key)
                if not existing:
                    event_ids.append(self._append_event(
                        conn, matter_id=matter["id"], kind="resource_linked", actor=actor,
                        source=source, dedupe_key=event_key, reason=reason,
                        resource_id=resource["id"], payload={"link_id": link_id}, happened_at=now,
                        reverses_event_id=reverses_event_id,
                    ))
                link = self.repository.get_resource_link(conn, matter["id"], resource["id"], live_only=True)
                results.append({"resource": resource, "link": link})
            after = self.repository.get_matter_by_id(conn, matter["id"])
            undo = None
            if len(pending) == 1 and event_ids:
                undo = self._undo_descriptor(
                    "matter_resource_mutate",
                    "撤销资料关联",
                    {
                        "public_id": public_id,
                        "operation": "unlink",
                        "resource_id": pending[0][0]["id"],
                    },
                    after,
                    event_ids[0],
                )
            result = self._mutation(after, event_ids, resources=results, undo=undo)
            result["warnings"] = list(dict.fromkeys(warnings))
            return result

    def patch_resource(
        self, public_id: str, resource_id: int, patch: Mapping[str, Any], *,
        expected_version: int, idempotency_key: str, source: str,
        actor: Actor = Actor(), reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            if patch.get("confirmed") is True:
                replay = self._replay(conn, dedupe_key, RESOURCE_SUGGESTION_ACCEPTED)
                if replay:
                    return replay
            matter = self._require_matter(conn, public_id)
            resource = self.repository.get_resource(conn, resource_id)
            link = self.repository.get_resource_link(conn, matter["id"], resource_id, live_only=True)
            if not resource or not link:
                raise MatterError("E_CHILD_NOT_FOUND", f"resource {resource_id} not linked")
            accepting_suggestion = patch.get("confirmed") is True and link["confirmed_at"] is None
            if "access_policy" in patch:
                replay_kind = "resource_access_policy_changed"
            elif patch.get("sub_state") == "paused":
                replay_kind = "resource_subscription_paused"
            elif patch.get("sub_state") == "active":
                replay_kind = "resource_subscription_resumed"
            elif accepting_suggestion:
                replay_kind = RESOURCE_SUGGESTION_ACCEPTED
            else:
                replay_kind = "resource_updated"
            replay = self._replay(conn, dedupe_key, replay_kind)
            if replay:
                return replay
            access_patch = "access_policy" in patch
            link_fields = {"pinned", "relation_type", "sub_state", "confirmed"} & set(patch)
            if access_patch:
                if patch.get("scope") != "resource" or link_fields:
                    raise MatterError("E_INVALID_ARG", "access_policy requires scope='resource' and cannot mix link fields")
                self._require_value("access_policy", str(patch["access_policy"]), MATTER_ACCESS_POLICIES)
                conn.execute("UPDATE resource SET access_policy=?, updated_at=? WHERE id=?", (patch["access_policy"], now, resource_id))
                event_kind = "resource_access_policy_changed"
            else:
                if "scope" in patch and patch.get("scope") not in (None, "link"):
                    raise MatterError("E_INVALID_ARG", "link updates use scope='link'")
                changes: dict[str, Any] = {"updated_at": now}
                if "pinned" in patch:
                    changes["pinned"] = 1 if patch["pinned"] else 0
                if "relation_type" in patch:
                    changes["relation_type"] = patch["relation_type"]
                if "confirmed" in patch and patch["confirmed"]:
                    changes["confirmed_at"] = link["confirmed_at"] or now
                    conn.execute(
                        "DELETE FROM matter_resource_rejection WHERE matter_id=? AND resource_key=?",
                        (
                            matter["id"],
                            rejection_resource_key(
                                resource["provider"], resource["kind"], resource["external_key"]
                            ),
                        ),
                    )
                if "sub_state" in patch:
                    sub_state = str(patch["sub_state"])
                    self._require_value("sub_state", sub_state, MATTER_RESOURCE_SUBSCRIPTION_STATES)
                    if resource["kind"] != "thread" or sub_state == "none":
                        raise MatterError("E_INVALID_STATE", "subscription state is only active/paused on thread resources")
                    changes["sub_state"] = sub_state
                assignments = ", ".join(f"{key}=?" for key in changes)
                conn.execute(f"UPDATE matter_resource SET {assignments} WHERE id=?", (*changes.values(), link["id"]))
                if patch.get("sub_state") == "paused":
                    event_kind = "resource_subscription_paused"
                elif patch.get("sub_state") == "active":
                    event_kind = "resource_subscription_resumed"
                elif accepting_suggestion:
                    event_kind = RESOURCE_SUGGESTION_ACCEPTED
                else:
                    event_kind = "resource_updated"
            if not self._cas_update(conn, matter["id"], expected_version, {"updated_at": now, "last_activity_at": now}):
                raise self._version_conflict()
            event_id = self._append_event(
                conn, matter_id=matter["id"], kind=event_kind, actor=actor, source=source,
                dedupe_key=dedupe_key, reason=reason, resource_id=resource_id,
                payload={"fields": sorted(patch)}, happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            if access_patch:
                reverse_patch = {"scope": "resource", "access_policy": resource["access_policy"]}
            else:
                reverse_patch = {
                    key: (link["confirmed_at"] is not None if key == "confirmed" else link.get(key))
                    for key in patch
                    if key in {"pinned", "relation_type", "sub_state", "confirmed"}
                }
            return self._mutation(
                after, [event_id],
                resource=self.repository.get_resource(conn, resource_id),
                link=self.repository.get_resource_link(conn, matter["id"], resource_id, live_only=True),
                undo=self._undo_descriptor(
                    "matter_resource_mutate",
                    "撤销资料变更",
                    {
                        "public_id": public_id,
                        "operation": "update",
                        "resource_id": resource_id,
                        "patch": reverse_patch,
                    },
                    after,
                    event_id,
                ),
            )

    def unlink_resource(self, public_id: str, resource_id: int, **mutation: Any) -> dict[str, Any]:
        return self._set_resource_deleted(public_id, resource_id, True, **mutation)

    def reject_resource_suggestion(
        self, public_id: str, resource_id: int, *, expected_version: int,
        idempotency_key: str, source: str, actor: Actor = Actor(),
        reason: str | None = None, reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, RESOURCE_SUGGESTION_REJECTED)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            resource = self.repository.get_resource(conn, resource_id)
            link = self.repository.get_resource_link(
                conn, matter["id"], resource_id, live_only=True
            )
            if not resource or not link:
                raise MatterError("E_CHILD_NOT_FOUND", f"resource {resource_id} not linked")
            if link["confirmed_at"] is not None:
                raise MatterError(
                    "E_INVALID_STATE", "only unconfirmed resource suggestions can be rejected"
                )
            provenance = link.get("provenance") or {}
            stable_evidence = provenance.get("evidence") or []
            canonical_key = rejection_resource_key(
                resource["provider"], resource["kind"], resource["external_key"]
            )
            fingerprint = str(provenance.get("evidence_fingerprint") or "")
            if not fingerprint:
                fingerprint = evidence_fingerprint(canonical_key, stable_evidence)
            if not self._cas_update(
                conn, matter["id"], expected_version,
                {"updated_at": now, "last_activity_at": now},
            ):
                raise self._version_conflict()
            conn.execute(
                "UPDATE matter_resource SET deleted_at=?,updated_at=? WHERE id=?",
                (now, now, link["id"]),
            )
            self.repository.upsert_resource_rejection(
                conn,
                {
                    "matter_id": matter["id"],
                    "resource_key": canonical_key,
                    "rejected_at": now,
                    "evidence_fingerprint": fingerprint,
                    "reason": reason,
                },
            )
            event_id = self._append_event(
                conn, matter_id=matter["id"], kind=RESOURCE_SUGGESTION_REJECTED,
                actor=actor, source=source, dedupe_key=dedupe_key, reason=reason,
                resource_id=resource_id,
                payload={"link_id": link["id"], "evidence_fingerprint": fingerprint},
                happened_at=now, reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            return self._mutation(after, [event_id], resource=resource)

    def discover_resource_suggestions(
        self, public_id: str, *, query: str | None = None,
        expand_reason: str | None = None, limit: int = 10,
        bump_version: bool = True,
    ) -> dict[str, Any]:
        """Discover email resources, persisting only unconfirmed suggestions.

        The first pass is confined to durable Matter anchors (linked threads and stakeholder
        addresses). Keyword-only global search is allowed only for a declared context gap,
        verification query, or explicit matter instructions.
        """
        limit = max(1, min(int(limit), RESOURCE_DISCOVERY_MAX_CANDIDATES))
        if expand_reason is not None:
            self._require_value(
                "expand_reason", expand_reason, MATTER_RESOURCE_EXPANSION_REASONS
            )
        now = self.clock_ms()
        with self.repository.transaction() as conn:
            matter = self._require_matter(conn, public_id)
            candidates, local_count, expanded = self._email_resource_candidates(
                conn, matter, query=query, expand_reason=expand_reason,
                limit=limit,
            )
            linked: list[dict[str, Any]] = []
            suppressed: list[dict[str, Any]] = []
            event_ids: list[int] = []
            for candidate in candidates:
                canonical_key = rejection_resource_key(
                    EMAIL_PROVIDER, "email", candidate["external_key"]
                )
                fingerprint = evidence_fingerprint(
                    canonical_key, candidate["evidence"]
                )
                rejection = self.repository.get_resource_rejection(
                    conn, matter["id"], canonical_key
                )
                if rejection and rejection["evidence_fingerprint"] == fingerprint:
                    suppressed.append({
                        "external_key": candidate["external_key"],
                        "reason": "rejected_same_evidence",
                    })
                    continue
                provenance = {
                    "discovery_scope": candidate["scope"],
                    "expand_reason": expand_reason if candidate["scope"] == "expanded" else None,
                    "reason": candidate["reason"],
                    "evidence": candidate["evidence"],
                    "evidence_fingerprint": fingerprint,
                }
                resource, _ = self._upsert_resource(
                    conn,
                    {
                        "provider": EMAIL_PROVIDER,
                        "kind": "email",
                        "external_key": candidate["external_key"],
                        "title": candidate["title"],
                        "metadata": candidate["metadata"],
                    },
                    now,
                )
                live = self.repository.get_resource_link(
                    conn, matter["id"], resource["id"], live_only=True
                )
                if live:
                    continue
                deleted = self.repository.get_resource_link(
                    conn, matter["id"], resource["id"]
                )
                if deleted:
                    conn.execute(
                        "UPDATE matter_resource SET added_by_kind='agent',added_by_id=NULL,"
                        "confidence=?,provenance_json=?,confirmed_at=NULL,deleted_at=NULL,updated_at=? "
                        "WHERE id=?",
                        (candidate["confidence"], self._dump(provenance), now, deleted["id"]),
                    )
                    link_id = deleted["id"]
                else:
                    link_id = self.repository.insert_resource_link(
                        conn,
                        {
                            "matter_id": matter["id"], "resource_id": resource["id"],
                            "relation_type": None, "pinned": 0,
                            "added_by_kind": "agent", "added_by_id": None,
                            "confidence": candidate["confidence"],
                            "provenance_json": self._dump(provenance),
                            "confirmed_at": None, "sub_state": "none",
                            "created_at": now, "updated_at": now,
                        },
                    )
                event_key = (
                    f"matter:{matter['id']}:resource_linked:{resource['id']}:{fingerprint}"
                )
                if not self.repository.find_event(conn, event_key):
                    event_ids.append(self._append_event(
                        conn, matter_id=matter["id"], kind=RESOURCE_LINKED,
                        actor=Actor(kind="agent"), source="matter_followup",
                        dedupe_key=event_key, reason=candidate["reason"],
                        resource_id=resource["id"],
                        payload={"link_id": link_id, "suggested": True, "evidence_fingerprint": fingerprint},
                        happened_at=now,
                    ))
                linked.append({
                    "resource": resource,
                    "link": self.repository.get_resource_link(
                        conn, matter["id"], resource["id"], live_only=True
                    ),
                    "reason": candidate["reason"],
                    "confidence": candidate["confidence"],
                })
            if linked and bump_version:
                if not self._cas_update(
                    conn, matter["id"], int(matter["version"]),
                    {"updated_at": now, "last_activity_at": now},
                ):
                    raise self._version_conflict()
            return {
                "items": linked,
                "suppressed": suppressed,
                "local_candidate_count": local_count,
                "expanded": expanded,
            }

    def restore_resource(self, public_id: str, resource_id: int, **mutation: Any) -> dict[str, Any]:
        return self._set_resource_deleted(public_id, resource_id, False, **mutation)

    def _set_resource_deleted(
        self, public_id: str, resource_id: int, deleted: bool, *, expected_version: int,
        idempotency_key: str, source: str, actor: Actor = Actor(), reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        event_kind = "resource_unlinked" if deleted else "resource_restored"
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            link = self.repository.get_resource_link(conn, matter["id"], resource_id)
            if not link or (deleted and link["deleted_at"] is not None) or (not deleted and link["deleted_at"] is None):
                raise MatterError("E_CHILD_NOT_FOUND", f"resource link {resource_id} not found")
            if not self._cas_update(conn, matter["id"], expected_version, {"updated_at": now, "last_activity_at": now}):
                raise self._version_conflict()
            conn.execute("UPDATE matter_resource SET deleted_at=?, updated_at=? WHERE id=?", (now if deleted else None, now, link["id"]))
            event_id = self._append_event(
                conn, matter_id=matter["id"], kind=event_kind, actor=actor, source=source,
                dedupe_key=dedupe_key, reason=reason, resource_id=resource_id,
                payload={"link_id": link["id"]}, happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            return self._mutation(
                after,
                [event_id],
                undo=self._undo_descriptor(
                    "matter_resource_mutate",
                    "撤销资料解除关联" if deleted else "撤销资料恢复",
                    {
                        "public_id": public_id,
                        "operation": "restore" if deleted else "unlink",
                        "resource_id": resource_id,
                    },
                    after,
                    event_id,
                ),
            )

    def list_stakeholders(self, public_id: str, *, waiting_only: bool = False, include_deleted: bool = False) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            clauses = ["matter_id=?"]
            params: list[Any] = [matter["id"]]
            if waiting_only:
                clauses.append("is_waiting_on=1")
            if not include_deleted:
                clauses.append("deleted_at IS NULL")
            return [dict(row) for row in conn.execute(
                f"SELECT * FROM matter_stakeholder WHERE {' AND '.join(clauses)} ORDER BY id", params
            )]

    def create_stakeholder(self, public_id: str, data: Mapping[str, Any], **mutation: Any) -> dict[str, Any]:
        return self._mutate_stakeholder(public_id, None, data, "stakeholder_added", **mutation)

    def update_stakeholder(self, public_id: str, stakeholder_id: int, patch: Mapping[str, Any], **mutation: Any) -> dict[str, Any]:
        return self._mutate_stakeholder(public_id, stakeholder_id, patch, "stakeholder_updated", **mutation)

    def delete_stakeholder(self, public_id: str, stakeholder_id: int, **mutation: Any) -> dict[str, Any]:
        return self._mutate_stakeholder(public_id, stakeholder_id, {"deleted_at": self.clock_ms()}, "stakeholder_removed", **mutation)

    def restore_stakeholder(self, public_id: str, stakeholder_id: int, **mutation: Any) -> dict[str, Any]:
        return self._mutate_stakeholder(public_id, stakeholder_id, {"deleted_at": None}, "stakeholder_restored", **mutation)

    def _mutate_stakeholder(
        self, public_id: str, stakeholder_id: int | None, data: Mapping[str, Any], event_kind: str, *,
        expected_version: int, idempotency_key: str, source: str, actor: Actor = Actor(), reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            existing = None
            if stakeholder_id is not None:
                existing = conn.execute("SELECT * FROM matter_stakeholder WHERE id=? AND matter_id=?", (stakeholder_id, matter["id"])).fetchone()
                if not existing:
                    raise MatterError("E_CHILD_NOT_FOUND", f"stakeholder {stakeholder_id} not found")
            email = self._optional_text(data.get("email_normalized", data.get("email")))
            if email:
                email = email.lower()
            if stakeholder_id is None:
                person_key = str(data.get("person_key") or person_key_for_email(email))
                duplicate = conn.execute(
                    "SELECT * FROM matter_stakeholder WHERE matter_id=? AND person_key=? AND deleted_at IS NULL",
                    (matter["id"], person_key),
                ).fetchone()
                if duplicate:
                    result = self._mutation(matter, [], stakeholder=dict(duplicate))
                    result["warnings"] = ["already_linked"]
                    return result
                values = {
                    "matter_id": matter["id"], "person_key": person_key,
                    "display_name": self._optional_text(data.get("display_name")), "email_normalized": email,
                    "organization": self._optional_text(data.get("organization")), "role": self._optional_text(data.get("role")),
                    "relationship": self._optional_text(data.get("relationship")), "is_waiting_on": 1 if data.get("is_waiting_on") else 0,
                    "last_contact_at": data.get("last_contact_at"), "source_resource_id": data.get("source_resource_id"),
                    "created_at": now, "updated_at": now,
                }
                columns = tuple(values)
                cursor = conn.execute(f"INSERT INTO matter_stakeholder ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", tuple(values[c] for c in columns))
                stakeholder_id = int(cursor.lastrowid)
            else:
                allowed = {"display_name", "organization", "role", "relationship", "is_waiting_on", "last_contact_at", "source_resource_id", "deleted_at"}
                changes = {key: value for key, value in data.items() if key in allowed}
                if email is not None:
                    changes["email_normalized"] = email
                changes["updated_at"] = now
                assignments = ", ".join(f"{key}=?" for key in changes)
                conn.execute(f"UPDATE matter_stakeholder SET {assignments} WHERE id=?", (*changes.values(), stakeholder_id))
                if event_kind == "stakeholder_removed":
                    conn.execute(
                        "UPDATE matter_item SET waiting_on_stakeholder_id=NULL, updated_at=?, version=version+1 "
                        "WHERE matter_id=? AND waiting_on_stakeholder_id=?",
                        (now, matter["id"], stakeholder_id),
                    )
            if not self._cas_update(conn, matter["id"], expected_version, {"updated_at": now, "last_activity_at": now}):
                raise self._version_conflict()
            self.refresh_search_projection(conn, matter["id"])
            event_id = self._append_event(
                conn, matter_id=matter["id"], kind=event_kind, actor=actor, source=source,
                dedupe_key=dedupe_key, reason=reason, payload={"stakeholder_id": stakeholder_id}, happened_at=now,
                reverses_event_id=reverses_event_id,
            )
            stakeholder = dict(conn.execute("SELECT * FROM matter_stakeholder WHERE id=?", (stakeholder_id,)).fetchone())
            after = self.repository.get_matter_by_id(conn, matter["id"])
            if event_kind == "stakeholder_added":
                reverse_input = {"public_id": public_id, "operation": "delete", "stakeholder_id": stakeholder_id}
            elif event_kind == "stakeholder_removed":
                reverse_input = {"public_id": public_id, "operation": "restore", "stakeholder_id": stakeholder_id}
            elif event_kind == "stakeholder_restored":
                reverse_input = {"public_id": public_id, "operation": "delete", "stakeholder_id": stakeholder_id}
            else:
                before = dict(existing) if existing is not None else {}
                reverse_input = {
                    "public_id": public_id,
                    "operation": "update",
                    "stakeholder_id": stakeholder_id,
                    "patch": {
                        key: before.get("email_normalized") if key == "email" else before.get(key)
                        for key in data
                        if key in {"display_name", "email", "organization", "role", "relationship", "is_waiting_on", "last_contact_at", "source_resource_id"}
                    },
                }
            return self._mutation(
                after,
                [event_id],
                stakeholder=stakeholder,
                undo=self._undo_descriptor(
                    "matter_stakeholder_mutate",
                    "撤销干系人变更",
                    reverse_input,
                    after,
                    event_id,
                ),
            )

    def list_relations(self, public_id: str, *, direction: str = "both", relation_type: str | None = None) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            clauses = ["r.deleted_at IS NULL"]
            params: list[Any] = []
            if direction == "outgoing":
                clauses.append("r.source_matter_id=?")
                params.append(matter["id"])
            elif direction == "incoming":
                clauses.append("r.target_matter_id=?")
                params.append(matter["id"])
            else:
                clauses.append("(r.source_matter_id=? OR r.target_matter_id=?)")
                params.extend((matter["id"], matter["id"]))
            if relation_type:
                clauses.append("r.relation_type=?")
                params.append(relation_type)
            return [dict(row) for row in conn.execute(
                "SELECT r.*, sm.public_id AS source_public_id, sm.title AS source_title, "
                "tm.public_id AS target_public_id, tm.title AS target_title FROM matter_relation r "
                "JOIN matter sm ON sm.id=r.source_matter_id JOIN matter tm ON tm.id=r.target_matter_id "
                f"WHERE {' AND '.join(clauses)} ORDER BY r.id", params
            )]

    def create_relation(self, public_id: str, data: Mapping[str, Any], **mutation: Any) -> dict[str, Any]:
        now = self.clock_ms()
        expected_version = mutation["expected_version"]
        dedupe_key = self._dedupe(mutation["idempotency_key"])
        actor = mutation.get("actor", Actor())
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, "relation_added")
            if replay:
                return replay
            source_matter = self._require_matter(conn, public_id)
            target = self._require_matter(conn, str(data.get("target_public_id") or ""))
            if source_matter["id"] == target["id"]:
                raise MatterError("E_INVALID_ARG", "matter relation cannot self-loop")
            relation_type = data.get("relation_type")
            if relation_type is not None:
                self._require_value("relation_type", str(relation_type), MATTER_RELATION_TYPES)
            existing = conn.execute(
                "SELECT * FROM matter_relation WHERE source_matter_id=? AND target_matter_id=? "
                "AND relation_type IS ? AND deleted_at IS NULL",
                (source_matter["id"], target["id"], relation_type),
            ).fetchone()
            if existing:
                result = self._mutation(source_matter, [], relation=dict(existing))
                result["warnings"] = ["already_linked"]
                return result
            if not self._cas_update(conn, source_matter["id"], expected_version, {"updated_at": now, "last_activity_at": now}):
                raise self._version_conflict()
            cursor = conn.execute(
                "INSERT INTO matter_relation(source_matter_id,target_matter_id,relation_type,confidence,provenance_json,confirmed_at,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (source_matter["id"], target["id"], relation_type, data.get("confidence"), self._dump(data.get("provenance") or {}), now if data.get("confirmed") else None, now, now),
            )
            relation_id = int(cursor.lastrowid)
            event_id = self._append_event(
                conn, matter_id=source_matter["id"], kind="relation_added", actor=actor,
                source=mutation["source"], dedupe_key=dedupe_key, reason=mutation.get("reason"),
                payload={"relation_id": relation_id, "target_public_id": target["public_id"]}, happened_at=now,
                reverses_event_id=mutation.get("reverses_event_id"),
            )
            after = self.repository.get_matter_by_id(conn, source_matter["id"])
            return self._mutation(
                after,
                [event_id],
                relation=dict(conn.execute("SELECT * FROM matter_relation WHERE id=?", (relation_id,)).fetchone()),
                undo=self._undo_descriptor(
                    "matter_relation_mutate",
                    "撤销事项关系",
                    {"public_id": public_id, "operation": "delete", "relation_id": relation_id},
                    after,
                    event_id,
                ),
            )

    def patch_relation(self, public_id: str, relation_id: int, patch: Mapping[str, Any], **mutation: Any) -> dict[str, Any]:
        return self._mutate_relation(public_id, relation_id, patch, "relation_updated", **mutation)

    def delete_relation(self, public_id: str, relation_id: int, **mutation: Any) -> dict[str, Any]:
        return self._mutate_relation(public_id, relation_id, {"deleted_at": self.clock_ms()}, "relation_removed", **mutation)

    def restore_relation(self, public_id: str, relation_id: int, **mutation: Any) -> dict[str, Any]:
        return self._mutate_relation(public_id, relation_id, {"deleted_at": None}, "relation_restored", **mutation)

    def _mutate_relation(self, public_id: str, relation_id: int, patch: Mapping[str, Any], event_kind: str, *, expected_version: int, idempotency_key: str, source: str, actor: Actor = Actor(), reason: str | None = None, reverses_event_id: int | None = None) -> dict[str, Any]:
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            relation = conn.execute("SELECT * FROM matter_relation WHERE id=? AND source_matter_id=?", (relation_id, matter["id"])).fetchone()
            if not relation:
                raise MatterError("E_CHILD_NOT_FOUND", f"relation {relation_id} not found")
            if "relation_type" in patch and patch["relation_type"] is not None:
                self._require_value("relation_type", str(patch["relation_type"]), MATTER_RELATION_TYPES)
            changes = {key: value for key, value in patch.items() if key in {"relation_type", "confidence", "deleted_at"}}
            if patch.get("confirmed"):
                changes["confirmed_at"] = relation["confirmed_at"] or now
            changes["updated_at"] = now
            if not self._cas_update(conn, matter["id"], expected_version, {"updated_at": now, "last_activity_at": now}):
                raise self._version_conflict()
            conn.execute(f"UPDATE matter_relation SET {', '.join(f'{key}=?' for key in changes)} WHERE id=?", (*changes.values(), relation_id))
            event_id = self._append_event(conn, matter_id=matter["id"], kind=event_kind, actor=actor, source=source, dedupe_key=dedupe_key, reason=reason, payload={"relation_id": relation_id}, happened_at=now, reverses_event_id=reverses_event_id)
            after = self.repository.get_matter_by_id(conn, matter["id"])
            if event_kind == "relation_removed":
                reverse_input = {"public_id": public_id, "operation": "restore", "relation_id": relation_id}
            elif event_kind == "relation_restored":
                reverse_input = {"public_id": public_id, "operation": "delete", "relation_id": relation_id}
            else:
                reverse_input = {
                    "public_id": public_id,
                    "operation": "update",
                    "relation_id": relation_id,
                    "patch": {
                        key: (relation["confirmed_at"] is not None if key == "confirmed" else relation[key])
                        for key in patch
                        if key in {"relation_type", "confidence", "confirmed"}
                    },
                }
            return self._mutation(
                after,
                [event_id],
                relation=dict(conn.execute("SELECT * FROM matter_relation WHERE id=?", (relation_id,)).fetchone()),
                undo=self._undo_descriptor(
                    "matter_relation_mutate",
                    "撤销事项关系变更",
                    reverse_input,
                    after,
                    event_id,
                ),
            )

    def lookup_resource_links(self, provider: str, keys: list[str]) -> dict[str, list[dict[str, Any]]]:
        with self.repository.connect() as conn:
            return self.repository.lookup_resource_links(conn, provider, keys)

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
                        "change_count": len(full["changes"] or []),
                        "is_stale": bool(full["is_stale"]),
                        "agent_run_id": full["agent_run_id"],
                        "confidence": full["confidence"],
                        "anchored_matter_version": full["anchored_matter_version"],
                        "created_by_kind": full["created_by_kind"],
                    }
                )
            return {"items": items, "next_cursor": next_cursor}

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
        with self.repository.transaction() as conn:
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
            if bool(update["is_stale"]) or int(update["anchored_matter_version"]) != int(
                matter["version"]
            ):
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
                    payload={
                        "update_id": update_id,
                        "accepted_change_ids": selected,
                    },
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
                "SELECT id FROM matter_update WHERE matter_id=? "
                "AND review_status='pending' AND id != ?",
                (matter["id"], update_id),
            ).fetchall()
            for row in others:
                conn.execute(
                    "UPDATE matter_update SET review_status='superseded', "
                    "reviewed_at=?, reviewed_by_kind=?, reviewed_by_id=? WHERE id=?",
                    (now, actor.kind, actor.actor_id, row["id"]),
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
        """拒绝提案：不应用、留档 reason、version 照 bump（REST #3）、无 undo。stale 行可拒。"""
        reason_text = self._optional_text(reason)
        if not reason_text:
            raise MatterError("E_INVALID_ARG", "reject reason is required")
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
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
            if not self._cas_update(
                conn, matter["id"], expected_version, {"updated_at": now}
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
        now: int,
    ) -> None:
        """逐 change 应用（D9 步骤 4）：field→matter 列；action→item；resource→link
        确认；fact/inference 只留档不落结构化状态。"""
        kind = str(change.get("kind") or "")
        if kind in ("fact", "inference"):
            return
        if kind == "field":
            target = change.get("target")
            field = target.get("field") if isinstance(target, Mapping) else None
            value = change.get("after")
            if field == "status":
                self._require_value("status", str(value), MATTER_STATUSES)
                direct_changes["status"] = str(value)
            elif field == "health":
                self._require_value("health", str(value), MATTER_HEALTH_VALUES)
                direct_changes["health"] = str(value)
            elif field == "priority":
                self._require_value("priority", str(value), MATTER_PRIORITIES)
                direct_changes["priority"] = str(value)
            elif field == "due_at":
                if value is not None and not isinstance(value, int):
                    raise MatterError(
                        "E_INVALID_ARG", f"change {change_id}: due_at must be int|null"
                    )
                direct_changes["due_at"] = value
            elif field == "waiting_context":
                direct_changes["waiting_context_json"] = (
                    self._dump(value) if value is not None else None
                )
            else:
                raise MatterError(
                    "E_INVALID_ARG", f"change {change_id}: field not allowed: {field}"
                )
            applied_events.append(
                ("matter_updated", {"fields": [field], "via_update_id": update_id}, None, None)
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
                        {"kind": "action", "via_update_id": update_id},
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
            after = change.get("after")
            item_patch: dict[str, Any] = {}
            if isinstance(after, Mapping):
                allowed_keys = {
                    "title", "description", "status", "priority", "due_at",
                    "completed_at",
                }
                item_patch = {
                    key: after[key] for key in after if key in allowed_keys
                }
            elif isinstance(after, str):
                item_patch = {"status": after}
            elif after is not None:
                raise MatterError(
                    "E_INVALID_ARG",
                    f"action change {change_id}: unsupported after shape",
                )
            if change.get("text") is not None and "title" not in item_patch:
                item_patch["title"] = str(change["text"])
            if "status" in item_patch:
                self._require_value(
                    "status", str(item_patch["status"]), MATTER_ITEM_STATUSES
                )
            if "priority" in item_patch and item_patch["priority"] is not None:
                self._require_value(
                    "priority", str(item_patch["priority"]), MATTER_PRIORITIES
                )
            if not item_patch:
                warnings.append(f"action_change_noop:{change_id}")
                return
            item_patch["updated_at"] = now
            self.repository.update_item(conn, matter["id"], int(item_id), item_patch)
            applied_events.append(
                (
                    "item_updated",
                    {
                        "fields": sorted(k for k in item_patch if k != "updated_at"),
                        "via_update_id": update_id,
                    },
                    int(item_id),
                    None,
                )
            )
            return
        if kind == "resource":
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
            applied_events.append(
                (
                    "resource_updated",
                    {"via_update_id": update_id, "confirmed": True},
                    None,
                    int(resource_id),
                )
            )
            return
        raise MatterError(
            "E_INVALID_ARG", f"change {change_id}: unsupported kind {kind}"
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

    def _normalize_binding_patch(
        self, conn: sqlite3.Connection, binding: Mapping[str, Any]
    ) -> tuple[dict[str, Any], list[str]]:
        """绑定三键归一（D2）：instructions ≤4000；profile 悬空只 warning 不硬拒。"""
        changes: dict[str, Any] = {}
        warnings: list[str] = []
        if "matter_instructions" in binding:
            value = binding["matter_instructions"]
            if value is not None:
                value = str(value)
                if len(value) > MATTER_INSTRUCTIONS_MAX_CHARS:
                    raise MatterError(
                        "E_INVALID_ARG",
                        f"matter_instructions exceeds {MATTER_INSTRUCTIONS_MAX_CHARS} characters",
                    )
                value = value.strip() or None
            changes["matter_instructions"] = value
        if "agent_enabled" in binding:
            changes["agent_enabled"] = 1 if binding["agent_enabled"] else 0
        if "agent_profile_id" in binding:
            profile_id = binding["agent_profile_id"]
            if profile_id is not None:
                profile_id = str(profile_id)
                try:
                    row = conn.execute(
                        "SELECT type FROM report_agent WHERE id=?",
                        (profile_id,),
                    ).fetchone()
                except sqlite3.OperationalError:
                    row = None  # report_agent 表未建（纯 SyncStore 环境）→ 按悬空处理
                if row is None or (row["type"] or "") != "custom":
                    warnings.append("agent_profile_dangling")
            changes["agent_profile_id"] = profile_id
        if "schedule_json" in binding:
            schedule = binding["schedule_json"]
            if schedule is None:
                changes["schedule_json"] = None
            else:
                from zoneinfo import ZoneInfo

                from src.agents.schedule_rule import (
                    ScheduleRuleError,
                    parse_anchor,
                    parse_rule,
                )

                # P6-B D16：内容升成 v2 envelope（多 trigger），v1 单对象仍接受并
                # 惰性升格。结构校验交给 triggers.parse_trigger_set，schedule 分支的
                # 值域深校验仍走 schedule_rule（不复制它的规则）。
                from .triggers import TriggerError, normalize_trigger_json

                try:
                    normalized = normalize_trigger_json(schedule)
                except TriggerError as exc:
                    raise MatterError("E_INVALID_ARG", f"invalid schedule_json: {exc}") from exc
                if normalized is None:
                    changes["schedule_json"] = None
                else:
                    for entry in normalized["triggers"]:
                        if entry["kind"] != "schedule":
                            continue
                        try:
                            parse_rule(entry.get("rule"))
                            parse_anchor(entry.get("anchor"))
                            timezone_name = entry.get("timezone")
                            if not isinstance(timezone_name, str) or not timezone_name.strip():
                                raise ScheduleRuleError("timezone is required")
                            ZoneInfo(timezone_name)
                        except Exception as exc:
                            raise MatterError(
                                "E_INVALID_ARG", f"invalid schedule_json: {exc}"
                            ) from exc
                    changes["schedule_json"] = self._dump(normalized)
        return changes, warnings

    def _cas_update(
        self,
        conn: sqlite3.Connection,
        matter_id: int,
        expected_version: int,
        changes: Mapping[str, Any],
    ) -> bool:
        """cas_update_matter 的**唯一** service 出口：bump 成功即触发 stale 钩子（D9）。

        所有 bump version 的写路径都必须走这里 —— pending 提案的锚随之失效
        （is_stale 物化，幂等 UPDATE），accept 对 stale 行硬拒 E_UPDATE_STALE。
        """
        ok = self.repository.cas_update_matter(conn, matter_id, expected_version, changes)
        if ok:
            self._mark_stale_proposals(conn, matter_id, int(expected_version) + 1)
        return ok

    def _mark_stale_proposals(
        self, conn: sqlite3.Connection, matter_id: int, new_version: int
    ) -> None:
        conn.execute(
            "UPDATE matter_update SET is_stale=1, stale_at=?, "
            "stale_reason='matter_version_advanced' "
            "WHERE matter_id=? AND review_status='pending' AND is_stale=0 "
            "AND anchored_matter_version < ?",
            (self.clock_ms(), matter_id, new_version),
        )

    def _resolve_source_resource(self, conn: sqlite3.Connection, source_spec: Any) -> dict[str, Any]:
        if not isinstance(source_spec, Mapping) or source_spec.get("provider") != EMAIL_PROVIDER or source_spec.get("kind") != "email":
            raise MatterError("E_INVALID_ARG", "source_resource must be a mailagent email")
        internal_id = int(source_spec.get("internal_id") or 0)
        row = conn.execute("SELECT internal_id,subject,thread_id,date_received,message_id FROM email_metadata WHERE internal_id=?", (internal_id,)).fetchone()
        if not row:
            raise MatterError("E_UPSTREAM", f"email {internal_id} not found")
        email_spec = {
            "provider": EMAIL_PROVIDER, "kind": "email", "external_key": email_resource_key(internal_id),
            "title": row["subject"], "metadata": {"internal_id": internal_id, "message_id": row["message_id"], "date_received": row["date_received"]},
            "sub_state": "none",
        }
        resources = [email_spec]
        warnings: list[str] = []
        if source_spec.get("link_scope", "thread") == "thread":
            if row["thread_id"]:
                resources.append({
                    "provider": EMAIL_PROVIDER, "kind": "thread", "external_key": thread_resource_key(row["thread_id"]),
                    "title": row["subject"], "metadata": {"thread_id": row["thread_id"]}, "sub_state": "active",
                })
            else:
                warnings.append("thread_unavailable")
        elif source_spec.get("link_scope") != "single":
            raise MatterError("E_INVALID_ARG", "link_scope must be thread or single")
        return {"title": row["subject"], "resources": resources, "warnings": warnings}

    def _link_source_snapshot(
        self, conn: sqlite3.Connection, matter_id: int, snapshot: Mapping[str, Any], *,
        actor: Actor, now: int, source: str, reason: str | None,
    ) -> tuple[list[dict[str, Any]], list[str], list[int]]:
        results = []
        warnings = list(snapshot.get("warnings", []))
        event_ids: list[int] = []
        for spec in snapshot["resources"]:
            resource, _ = self._upsert_resource(conn, spec, now)
            link = self.repository.get_resource_link(conn, matter_id, resource["id"], live_only=True)
            if link:
                warnings.append("already_linked")
            else:
                link_id = self.repository.insert_resource_link(conn, {
                    "matter_id": matter_id, "resource_id": resource["id"], "relation_type": None,
                    "pinned": 0, "added_by_kind": actor.kind, "added_by_id": actor.actor_id,
                    "confidence": None, "provenance_json": "{}", "confirmed_at": None,
                    "sub_state": spec.get("sub_state", "none"), "created_at": now, "updated_at": now,
                })
                event_ids.append(self._append_event(
                    conn, matter_id=matter_id, kind="resource_linked", actor=actor,
                    source=source, dedupe_key=f"matter:{matter_id}:resource_linked:{resource['id']}",
                    reason=reason, resource_id=resource["id"], payload={"link_id": link_id}, happened_at=now,
                ))
                link = self.repository.get_resource_link(conn, matter_id, resource["id"], live_only=True)
            results.append({"resource": resource, "link": link})
        return results, list(dict.fromkeys(warnings)), event_ids

    def _upsert_resource(self, conn: sqlite3.Connection, data: Mapping[str, Any], now: int) -> tuple[dict[str, Any], bool]:
        provider = str(data.get("provider") or "").strip().lower()
        external_key = str(data.get("external_key") or "").strip()
        kind = str(data.get("kind") or "")
        if not provider or not external_key:
            raise MatterError("E_INVALID_ARG", "resource provider and external_key are required")
        self._require_value("kind", kind, MATTER_RESOURCE_KINDS)
        external_key = normalize_resource_key(provider, kind, external_key)
        if data.get("sub_state") not in (None, "none") and kind != "thread":
            raise MatterError("E_INVALID_STATE", "subscription state is only supported for thread resources")
        existing = conn.execute("SELECT * FROM resource WHERE provider=? AND external_key=?", (provider, external_key)).fetchone()
        if existing and existing["kind"] != kind:
            raise MatterError("E_RESOURCE_IDENTITY_CONFLICT", "resource identity already exists with another kind")
        return self.repository.upsert_resource(conn, {
            "kind": kind, "provider": provider, "external_key": external_key,
            "canonical_url": self._optional_text(data.get("canonical_url")), "title": self._optional_text(data.get("title")),
            "metadata_json": self._dump(data.get("metadata") or {}), "revision": data.get("revision"),
            "content_hash": data.get("content_hash"), "permission_state": data.get("permission_state"),
            "sync_state": data.get("sync_state"), "access_policy": data.get("access_policy") or "allowed",
            "last_checked_at": data.get("last_checked_at"), "created_at": now, "updated_at": now,
        })

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
            "due_at": data.get("due_at"),
            "completed_at": data.get("completed_at"),
            "checklist_json": self._dump(normalized_checklist),
            "source_resource_id": data.get("source_resource_id"),
            "source_locator_json": self._dump(data["source_locator"])
            if data.get("source_locator") is not None
            else None,
        }

    @staticmethod
    def _semantic_terms(value: str) -> set[str]:
        text = str(value or "").casefold()
        terms = {
            token
            for token in re.findall(r"[\w@.-]+", text, flags=re.UNICODE)
            if len(token) >= 3 and not token.isdigit()
        }
        compact_cjk = "".join(re.findall(r"[\u3400-\u9fff]", text))
        terms.update(
            compact_cjk[index : index + 2]
            for index in range(max(0, len(compact_cjk) - 1))
        )
        return terms

    @staticmethod
    def _input_emails(value: Any) -> set[str]:
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            return set()
        emails = set()
        for item in value:
            raw = item.get("email") if isinstance(item, Mapping) else item
            email = str(raw or "").strip().casefold()
            if "@" in email:
                emails.add(email)
        return emails

    @staticmethod
    def _input_resource_keys(value: Any) -> set[str]:
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            return set()
        keys = set()
        for item in value:
            if not isinstance(item, Mapping):
                continue
            provider = str(item.get("provider") or "").strip().lower()
            kind = str(item.get("kind") or "").strip()
            external_key = str(item.get("external_key") or "").strip()
            if provider and kind and external_key:
                keys.add(
                    f"{provider}:{normalize_resource_key(provider, kind, external_key)}"
                )
        return keys

    def _email_resource_candidates(
        self, conn: sqlite3.Connection, matter: Mapping[str, Any], *,
        query: str | None, expand_reason: str | None, limit: int,
    ) -> tuple[list[dict[str, Any]], int, bool]:
        linked_rows = conn.execute(
            "SELECT r.kind,r.external_key FROM matter_resource mr "
            "JOIN resource r ON r.id=mr.resource_id "
            "WHERE mr.matter_id=? AND mr.deleted_at IS NULL AND r.provider=?",
            (matter["id"], EMAIL_PROVIDER),
        ).fetchall()
        linked_keys = {row["external_key"] for row in linked_rows}
        thread_ids = {
            row["external_key"].split(":", 1)[1]
            for row in linked_rows
            if row["kind"] == "thread" and ":" in row["external_key"]
        }
        linked_email_ids = [
            int(row["external_key"].split(":", 1)[1])
            for row in linked_rows
            if row["kind"] == "email" and ":" in row["external_key"]
        ]
        if linked_email_ids:
            placeholders = ",".join("?" for _ in linked_email_ids)
            thread_ids.update(
                row[0]
                for row in conn.execute(
                    f"SELECT DISTINCT thread_id FROM email_metadata WHERE internal_id IN ({placeholders}) "
                    "AND thread_id IS NOT NULL",
                    linked_email_ids,
                ).fetchall()
            )
        stakeholder_emails = {
            row[0].casefold()
            for row in conn.execute(
                "SELECT email_normalized FROM matter_stakeholder "
                "WHERE matter_id=? AND deleted_at IS NULL AND email_normalized IS NOT NULL",
                (matter["id"],),
            ).fetchall()
        }
        document = conn.execute(
            "SELECT * FROM matter_search_document WHERE matter_id=?", (matter["id"],)
        ).fetchone()
        matter_text = " ".join(
            str(document[key] or "")
            for key in (
                "title", "description", "current_summary", "items_text",
                "stakeholders_text", "notes_text",
            )
        ) if document else str(matter["title"])
        query_terms = self._semantic_terms(" ".join((matter_text, str(query or ""))))
        rows = conn.execute(
            "SELECT internal_id,message_id,thread_id,subject,sender,sender_name,to_addr,cc_addr,"
            "date_received,snippet FROM email_metadata ORDER BY date_received DESC,internal_id DESC LIMIT ?",
            (RESOURCE_DISCOVERY_SCAN_LIMIT,),
        ).fetchall()

        def build_candidate(row: sqlite3.Row, scope: str) -> dict[str, Any] | None:
            external_key = email_resource_key(int(row["internal_id"]))
            if external_key in linked_keys:
                return None
            addresses = " ".join(
                str(row[key] or "") for key in ("sender", "to_addr", "cc_addr")
            ).casefold()
            evidence = []
            score = 0.0
            if row["thread_id"] and row["thread_id"] in thread_ids:
                evidence.append(f"thread:{row['thread_id']}")
                score += 0.62
            matched_people = sorted(
                email for email in stakeholder_emails if email in addresses
            )
            if matched_people:
                evidence.extend(f"stakeholder:{email}" for email in matched_people)
                score += min(0.28, 0.18 + len(matched_people) * 0.05)
            email_terms = self._semantic_terms(
                " ".join(str(row[key] or "") for key in ("subject", "sender_name", "snippet"))
            )
            matched_terms = sorted(query_terms & email_terms)
            if matched_terms:
                evidence.extend(f"keyword:{term}" for term in matched_terms[:8])
                score += min(0.24, 0.08 + len(matched_terms) * 0.03)
            if scope == "local" and not any(
                item.startswith(("thread:", "stakeholder:")) for item in evidence
            ):
                return None
            if scope == "expanded":
                evidence.append(f"expansion:{expand_reason}")
                if query:
                    evidence.extend(
                        f"query:{term}" for term in sorted(self._semantic_terms(query))[:8]
                    )
                if not matched_terms and not matched_people:
                    return None
                score = max(score, 0.45 if expand_reason == "verification" else 0.36)
            if score < 0.25:
                return None
            reason_parts = []
            if row["thread_id"] and row["thread_id"] in thread_ids:
                reason_parts.append("与已关联邮件处于同一线程")
            if matched_people:
                reason_parts.append("涉及事项干系人")
            if matched_terms:
                reason_parts.append(f"命中主题词：{', '.join(matched_terms[:4])}")
            if scope == "expanded":
                reason_parts.append(f"因 {expand_reason} 外扩检索")
            return {
                "external_key": external_key,
                "title": row["subject"],
                "metadata": {
                    "internal_id": int(row["internal_id"]),
                    "message_id": row["message_id"],
                    "thread_id": row["thread_id"],
                    "date_received": row["date_received"],
                },
                "scope": scope,
                "reason": "；".join(reason_parts),
                "evidence": sorted(set(evidence)),
                "confidence": round(min(score, 0.98), 3),
            }

        local = [candidate for row in rows if (candidate := build_candidate(row, "local"))]
        local.sort(key=lambda item: -item["confidence"])
        should_expand = False
        if expand_reason == "context_gap":
            should_expand = not local
        elif expand_reason == "verification":
            if not str(query or "").strip():
                raise MatterError(
                    "E_INVALID_ARG", "verification expansion requires a query"
                )
            should_expand = True
        elif expand_reason == "matter_instructions":
            if not str(matter.get("matter_instructions") or "").strip():
                raise MatterError(
                    "E_INVALID_STATE", "matter has no instructions requiring expansion"
                )
            should_expand = True
        expanded: list[dict[str, Any]] = []
        if should_expand:
            local_keys = {item["external_key"] for item in local}
            expanded = [
                candidate
                for row in rows
                if (candidate := build_candidate(row, "expanded"))
                and candidate["external_key"] not in local_keys
            ]
            expanded.sort(key=lambda item: -item["confidence"])
        combined = (local + expanded)[:limit]
        return combined, len(local), should_expand

    def _tag_replay(
        self,
        conn: sqlite3.Connection,
        dedupe_key: str,
        operation: str,
        payload: Mapping[str, Any],
    ) -> dict[str, Any] | None:
        stored = self.repository.get_tag_mutation(conn, dedupe_key)
        if not stored:
            return None
        if stored.get("operation") != operation or stored.get("payload") != dict(payload):
            raise MatterError(
                "E_IDEMPOTENCY_CONFLICT",
                "idempotency key was used for another mutation",
            )
        result = stored.get("result")
        return dict(result) if isinstance(result, Mapping) else None

    def _store_tag_mutation(
        self,
        conn: sqlite3.Connection,
        dedupe_key: str,
        *,
        operation: str,
        payload: Mapping[str, Any],
        result: Mapping[str, Any],
        now: int,
    ) -> None:
        self.repository.put_tag_mutation(
            conn,
            dedupe_key,
            value={
                "operation": operation,
                "payload": dict(payload),
                "result": dict(result),
            },
            updated_at=now,
        )

    def _append_tag_reference_events(
        self,
        conn: sqlite3.Connection,
        changed_rows: Sequence[Mapping[str, Any]],
        *,
        dedupe_key: str,
        actor: Actor,
        source: str,
        reason: str | None,
        now: int,
        payload: Mapping[str, Any],
        reverses_event_id: int | None,
    ) -> list[int]:
        event_ids: list[int] = []
        for row in changed_rows:
            matter_id = int(row["id"])
            self._mark_stale_proposals(
                conn, matter_id, int(row.get("version") or 0) + 1
            )
            self.refresh_search_projection(conn, matter_id)
            event_ids.append(
                self._append_event(
                    conn,
                    matter_id=matter_id,
                    kind=MATTER_UPDATED,
                    actor=actor,
                    source=source,
                    dedupe_key=f"{dedupe_key}:matter:{matter_id}",
                    reason=reason,
                    payload=dict(payload),
                    happened_at=now,
                    reverses_event_id=reverses_event_id,
                )
            )
        return event_ids

    @staticmethod
    def _normalize_tag_name(value: Any) -> str:
        try:
            tags = normalize_tags([str(value or "")])
        except ValueError as exc:
            raise MatterError("E_INVALID_ARG", str(exc)) from exc
        if not tags:
            raise MatterError("E_INVALID_ARG", "tag name is required")
        return tags[0]

    def _listed_tag(self, conn: sqlite3.Connection, name: str) -> dict[str, Any]:
        for tag in self.repository.list_tags(conn):
            if tag["name"] == name:
                return tag
        return {
            "name": name,
            "color": MATTER_TAG_DEFAULT_COLOR.value,
            "shape": MATTER_TAG_DEFAULT_SHAPE.value,
            "created_at": None,
            "usage_count": 0,
            "inferred": True,
        }

    def _append_event(
        self,
        conn: sqlite3.Connection,
        *,
        matter_id: int,
        kind: str,
        actor: Actor,
        source: str,
        dedupe_key: str,
        payload: Mapping[str, Any],
        happened_at: int,
        reason: str | None,
        item_id: int | None = None,
        update_id: int | None = None,
        resource_id: int | None = None,
        reverses_event_id: int | None = None,
    ) -> int:
        event_payload = dict(payload)
        event_payload.update(
            {
                "source": source,
                "reason": reason,
                "idempotency_key": dedupe_key[:16] + "…",
            }
        )
        return self.repository.insert_event(
            conn,
            {
                "matter_id": matter_id,
                "kind": kind,
                "happened_at": happened_at,
                "actor_kind": actor.kind,
                "actor_id": actor.actor_id,
                "source": source or "desktop_ui",
                "resource_id": resource_id,
                "item_id": item_id,
                "update_id": update_id,
                "reverses_event_id": reverses_event_id,
                "dedupe_key": dedupe_key,
                "payload_json": self._dump(event_payload),
                "created_at": happened_at,
            },
        )

    def _replay(
        self,
        conn: sqlite3.Connection,
        dedupe_key: str,
        expected_kind: str,
        *,
        include_item: bool = False,
    ) -> dict[str, Any] | None:
        event = self.repository.find_event(conn, dedupe_key)
        if not event:
            return None
        if event["kind"] != expected_kind:
            raise MatterError(
                "E_IDEMPOTENCY_CONFLICT",
                "idempotency key was used for another mutation",
            )
        matter = self.repository.get_matter_by_id(conn, event["matter_id"])
        extra = {}
        if include_item and event.get("item_id"):
            extra["item"] = self.repository.get_item(
                conn, event["matter_id"], event["item_id"]
            )
        return self._mutation(matter, [event["id"]], **extra)

    def _require_matter(
        self, conn: sqlite3.Connection, public_id: str
    ) -> dict[str, Any]:
        matter = self.repository.get_matter(conn, public_id)
        if not matter:
            raise MatterError("E_MATTER_NOT_FOUND", f"matter {public_id} not found")
        return matter

    def _decorate_url_resource(self, item: Mapping[str, Any]) -> dict[str, Any]:
        result = dict(item)
        resource = result.get("resource")
        if isinstance(resource, Mapping):
            result["resource"] = self._resource_with_url_cache(resource)
        return result

    def _resource_with_url_cache(self, resource: Mapping[str, Any]) -> dict[str, Any]:
        result = dict(resource)
        if result.get("kind") == "url":
            result["url_fetch_cache"] = describe_url_cache(result, self.clock_ms())
            metadata = dict(result.get("metadata") or {})
            metadata.pop(URL_CACHE_TEXT_KEY, None)
            metadata.pop(URL_CACHE_METADATA_KEY, None)
            result["metadata"] = metadata
        return result

    @staticmethod
    def _validate_url_fetch_resource(
        resource: Mapping[str, Any] | None, link: Mapping[str, Any] | None
    ) -> None:
        if resource is None or link is None:
            raise MatterError("E_CHILD_NOT_FOUND", "linked resource not found")
        if resource.get("kind") != "url":
            raise MatterError("E_INVALID_STATE", "readable fetch is only supported for URL resources")
        if resource.get("access_policy") != "allowed":
            raise MatterError("E_INVALID_STATE", "URL resource content access is not allowed")
        if not str(resource.get("canonical_url") or "").strip():
            raise MatterError("E_INVALID_STATE", "URL resource has no canonical_url")

    @staticmethod
    def _mutation(
        matter: dict[str, Any] | None, event_ids: list[int], **extra: Any
    ) -> dict[str, Any]:
        result = {
            "matter": matter,
            "version": matter["version"] if matter else None,
            "event_ids": event_ids,
            "warnings": [],
            "undo": None,
        }
        result.update(extra)
        return result

    @staticmethod
    def _undo_descriptor(
        tool: str,
        label: str,
        input_data: Mapping[str, Any],
        matter: Mapping[str, Any] | None,
        event_id: int,
    ) -> dict[str, Any] | None:
        if matter is None:
            return None
        return {
            "tool": tool,
            "input": {
                **dict(input_data),
                "expected_version": matter["version"],
                "reverses_event_id": event_id,
            },
            "label": label,
        }

    @staticmethod
    def _version_conflict() -> MatterError:
        return MatterError(
            "E_VERSION_CONFLICT",
            "matter version changed",
            hint="Reload the Matter and retry with the latest version.",
        )

    @staticmethod
    def _require_value(field: str, value: str, allowed: Sequence[str]) -> None:
        if value not in allowed:
            raise MatterError("E_INVALID_ARG", f"invalid {field}: {value}")

    @staticmethod
    def _validate_actor(actor: Actor) -> None:
        if actor.kind not in MATTER_ACTOR_KINDS:
            raise MatterError("E_INVALID_ARG", f"invalid actor kind: {actor.kind}")

    @staticmethod
    def _optional_text(value: Any) -> str | None:
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    @staticmethod
    def _dump(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _dedupe(idempotency_key: str) -> str:
        key = str(idempotency_key or "").strip()
        if not key:
            raise MatterError("E_INVALID_ARG", "idempotency_key is required")
        return key

    def refresh_search_projection(
        self, conn: sqlite3.Connection, matter_id: int
    ) -> None:
        self.repository.refresh_search_projection(conn, matter_id)

    def rebuild_all_search_documents(self) -> int:
        return self.repository.rebuild_all_search_documents()
