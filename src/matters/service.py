"""Transactional Matter aggregate service."""

from __future__ import annotations

import json
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime
from email.utils import getaddresses
from typing import Any, Mapping, Sequence

from loguru import logger

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
    MATTER_SUGGESTION_BULK_ACTIONS,
    MATTER_SUGGESTION_BULK_MAX,
    MATTER_UPDATE_REVIEW_STATUSES,
    MatterActorKind,
    MatterItemKind,
    MatterSuggestionBulkAction,
    MatterSuggestionBulkSkipReason,
    format_public_id,
    normalize_goal_checks,
    normalize_tags,
    person_key_for_email,
)
from .proposal_scope import (
    SCOPE_EVERYTHING,
    SCOPE_NOTHING,
    MatterWriteScope,
    proposal_scope,
    scope_from_items,
    scope_from_matter_columns,
    scope_from_resources,
)
from .repository import MatterRepository
from .resource_identity import (
    EMAIL_PROVIDER,
    MatterError,
    attachment_resource_key,
    evidence_fingerprint,
    email_resource_key,
    normalize_resource_key,
    rejection_resource_key,
    thread_resource_key,
)
from .resource_proposal import (
    ResourceProposalError,
    apply_allowed_providers,
    new_resource_spec,
    normalize_new_resource,
)
from .url_fetch import (
    URL_CACHE_METADATA_KEY,
    URL_CACHE_TEXT_KEY,
    cached_url_text,
    content_hash,
    describe_url_cache,
    fetch_readable_url,
)
from .event_changes import (
    ITEM_CHANGE_FIELDS,
    MATTER_CHANGE_FIELDS,
    STAKEHOLDER_CHANGE_FIELDS,
    build_changes,
    truncated_text,
)
from .events import (
    AGENT_BINDING_CHANGED,
    ITEM_CREATED,
    MATTER_CREATED,
    MATTER_UPDATED,
    RELATION_ADDED,
    RESOURCE_LINKED,
    RESOURCE_SUGGESTION_ACCEPTED,
    RESOURCE_SUGGESTION_REJECTED,
    UPDATE_ACCEPTED,
    UPDATE_REJECTED,
    UPDATE_SUPERSEDED,
)

TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
#: 邮件提取候选的地址形状闸（TS 侧镜像 `matterStakeholderCandidates.ts` 的
#: MATTER_STAKEHOLDER_EMAIL_RE，同一形状：非空 local@域.tld）。
_CONTACT_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
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
# 资料发现的词表纪律（0812 dogfood「拉了一堆无关信息」批）。三个档由**文档频率**（DF）划分，
# 语料 = 本次扫描窗口那批行本身（最近 RESOURCE_DISCOVERY_SCAN_LIMIT 封）：候选就是从这批
# 行里选的，用同一批行算词频恰好是「在这个池子里算不算稀有」的正解，而且零额外 I/O ——
# 🔴 绝不为算词频再全表扫一遍。
#   · common（虚词）：活库实测最近 500 封里 `邮件` 5.0% / `时间` 6.8% / `确认` 7.2% /
#     `项目` 8.0% / `omada` 26.8%（自家公司名）。靠它们召回 = 全域召回，只留一点点加分。
#   · rare（低频词） / distinctive（专有名词档）：命中一个就足以说明「这封确实在讲那件事」。
# 小语料保护（MIN_DOCS）不可省：测试库/新装机器只有几封邮件时，纯比例会把每个词都判成
# 全域词，召回直接归零。
RESOURCE_TERM_COMMON_DF_RATIO = 0.05
RESOURCE_TERM_COMMON_MIN_DOCS = 5
RESOURCE_TERM_RARE_DF_RATIO = 0.01
RESOURCE_TERM_RARE_MIN_DOCS = 2
RESOURCE_TERM_DISTINCTIVE_DF_RATIO = 0.002
RESOURCE_TERM_DISTINCTIVE_MIN_DOCS = 1
# 召回权重：distinctive 3 / rare 2 / normal 1 / common 0，过线 ≥3。等价说法 =
# 「一个低频词顶两个普通词」：低频词 + 普通词过线、单个专有名词（项目代号那种，一个就
# 该把邮件关联上）也过线，而**一两个普通词过不了线、任意多个虚词永远过不了线**（虚词
# 恒 0 分）—— 后者正是活库那 10 条噪音的来路。
RESOURCE_TERM_WEIGHTS = {"distinctive": 3, "rare": 2, "normal": 1, "common": 0}
RESOURCE_KEYWORD_RECALL_MIN_WEIGHT = 3
# ⚠️ 留给下一个做召回调优的人（0812 变异测试的实测发现，本批**有意**不动）：这道闸与
# `_email_resource_candidates` 里的 `score < 0.25` 准入线**几乎完全冗余** —— 关键词分是
# `min(0.40, 0.10 × recall_weight)`，权重是整数，于是 `0.10 × w ≥ 0.25 ⟺ w ≥ 3`，两道判的
# 是同一件事。实测把本常量从 3 改成 1，整套 matters 用例（318 条）里除了直接断言这个数字
# 的那条以外**一条都不变红**。
# 它唯一还起作用的格子：expanded 那一趟里「有同线程锚（+0.62）、但关键词权重不足」——
# 此时 `keyword_recalled=False` 且 `matched_people` 为空 ⇒ 一封分数其实很高的邮件被丢弃。
# 要合并成一道闸就得先决定那一格该怎么判（同线程锚该不该自己就够格进 expanded 结果），
# 那是召回语义的改动，不是清理重复常量。

# 一个事项挂着 10 条待审建议时不再堆新的：用户先处理完再说（0812 修法 6）。
RESOURCE_SUGGESTION_BACKLOG_CAP = 10

# 「关联资料」弹窗附件 tab 一次列多少条。纯展示上限，不是业务语义 —— 挂了几百封邮件的事项
# 把全部附件铺出来既慢又没人翻得完，用户要具体某一份可以从那封邮件本身进。
MATTER_RESOURCE_ATTACHMENT_LIMIT = 200


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
                kind=MATTER_CREATED,
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

    def context_snapshot(self, public_id: str) -> dict[str, Any]:
        """事项的有界只读投影。🔴 只读 —— 它一行都不写库。

        0812 修法 4：这里原本先跑一遍 discovery，`local_candidate_count == 0` 时**自己给自己
        签一张 `context_gap` 的条子**再跑一遍全库外扩 —— 没有用户声明、没有审批、`query=None`
        （最脏形态），而 `run_spec` 用的正是默认值 ⇒ 每次跟进 run 自动开火灌垃圾。而且那个
        `local_candidate_count == 0` 判据本身就是错的：该计数已排除全部已关联资源，事项越
        整齐越等于 0。跟进 run 的工具面现在是全部只读工具 + 全库检索，模型能按契约里的三档
        优先级**自己有意识地查** —— 砍掉这条自动路径不是削功能。
        本地那一趟（durable anchor only）由调用方显式发起，见 `run_spec.build_matter_run_spec`。
        """
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
            linked_resources = self.repository.list_resources(conn, matter["id"], {})
            visible_resources = [
                joined
                for joined in linked_resources
                if joined["link"]["pinned"]
                or (
                    joined["link"]["confirmed_at"] is None
                    and joined["link"]["added_by_kind"] == "agent"
                )
            ]
            # 🔴 `resources` 是**投影**（pinned 或未确认的 agent 建议），不是「这个事项有多少
            # 资料」。前端拿 `resources.length === 0` 当「缺上下文」判据会形成自噬循环：
            # 用户把 agent 挂的建议全确认掉（且没 pin）⇒ 投影归零 ⇒ 弹「缺上下文」卡 ⇒
            # 点外扩 ⇒ 灌一批垃圾 ⇒ 卡片消失。**用户越配合越被灌垃圾**。所以另发一个不受
            # 该投影限制的真实计数（0812 修法 5）。
            counts = {
                "linked_resources": len(linked_resources),
                "confirmed_resources": sum(
                    1
                    for joined in linked_resources
                    if joined["link"]["confirmed_at"] is not None
                ),
                "unconfirmed_suggestions": sum(
                    1
                    for joined in linked_resources
                    if joined["link"]["confirmed_at"] is None
                    and joined["link"]["added_by_kind"] == "agent"
                ),
            }
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
                "resource_counts": counts,
                "events": events,
            }

    # 0812 dogfood —— 事项对话的「本事项 / 全库」检索范围开关已按 owner 拍板整体移除（默认恒
    # 全库），写侧的 `record_chat_scope` 与 `POST /{id}/chat-scope` 端点一并删除：留着就是一个
    # 没有任何调用方、却能往时间线写事件的写口。CHAT_SCOPE_EXPANDED / CHAT_SCOPE_RESTORED 两个
    # 常量**有意保留**（见 events.py）——活库里已有历史事件行要继续渲染。

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
            # 清单行的头像组投影（design `list.jsx` 行 2 的 AvatarStack）。additive：
            # 老消费方看不见这两个键也照常工作；新键只在**列表**端点产出，详情端点仍走
            # `/stakeholders` 全量列。
            summaries = self.repository.list_stakeholder_summaries(
                conn, [int(item["id"]) for item in items]
            )
            # 清单行「下一步」的投影（design `list.jsx` 行 2）。同样 additive、同样批量：
            # 列表不返回 items，没有它前端只能落到「缺少下一步」兜底。
            next_actions = self.repository.list_next_action_summaries(
                conn, [int(item["id"]) for item in items]
            )
        for item in items:
            preview, count = summaries.get(int(item["id"]), ([], 0))
            item["stakeholder_summary"] = preview
            item["stakeholder_count"] = count
            item["next_action"] = next_actions.get(int(item["id"]))
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
        # 绑定三键与其余字段分家（去重）：binding 字段只进 agent_binding_changed，
        # 其余进 matter_updated —— 原来两条事件的 happened_at 与 fields 完全相同，
        # UI 上就是两行在讲同一件事。纯 binding 的 patch 只写一条。
        binding_fields = sorted(set(patch) & BINDING_PATCH_FIELDS)
        plain_fields = sorted(set(patch) - BINDING_PATCH_FIELDS)
        binding_only = bool(binding_fields) and not plain_fields
        with self.repository.transaction() as conn:
            # 主事件（持 dedupe_key 那条）的 kind 随上面的分家而变；replay 两种都认
            # —— 它们都只可能由 patch_matter 写出，"这把钥匙被另一种 mutation 用过"
            # 的判据不该被这次形状调整误伤（也顺带兼容升级前写下的老 dedupe_key）。
            replay = self._replay(
                conn, dedupe_key, (MATTER_UPDATED, AGENT_BINDING_CHANGED)
            )
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
            # 单源：事件分家用的 binding_fields 与归一化喂的 binding 必须是同一个集合，
            # 否则「哪些字段进哪条事件」会跟「哪些字段被归一化」悄悄劈叉。
            binding = {field: patch[field] for field in binding_fields}
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
                conn,
                matter["id"],
                expected_version,
                direct_changes,
                # 改 title/tags/description 这类提案碰不到的字段 → 不作废任何提案；
                # 改 status/health/due_at/current_summary → 只作废也动这些字段的提案。
                scope=scope_from_matter_columns(direct_changes),
            ):
                raise self._version_conflict()
            self.refresh_search_projection(conn, matter["id"])
            # 落库后的真身当 after 像：`matter` 与 `after` 都是 _matter_row 投影，
            # 键空间与 patch 字段名 1:1（tags/goal_checks/waiting_context 已解析），
            # 所以 from→to 直接按字段名对比即可，不必再手工映射 *_json 列。
            after = self.repository.get_matter_by_id(conn, matter["id"])
            event_ids: list[int] = []
            if binding_only:
                # 纯 binding patch：只写一条，且由它持 dedupe_key（replay 的落点）。
                event_id = self._append_event(
                    conn,
                    matter_id=matter["id"],
                    kind=AGENT_BINDING_CHANGED,
                    actor=actor,
                    source=source,
                    dedupe_key=dedupe_key,
                    reason=reason,
                    payload={
                        "fields": binding_fields,
                        "changes": build_changes(
                            binding_fields, matter, after, allowed=MATTER_CHANGE_FIELDS
                        ),
                    },
                    happened_at=now,
                    reverses_event_id=reverses_event_id,
                )
                event_ids.append(event_id)
            else:
                event_id = self._append_event(
                    conn,
                    matter_id=matter["id"],
                    kind=MATTER_UPDATED,
                    actor=actor,
                    source=source,
                    dedupe_key=dedupe_key,
                    reason=reason,
                    update_id=update_id,
                    payload={
                        "fields": plain_fields,
                        "changes": build_changes(
                            plain_fields, matter, after, allowed=MATTER_CHANGE_FIELDS
                        ),
                    },
                    happened_at=now,
                    reverses_event_id=reverses_event_id,
                )
                event_ids.append(event_id)
                if binding_fields:
                    event_ids.append(
                        self._append_event(
                            conn,
                            matter_id=matter["id"],
                            kind=AGENT_BINDING_CHANGED,
                            actor=actor,
                            source=source,
                            dedupe_key=f"{dedupe_key}:agent_binding",
                            reason=reason,
                            payload={
                                "fields": binding_fields,
                                "changes": build_changes(
                                    binding_fields,
                                    matter,
                                    after,
                                    allowed=MATTER_CHANGE_FIELDS,
                                ),
                            },
                            happened_at=now,
                        )
                    )
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
            # 🔴 这里**有意不写 matter_event**：`matter_event.matter_id` 是
            # `ON DELETE CASCADE`，同一条语句就会把刚写的事件一起删掉 —— 写了也留不下。
            # （P1 审计把"不写事件"记成缺口，前提不成立。）审计要活过这次删除，就只能落在
            # 事项之外，所以走结构化日志。
            logger.warning(
                "[matters] matter permanently deleted "
                f"public_id={public_id} title={matter['title']!r} "
                f"actor={actor.kind}:{actor.actor_id or '-'} source={source} "
                f"reason={reason or '-'}"
            )
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
                # 新建 item：纯追加，没有任何既有对象被改 → 不作废任何提案。
                scope=SCOPE_NOTHING,
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
                kind=ITEM_CREATED,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                # title = 句子必需的标识（"新增待解问题「…」"）；光有 item_id 写不出来。
                payload={"kind": kind, "title": truncated_text(title)},
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
                # 只有 target 落在这条 item 上的提案才失效。
                scope=scope_from_items([item_id]),
            ):
                raise self._version_conflict()
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
            if snapshot:
                # 🔴 走 `source_resource` 时，link 级字段此前被**静默丢弃** —— snapshot 只产出
                # 资源身份（provider/kind/external_key/title/metadata/sub_state），于是下面
                # `spec.get("pinned")` / `spec.get("confirmed")` 恒为 None：请求里明明写了
                # `confirmed: true` 的手动关联，落库却是 `confirmed_at=NULL`，在 UI 上跟
                # Agent 建议长得一模一样（还带「确认 / 忽略」两颗钮）。
                # 这里把这三个 link 级字段合进每条 spec。**不含 `sub_state`** —— 那个是
                # snapshot 按资源类型自己定的语义（email=none / thread=active），调用方要改
                # 订阅态走 `patch_resource`。不传这些字段的老调用方行为逐字节不变。
                link_fields = {
                    key: data[key]
                    for key in ("pinned", "confirmed", "relation_type")
                    if key in data
                }
                specs = [{**spec, **link_fields} for spec in snapshot["resources"]]
            else:
                specs = [dict(data)]
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
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 新关联的 resource：提案不可能已经引用它（propose 时它还没 link）。
                scope=scope_from_resources([int(resource["id"]) for resource, _ in pending]),
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
                        conn, matter_id=matter["id"], kind=RESOURCE_LINKED, actor=actor,
                        source=source, dedupe_key=event_key, reason=reason,
                        resource_id=resource["id"],
                        payload={
                            "link_id": link_id,
                            # 资料名 + 类型 = 句子必需的标识（"关联了邮件《…》"）。
                            "title": truncated_text(resource.get("title")),
                            "resource_kind": resource.get("kind"),
                        },
                        happened_at=now,
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
            if not self._cas_update(
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 「接受/拒绝资料建议」「置顶」「订阅」都只动这一条 link —— owner 连点 12 次
                # 接受资料建议就把待审提案作废，正是这里没收窄导致的。
                scope=scope_from_resources([resource_id]),
            ):
                raise self._version_conflict()
            event_id = self._append_event(
                conn, matter_id=matter["id"], kind=event_kind, actor=actor, source=source,
                dedupe_key=dedupe_key, reason=reason, resource_id=resource_id,
                payload={
                    "fields": sorted(patch),
                    "title": truncated_text(resource.get("title")),
                    "resource_kind": resource.get("kind"),
                },
                happened_at=now,
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
                scope=scope_from_resources([resource_id]),
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
                payload={
                    "link_id": link["id"],
                    "evidence_fingerprint": fingerprint,
                    "title": truncated_text(resource.get("title")),
                    "resource_kind": resource.get("kind"),
                },
                happened_at=now, reverses_event_id=reverses_event_id,
            )
            after = self.repository.get_matter_by_id(conn, matter["id"])
            return self._mutation(after, [event_id], resource=resource)

    def bulk_resolve_resource_suggestions(
        self,
        public_id: str,
        resource_ids: Sequence[int],
        action: str,
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        """整批确认 / 整批忽略资料建议：**一次版本校验、一次版本推进**。

        0812 dogfood 的第二条 P0：一份建议一次版本推进，Agent 一轮挂十几份 ⇒ 用户点十几次
        ⇒ 中间任何一次错位就撞上乐观锁，然后（在共享出口就位之前）整页卡死。

        🔴 逐条不整批失败：批里混进已确认 / 已删 / 不属于本事项的 id 时，各自按原因**如实
        分开计数**返回（`skipped`），不许把整批打回去 —— 建议列表是异步刷新的，UI 手里那份
        必然可能带上刚被别处处置掉的条目。

        🔴 事件仍是逐条追加（时间线的语义是 append-only，一条 link 一条事件），只是整批
        共用同一个 `happened_at` + 同一个 kind ⇒ 渲染层的 burst 分组天然合并成一句
        「采纳了 N 条资料建议」。时间线一行都不用改。
        """
        # StrEnum 成员与字面量都收，但**存进结果的恒是字面量** —— 返回 enum 成员会让
        # 「同一个字段有时是 str 有时是 enum」传染到 JSON 序列化与调用方比较。
        action = str(action)
        self._require_value("action", action, MATTER_SUGGESTION_BULK_ACTIONS)
        ids = list(dict.fromkeys(int(value) for value in resource_ids))
        if not ids:
            raise MatterError("E_INVALID_ARG", "resource_ids must not be empty")
        if len(ids) > MATTER_SUGGESTION_BULK_MAX:
            raise MatterError(
                "E_INVALID_ARG",
                f"resource_ids must contain at most {MATTER_SUGGESTION_BULK_MAX} ids",
            )
        confirming = action == MatterSuggestionBulkAction.CONFIRM.value
        event_kind = (
            RESOURCE_SUGGESTION_ACCEPTED if confirming else RESOURCE_SUGGESTION_REJECTED
        )
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self.repository.transaction() as conn:
            matter = self._require_matter(conn, public_id)
            pending: list[tuple[dict[str, Any], dict[str, Any], str]] = []
            skipped: list[dict[str, Any]] = []
            for resource_id in ids:
                event_key = f"{dedupe_key}:{resource_id}"
                # 🔴 重放判定必须在「找不到」之前：reject 会把 link 软删，重放这一批时 link
                # 已经不在了，按 not_linked 报会把「已经做过」谎报成「不属于本事项」。
                replayed = self.repository.find_event(conn, event_key)
                if replayed:
                    if replayed["kind"] != event_kind:
                        raise MatterError(
                            "E_IDEMPOTENCY_CONFLICT",
                            "idempotency key was used for another mutation",
                        )
                    skipped.append(
                        {
                            "resource_id": resource_id,
                            "reason": MatterSuggestionBulkSkipReason.ALREADY_APPLIED.value,
                        }
                    )
                    continue
                resource = self.repository.get_resource(conn, resource_id)
                link = self.repository.get_resource_link(
                    conn, matter["id"], resource_id, live_only=True
                )
                if not resource or not link:
                    skipped.append(
                        {
                            "resource_id": resource_id,
                            "reason": MatterSuggestionBulkSkipReason.NOT_LINKED.value,
                        }
                    )
                    continue
                if link["confirmed_at"] is not None:
                    skipped.append(
                        {
                            "resource_id": resource_id,
                            "reason": MatterSuggestionBulkSkipReason.ALREADY_CONFIRMED.value,
                        }
                    )
                    continue
                pending.append((resource, link, event_key))
            if not pending:
                # 一条都做不了就**不推进版本**、也不校验 `expected_version`（镜像
                # add_resource 的 already_linked 分支）：版本号是提案失效的判据，空转一次
                # 会白白作废别人正等着审的提案；而乐观锁保护的是「写」，没有写就没有可丢的
                # 更新 —— 此时报冲突只会让用户对着一批「本来就已经处置完」的建议干瞪眼。
                return self._bulk_suggestion_result(matter, [], action, [], skipped)
            if not self._cas_update(
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                scope=scope_from_resources([resource["id"] for resource, _, _ in pending]),
            ):
                raise self._version_conflict()
            event_ids: list[int] = []
            applied: list[int] = []
            for resource, link, event_key in pending:
                canonical_key = rejection_resource_key(
                    resource["provider"], resource["kind"], resource["external_key"]
                )
                payload: dict[str, Any] = {
                    "title": truncated_text(resource.get("title")),
                    "resource_kind": resource.get("kind"),
                    "link_id": link["id"],
                    "bulk": True,
                }
                if confirming:
                    conn.execute(
                        "UPDATE matter_resource SET confirmed_at=?,updated_at=? WHERE id=?",
                        (now, now, link["id"]),
                    )
                    conn.execute(
                        "DELETE FROM matter_resource_rejection WHERE matter_id=? AND resource_key=?",
                        (matter["id"], canonical_key),
                    )
                    payload["fields"] = ["confirmed"]
                else:
                    # 🔴 与逐条 reject 同一套 rejection 语义（evidence_fingerprint 抑制复现）：
                    # 只删 link 不记账的话，下一轮 discovery 会把它们原样推回来。
                    provenance = link.get("provenance") or {}
                    fingerprint = str(provenance.get("evidence_fingerprint") or "")
                    if not fingerprint:
                        fingerprint = evidence_fingerprint(
                            canonical_key, provenance.get("evidence") or []
                        )
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
                    payload["evidence_fingerprint"] = fingerprint
                event_ids.append(
                    self._append_event(
                        conn,
                        matter_id=matter["id"],
                        kind=event_kind,
                        actor=actor,
                        source=source,
                        dedupe_key=event_key,
                        reason=reason,
                        resource_id=resource["id"],
                        payload=payload,
                        happened_at=now,
                        reverses_event_id=reverses_event_id,
                    )
                )
                applied.append(int(resource["id"]))
            after = self.repository.get_matter_by_id(conn, matter["id"])
            return self._bulk_suggestion_result(
                after, event_ids, action, applied, skipped
            )

    @staticmethod
    def _bulk_suggestion_result(
        matter: dict[str, Any] | None,
        event_ids: list[int],
        action: str,
        applied: list[int],
        skipped: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return MatterService._mutation(
            matter,
            event_ids,
            action=action,
            applied=applied,
            skipped=skipped,
            counts={"applied": len(applied), "skipped": len(skipped)},
        )

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
            # 积压守卫（0812 修法 6）：已经挂着一屏待审建议就别再堆了，先让用户处理完。
            backlog = int(
                conn.execute(
                    "SELECT COUNT(*) FROM matter_resource WHERE matter_id=? "
                    "AND deleted_at IS NULL AND confirmed_at IS NULL AND added_by_kind='agent'",
                    (matter["id"],),
                ).fetchone()[0]
            )
            if backlog >= RESOURCE_SUGGESTION_BACKLOG_CAP:
                return {
                    "items": [],
                    "suppressed": [],
                    "local_candidate_count": 0,
                    "expanded": False,
                    "backlog_capped": True,
                }
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
                        payload={
                            "link_id": link_id, "suggested": True,
                            "evidence_fingerprint": fingerprint,
                            "title": truncated_text(resource.get("title")),
                            "resource_kind": resource.get("kind"),
                        },
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
                    # 新发现的资料建议：只碰这些 link，不改任何既有业务字段。
                    scope=scope_from_resources(
                        [int(entry["resource"]["id"]) for entry in linked]
                    ),
                ):
                    raise self._version_conflict()
            return {
                "items": linked,
                "suppressed": suppressed,
                "local_candidate_count": local_count,
                "expanded": expanded,
                "backlog_capped": False,
            }

    def list_resource_candidates(
        self, public_id: str, *, limit: int = RESOURCE_DISCOVERY_MAX_CANDIDATES
    ) -> dict[str, Any]:
        """「手动关联资料」入口用的**只读**候选（G-14 tab ①「与本事项相关」那一组）。

        与 `discover_resource_suggestions` 共用同一个候选引擎 `_email_resource_candidates`
        —— 于是人工挑与 Agent 建议看到的是同一批锚点、同一套理由文案，不会出现「Agent 说相关
        的这封，我自己搜却看不到」。差别只有一个：这里**一个字都不写**（不建 link、不发事件、
        不推版本、不吃 backlog 配额），所以打开弹窗这个动作本身没有副作用。

        🔴 有意 **不接 `query` / `expand_reason`**：`local` 档结构上要求 thread / 干系人硬锚，
        关键词只能加分、不能独自把一封邮件拉进来（见 `_email_resource_candidates` 注释）。
        用户在弹窗里输入的关键词走的是另一条路 —— 前端的全局邮件搜索（FTS5），那条路本来就
        是「用户明说要搜什么」，不需要也不应该借用 agent 侧的 expansion 声明。
        """
        limit = max(1, min(int(limit), RESOURCE_DISCOVERY_MAX_CANDIDATES))
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            candidates, local_count, _expanded = self._email_resource_candidates(
                conn, matter, query=None, expand_reason=None, limit=limit
            )
            return {"items": candidates, "local_candidate_count": local_count}

    def list_resource_attachments(
        self, public_id: str, *, limit: int = MATTER_RESOURCE_ATTACHMENT_LIMIT
    ) -> dict[str, Any]:
        """本事项**已关联邮件**里的附件（G-14 tab ③，Q5 裁定范围：只引用、不做独立上传）。

        🔴 一条 SQL 拿全部 —— 逐封 `attachment/list/{internal_id}` 扇出在挂了几十封邮件的
        事项上就是几十个请求（ARCHITECTURE §7.1 列表性能铁律）。
        🔴 `is_inline=0`：正文里的 cid 图片不是「资料」，摆出来只会淹没真附件。
        """
        limit = max(1, min(int(limit), MATTER_RESOURCE_ATTACHMENT_LIMIT))
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            linked_keys = {
                row["external_key"]
                for row in conn.execute(
                    "SELECT r.external_key FROM matter_resource mr "
                    "JOIN resource r ON r.id=mr.resource_id "
                    "WHERE mr.matter_id=? AND mr.deleted_at IS NULL AND r.provider=? AND r.kind='file'",
                    (matter["id"], EMAIL_PROVIDER),
                ).fetchall()
            }
            rows = conn.execute(
                "SELECT a.id AS attachment_id, a.internal_id, a.filename, a.content_type, "
                "a.size_bytes, m.subject AS email_subject, m.sender AS email_sender, "
                "m.date_received AS email_date "
                "FROM matter_resource mr "
                "JOIN resource r ON r.id=mr.resource_id "
                "JOIN email_metadata m ON m.internal_id = CAST(substr(r.external_key, 7) AS INTEGER) "
                "JOIN email_attachment a ON a.internal_id = m.internal_id "
                "WHERE mr.matter_id=? AND mr.deleted_at IS NULL AND r.provider=? "
                "AND r.kind='email' AND COALESCE(a.is_inline,0)=0 "
                "ORDER BY m.date_received DESC, a.id LIMIT ?",
                (matter["id"], EMAIL_PROVIDER, limit),
            ).fetchall()
            items = []
            for row in rows:
                item = dict(row)
                item["external_key"] = attachment_resource_key(int(row["attachment_id"]))
                item["linked"] = item["external_key"] in linked_keys
                items.append(item)
            return {"items": items}

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
            resource = self.repository.get_resource(conn, resource_id) or {}
            if not self._cas_update(
                conn,
                matter["id"],
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                scope=scope_from_resources([resource_id]),
            ):
                raise self._version_conflict()
            conn.execute("UPDATE matter_resource SET deleted_at=?, updated_at=? WHERE id=?", (now if deleted else None, now, link["id"]))
            event_id = self._append_event(
                conn, matter_id=matter["id"], kind=event_kind, actor=actor, source=source,
                dedupe_key=dedupe_key, reason=reason, resource_id=resource_id,
                payload={
                    "link_id": link["id"],
                    "title": truncated_text(resource.get("title")),
                    "resource_kind": resource.get("kind"),
                },
                happened_at=now,
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

    # ---- W-C 全局干系人库（dogfood 轮 2）----------------------------------
    # 基本信息（姓名/邮箱/组织）全局一份（matter_contact，身份 = 归一 email）；
    # 角色/等待/备注仍归各事项的 matter_stakeholder 行。库是**隐式维护**的：
    # 添加/编辑干系人与邮件提取入池时 upsert，没有独立 CRUD 控制台（backlog）。

    #: 一键邮件提取的扫描窗口（最近 N 封）。提取语义是「近期往来的人」，
    #: 全库扫描既慢又会把几年前的一次性地址灌进候选。
    CONTACT_SCAN_WINDOW = 3000

    def list_contacts(self, *, query: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        """全局干系人库 + 聚合列（关联事项数 / 最近联系）。

        🔴 聚合一次 LEFT JOIN 算完，绝不逐 contact 查（列表性能铁律，
        `frontend/ARCHITECTURE.md` §7.1-7.2 的后端镜像）。排序 = 关联事项数
        降序（近似"往来密度"，真实往来封数只在邮件提取端点里算——那份要扫
        email_metadata，不该为每次开 Picker 都付一遍）。"""
        sql = (
            "SELECT c.id, c.email_normalized, c.display_name, c.organization, "
            "c.created_at, c.updated_at, "
            "COUNT(DISTINCT CASE WHEN ms.deleted_at IS NULL THEN ms.matter_id END) AS matter_count, "
            "MAX(CASE WHEN ms.deleted_at IS NULL THEN ms.last_contact_at END) AS last_contact_at "
            "FROM matter_contact c "
            "LEFT JOIN matter_stakeholder ms ON ms.contact_id = c.id "
        )
        params: list[Any] = []
        needle = str(query or "").strip().lower()
        if needle:
            like = f"%{needle}%"
            sql += (
                "WHERE (c.email_normalized LIKE ? "
                "OR lower(COALESCE(c.display_name, '')) LIKE ? "
                "OR lower(COALESCE(c.organization, '')) LIKE ?) "
            )
            params += [like, like, like]
        sql += "GROUP BY c.id ORDER BY matter_count DESC, c.updated_at DESC, c.id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        with self.repository.connect() as conn:
            return [dict(row) for row in conn.execute(sql, params)]

    def extract_contact_candidates(
        self, *, query: str | None = None, limit: int = 120,
        exclude_emails: Sequence[str] = (),
    ) -> list[dict[str, Any]]:
        """一键从邮件往来提取干系人候选（确定性扫描，🔴 不走 LLM）。

        扫 `email_metadata` 最近 `CONTACT_SCAN_WINDOW` 封的
        sender/sender_name/to_addr/cc_addr（🔴 列名以该表实际 DDL 为准 ——
        是 `sender_name` 不是 `from_name`），按归一 email 聚合：往来封数、
        最近出现时间、显示名取最近一次非空。已在全局库的带 `contact_id`。
        `exclude_emails` 给 owner 自己的地址用（自己不是自己的干系人，且
        它会以近乎全量的频次霸榜）。"""
        needle = str(query or "").strip().lower()
        excluded = {str(value).strip().lower() for value in exclude_emails if value}
        with self.repository.connect() as conn:
            rows = conn.execute(
                "SELECT sender, sender_name, to_addr, cc_addr, date_received "
                "FROM email_metadata "
                "WHERE sender IS NOT NULL OR to_addr IS NOT NULL OR cc_addr IS NOT NULL "
                "ORDER BY date_received DESC LIMIT ?",
                (self.CONTACT_SCAN_WINDOW,),
            ).fetchall()
            contact_ids = {
                row["email_normalized"]: int(row["id"])
                for row in conn.execute("SELECT id, email_normalized FROM matter_contact")
            }
        stats: dict[str, dict[str, Any]] = {}
        for row in rows:
            seen_at = self._parse_email_timestamp(row["date_received"])
            people: list[tuple[str, str]] = [(row["sender_name"] or "", row["sender"] or "")]
            for column in ("to_addr", "cc_addr"):
                raw = row[column]
                if raw:
                    people.extend(getaddresses([str(raw)]))
            for name, address in people:
                email = str(address or "").strip().lower()
                if not _CONTACT_EMAIL_RE.match(email) or email in excluded:
                    continue
                entry = stats.setdefault(email, {
                    "email": email, "display_name": None,
                    "mail_count": 0, "last_seen_at": None,
                })
                entry["mail_count"] += 1
                # 行按 date_received 降序扫 ⇒ 第一个非空名字就是最近用的那个。
                if name and not entry["display_name"]:
                    entry["display_name"] = str(name).strip() or None
                if seen_at is not None and (
                    entry["last_seen_at"] is None or seen_at > entry["last_seen_at"]
                ):
                    entry["last_seen_at"] = seen_at
        candidates = [
            {**entry, "contact_id": contact_ids.get(entry["email"])}
            for entry in stats.values()
            if not needle
            or needle in entry["email"]
            or needle in str(entry["display_name"] or "").lower()
        ]
        candidates.sort(
            key=lambda entry: (-entry["mail_count"], -(entry["last_seen_at"] or 0), entry["email"])
        )
        return candidates[: max(1, min(int(limit), 300))]

    @staticmethod
    def _parse_email_timestamp(raw: Any) -> int | None:
        """`email_metadata.date_received`（ISO TEXT）→ epoch ms；解析不动就 None。"""
        if not raw:
            return None
        try:
            return int(datetime.fromisoformat(str(raw)).timestamp() * 1000)
        except (TypeError, ValueError):
            return None

    def _upsert_contact(
        self, conn: sqlite3.Connection, *, email: str,
        display_name: str | None = None, organization: str | None = None, now: int,
    ) -> int:
        """按归一 email upsert 全局联系人，返回 contact_id。

        提供的非空姓名/组织 = 最后写者赢（全局一份的语义：改名就是全局改名）；
        传 None = 不动既有值。"""
        conn.execute(
            "INSERT INTO matter_contact "
            "(email_normalized, display_name, organization, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(email_normalized) DO UPDATE SET "
            "display_name = COALESCE(excluded.display_name, matter_contact.display_name), "
            "organization = COALESCE(excluded.organization, matter_contact.organization), "
            "updated_at = excluded.updated_at",
            (email, display_name, organization, now, now),
        )
        row = conn.execute(
            "SELECT id FROM matter_contact WHERE email_normalized=?", (email,)
        ).fetchone()
        return int(row["id"])

    def _propagate_contact_identity(
        self, conn: sqlite3.Connection, contact_id: int, *, now: int,
        exclude_stakeholder_id: int,
        display_name: str | None = None, organization: str | None = None,
    ) -> None:
        """把姓名/组织写穿到该联系人的其它事项行（denormalized 镜像随全局一份走）。

        🔴 只动 stakeholder 行 + 受影响事项的搜索投影；**不** bump 那些事项的
        aggregate version、不发事件 —— 这是联系人层面的事实变更，不是那些事项
        自己的业务动作，把别的事项的乐观锁撞掉才是 bug。"""
        sets: list[str] = []
        params: list[Any] = []
        if display_name is not None:
            sets.append("display_name=?")
            params.append(display_name)
        if organization is not None:
            sets.append("organization=?")
            params.append(organization)
        if not sets:
            return
        affected = [
            int(row["matter_id"])
            for row in conn.execute(
                "SELECT DISTINCT matter_id FROM matter_stakeholder "
                "WHERE contact_id=? AND id<>?",
                (contact_id, exclude_stakeholder_id),
            )
        ]
        if not affected:
            return
        conn.execute(
            f"UPDATE matter_stakeholder SET {', '.join(sets)}, updated_at=? "
            "WHERE contact_id=? AND id<>?",
            (*params, now, contact_id, exclude_stakeholder_id),
        )
        for matter_id in affected:
            self.refresh_search_projection(conn, matter_id)

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
            existing: dict[str, Any] | None = None
            if stakeholder_id is not None:
                row = conn.execute("SELECT * FROM matter_stakeholder WHERE id=? AND matter_id=?", (stakeholder_id, matter["id"])).fetchone()
                if not row:
                    raise MatterError("E_CHILD_NOT_FOUND", f"stakeholder {stakeholder_id} not found")
                existing = dict(row)
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
                # W-C 全局干系人库：有 email 才有全局身份。upsert 后把库里已知的
                # 姓名/组织回填进本行空位（从库里挑人时前端只需给 email），并把本次
                # 显式提供的姓名/组织写穿到该联系人的其它事项行（基本信息全局一份）。
                contact_id = None
                if email:
                    contact_id = self._upsert_contact(
                        conn, email=email,
                        display_name=values["display_name"],
                        organization=values["organization"], now=now,
                    )
                    contact = conn.execute(
                        "SELECT display_name, organization FROM matter_contact WHERE id=?",
                        (contact_id,),
                    ).fetchone()
                    values["display_name"] = values["display_name"] or contact["display_name"]
                    values["organization"] = values["organization"] or contact["organization"]
                values["contact_id"] = contact_id
                columns = tuple(values)
                cursor = conn.execute(f"INSERT INTO matter_stakeholder ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})", tuple(values[c] for c in columns))
                stakeholder_id = int(cursor.lastrowid)
                if contact_id is not None:
                    self._propagate_contact_identity(
                        conn, contact_id, now=now, exclude_stakeholder_id=stakeholder_id,
                        display_name=self._optional_text(data.get("display_name")),
                        organization=self._optional_text(data.get("organization")),
                    )
            else:
                allowed = {"display_name", "organization", "role", "relationship", "is_waiting_on", "last_contact_at", "source_resource_id", "deleted_at"}
                changes = {key: value for key, value in data.items() if key in allowed}
                if email is not None:
                    changes["email_normalized"] = email
                changes["updated_at"] = now
                # W-C：email 变更 → 重挂全局联系人；姓名/组织的显式修改写穿到全局
                # 一份 + 该联系人的其它事项行。角色/等待/备注仍只落本行。
                contact_id = existing.get("contact_id") if existing else None
                contact_email = email or (existing or {}).get("email_normalized")
                touched_name = self._optional_text(data.get("display_name")) if "display_name" in data else None
                touched_org = self._optional_text(data.get("organization")) if "organization" in data else None
                if contact_email and (email is not None or contact_id is None or touched_name or touched_org):
                    contact_id = self._upsert_contact(
                        conn, email=contact_email,
                        display_name=touched_name, organization=touched_org, now=now,
                    )
                    changes["contact_id"] = contact_id
                assignments = ", ".join(f"{key}=?" for key in changes)
                conn.execute(f"UPDATE matter_stakeholder SET {assignments} WHERE id=?", (*changes.values(), stakeholder_id))
                if contact_id is not None:
                    self._propagate_contact_identity(
                        conn, contact_id, now=now, exclude_stakeholder_id=stakeholder_id,
                        display_name=touched_name, organization=touched_org,
                    )
                if event_kind == "stakeholder_removed":
                    conn.execute(
                        "UPDATE matter_item SET waiting_on_stakeholder_id=NULL, updated_at=?, version=version+1 "
                        "WHERE matter_id=? AND waiting_on_stakeholder_id=?",
                        (now, matter["id"], stakeholder_id),
                    )
            if not self._cas_update(conn, matter["id"], expected_version, {"updated_at": now, "last_activity_at": now}):
                raise self._version_conflict()
            self.refresh_search_projection(conn, matter["id"])
            stakeholder = dict(conn.execute("SELECT * FROM matter_stakeholder WHERE id=?", (stakeholder_id,)).fetchone())
            event_id = self._append_event(
                conn, matter_id=matter["id"], kind=event_kind, actor=actor, source=source,
                dedupe_key=dedupe_key, reason=reason,
                payload={
                    "stakeholder_id": stakeholder_id,
                    # 名字 = 句子必需的标识；裸 stakeholder_id 写不出"把张三标成在等他"。
                    "display_name": truncated_text(stakeholder.get("display_name")),
                    "changes": build_changes(
                        data, existing, stakeholder, allowed=STAKEHOLDER_CHANGE_FIELDS
                    ),
                },
                happened_at=now,
                reverses_event_id=reverses_event_id,
            )
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

    def _relation_row(self, row: Any) -> dict[str, Any]:
        """关系行投影：在原始列之上**additive** 地补一个解析好的 `provenance`。

        `matter_relation` 只有 `provenance_json`(TEXT)，而资料链接行（`_resource_link_row`）
        早就把同名字段解析成 dict 交出去。两处形状不一致时，每个消费方都得自己记住
        「关系这一份要 JSON.parse」—— 于是这里统一。`provenance_json` **保留原样**，纯加键。
        """
        result = dict(row)
        raw = result.get("provenance_json")
        parsed: Any = {}
        if isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
            except (TypeError, ValueError):
                parsed = {}
        result["provenance"] = parsed if isinstance(parsed, dict) else {}
        return result

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
            return [self._relation_row(row) for row in conn.execute(
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
                result = self._mutation(source_matter, [], relation=self._relation_row(existing))
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
                conn, matter_id=source_matter["id"], kind=RELATION_ADDED, actor=actor,
                source=mutation["source"], dedupe_key=dedupe_key, reason=mutation.get("reason"),
                payload={
                    "relation_id": relation_id,
                    "target_public_id": target["public_id"],
                    "target_title": truncated_text(target.get("title")),
                },
                happened_at=now,
                reverses_event_id=mutation.get("reverses_event_id"),
            )
            after = self.repository.get_matter_by_id(conn, source_matter["id"])
            return self._mutation(
                after,
                [event_id],
                relation=self._relation_row(conn.execute("SELECT * FROM matter_relation WHERE id=?", (relation_id,)).fetchone()),
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
                relation=self._relation_row(conn.execute("SELECT * FROM matter_relation WHERE id=?", (relation_id,)).fetchone()),
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
        resource, _ = self._upsert_resource(conn, normalized, now)
        resource_id = int(resource["id"])
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
            self._mark_stale_proposals(
                conn,
                matter_id,
                int(expected_version) + 1,
                scope if scope is not None else SCOPE_EVERYTHING,
            )
        return ok

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

    def _resolve_source_resource(self, conn: sqlite3.Connection, source_spec: Any) -> dict[str, Any]:
        if not isinstance(source_spec, Mapping) or source_spec.get("provider") != EMAIL_PROVIDER or source_spec.get("kind") != "email":
            raise MatterError("E_INVALID_ARG", "source_resource must be a mailagent email")
        internal_id = int(source_spec.get("internal_id") or 0)
        row = conn.execute("SELECT internal_id,subject,thread_id,date_received,message_id,sender,to_addr,cc_addr FROM email_metadata WHERE internal_id=?", (internal_id,)).fetchone()
        if not row:
            raise MatterError("E_UPSTREAM", f"email {internal_id} not found")
        email_spec = {
            "provider": EMAIL_PROVIDER, "kind": "email", "external_key": email_resource_key(internal_id),
            "title": row["subject"],
            # 🔴 三个地址列是**干系人候选的唯一来源**（前端 `matterStakeholderCandidates.ts` 从
            # 这里推「本事项往来里出现过」）。此前只写 internal_id/message_id/date_received，
            # 于是那份候选列在生产上恒空 —— 行就在手上，多带三列零额外查询。
            "metadata": {
                "internal_id": internal_id,
                "message_id": row["message_id"],
                "date_received": row["date_received"],
                "sender": row["sender"],
                "to_addr": row["to_addr"],
                "cc_addr": row["cc_addr"],
            },
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
                    # 🔴 创始邮件是**用户亲手**从这封信建的事项 —— 与手动关联同语义，直接落
                    # 确认态（0812 owner 拍板）。此前硬编码 `None`，于是 `ResourceRow` 以
                    # `confirmed_at is null` 判「Agent 建议」，新建事项一打开，那封创始邮件就
                    # 带着「确认 / 忽略」两颗钮躺在资料列表里等用户确认自己刚做过的事。
                    # 时间戳取 `now`（与 link 的 created_at/updated_at 同一刻），镜像
                    # `add_resource` 里 `now if spec.get("confirmed") else None` 的写法。
                    "confidence": None, "provenance_json": "{}", "confirmed_at": now,
                    "sub_state": spec.get("sub_state", "none"), "created_at": now, "updated_at": now,
                })
                event_ids.append(self._append_event(
                    conn, matter_id=matter_id, kind=RESOURCE_LINKED, actor=actor,
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
        r"""文本 → 词集：拉丁 token（≥3 字符）+ 中文二元组。

        🔴 两处都**不跨分隔符拼串**（0812 修法 2c）：
        · 中文二元组按**段内**滑窗。旧实现把整份文档的中文字剥掉一切标点空格拼成一条长串
          再全滑窗，实测产出 `与工` / `作亮` 这类跨词边界的幽灵词，再靠它们去召回邮件。
        · 拉丁 token 取自**剔掉中文之后**的文本，并额外产出 `.`/`-` 切分的子词：`\w` 在
          re.UNICODE 下把中文也算词字符，于是 "反馈-ER706W-4G" 会被吞成一个 token，查
          `ER706W` 反而命中不了（邮件地址例外，整体才是一个锚，拆开只剩域名碎片）。
        再往下（消除词内边界噪音）要上分词器，那是另一笔体积账，本批不引依赖。
        """
        text = str(value or "").casefold()
        terms: set[str] = set()
        for token in re.findall(
            r"[\w@.-]+", re.sub(r"[\u3400-\u9fff]+", " ", text), flags=re.UNICODE
        ):
            if len(token) >= 3 and not token.isdigit():
                terms.add(token)
            if "@" in token:
                continue
            for part in re.split(r"[.-]+", token):
                if len(part) >= 3 and not part.isdigit():
                    terms.add(part)
        for segment in re.findall(r"[\u3400-\u9fff]+", text):
            terms.update(
                segment[index : index + 2] for index in range(max(0, len(segment) - 1))
            )
        return terms

    @staticmethod
    def _term_tier(term: str, df_count: int, doc_total: int) -> str:
        """一个词在**当前扫描窗口**里的稀有度档位（common / normal / rare / distinctive）。"""
        if df_count >= max(
            RESOURCE_TERM_COMMON_MIN_DOCS,
            doc_total * RESOURCE_TERM_COMMON_DF_RATIO,
        ):
            return "common"
        # 单命中特例只给拉丁 token（`_semantic_terms` 下它们恒 ≥3 字符，中文二元组恒 2）：
        # 「项目代号 / 专有名词一个就该关联上」说的是 Apollo、ER706W 这类，不是碰巧稀有的
        # 中文二元组 —— 后者靠相邻二元组一起命中（专有名词天然产出多个）才够分。
        if len(term) >= 3 and df_count <= max(
            RESOURCE_TERM_DISTINCTIVE_MIN_DOCS,
            doc_total * RESOURCE_TERM_DISTINCTIVE_DF_RATIO,
        ):
            return "distinctive"
        if df_count <= max(
            RESOURCE_TERM_RARE_MIN_DOCS, doc_total * RESOURCE_TERM_RARE_DF_RATIO
        ):
            return "rare"
        return "normal"

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
        # 🔴 召回词与加分词是**两个集合**（0812 修法 3）。旧实现把
        # `matter_text ∪ query` 整个当匹配词集，于是 agent 自己写进 summary/notes 的散文
        # 成了检索条件 —— 实测事项描述里一句「未见邮件记录」，把标题带「已撤回邮件」的
        # 撤回通知拉了进来。现在：
        #   · recall_terms（来自调用方声明的 query）决定**是否入选**；
        #   · boost_terms（来自事项文档）只**加分**，永远不能独自把一封邮件拉进来。
        # matter_instructions 是 owner 手写的「专属指令」（不是 agent 散文），所以
        # `expand_reason='matter_instructions'` 这一档把它并进召回源 —— 否则该档结构性失效。
        recall_source = str(query or "")
        if expand_reason == "matter_instructions":
            recall_source = " ".join(
                (recall_source, str(matter.get("matter_instructions") or ""))
            )
        recall_terms = self._semantic_terms(recall_source)
        boost_terms = self._semantic_terms(matter_text) - recall_terms
        rows = conn.execute(
            "SELECT internal_id,message_id,thread_id,subject,sender,sender_name,to_addr,cc_addr,"
            "date_received,snippet FROM email_metadata ORDER BY date_received DESC,internal_id DESC LIMIT ?",
            (RESOURCE_DISCOVERY_SCAN_LIMIT,),
        ).fetchall()
        # DF 语料 = 上面那批行本身，逐行的词集顺手缓存（旧实现每行算两遍：local 一遍、
        # expanded 再一遍）。全表扫描算词频是明令禁止的。
        row_terms: dict[int, set[str]] = {}
        document_frequency: dict[str, int] = {}
        for row in rows:
            terms = self._semantic_terms(
                " ".join(str(row[key] or "") for key in ("subject", "sender_name", "snippet"))
            )
            row_terms[int(row["internal_id"])] = terms
            for term in terms:
                document_frequency[term] = document_frequency.get(term, 0) + 1
        doc_total = len(rows)

        def term_tier(term: str) -> str:
            return self._term_tier(term, document_frequency.get(term, 0), doc_total)

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
                # 干系人是 durable 硬锚：单个命中就该压过 0.25 准入线（准入线的设计原意是
                # 「只靠关键词、没有 thread/stakeholder 硬锚的不许进」）。旧代码靠虚词堆出来的
                # 0.24 关键词分把它托过线，虚词分收紧后这里必须自己站得住。
                score += min(0.30, 0.20 + len(matched_people) * 0.05)
            email_terms = row_terms[int(row["internal_id"])]
            matched_recall = sorted(recall_terms & email_terms)
            matched_boost = sorted(boost_terms & email_terms)
            recall_weight = sum(
                RESOURCE_TERM_WEIGHTS[term_tier(term)] for term in matched_recall
            )
            keyword_recalled = recall_weight >= RESOURCE_KEYWORD_RECALL_MIN_WEIGHT
            matched_terms = matched_recall + [
                term for term in matched_boost if term not in matched_recall
            ]
            if matched_terms:
                evidence.extend(f"keyword:{term}" for term in matched_terms[:8])
            if recall_weight:
                # 权重 3（低频+普通 / 单个专有名词）落在 0.30，刚好在准入线之上；
                # 封顶 0.40，关键词永远压不过同线程锚（0.62）。
                score += min(0.40, 0.10 * recall_weight)
            boost_weight = sum(
                1 for term in matched_boost if term_tier(term) != "common"
            )
            if boost_weight:
                score += min(0.06, 0.02 * boost_weight)
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
                if not keyword_recalled and not matched_people:
                    return None
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
                    # 与 `_resolve_source_resource` 同款三列：建议被确认后这份 metadata 就是
                    # resource 行的 metadata，干系人候选从这里推人（上面那处有完整说明）。
                    # 扫描行本来就 SELECT 了这三列，零额外查询。
                    "sender": row["sender"],
                    "to_addr": row["to_addr"],
                    "cc_addr": row["cc_addr"],
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
            # 扫描行本身按 date_received DESC 排，sort 稳定 ⇒ 同分内部仍是「新的在前」。
            expanded.sort(key=lambda item: -item["confidence"])
            # 🔴 外扩结果按线程折叠，每线程只留分最高的一条（0812 修法 6）。候选池是 email
            # 粒度、thread_id 只用来加分从不折叠，实测活库里「原件 + 撤回通知 + 回复」三封
            # 同线程邮件各占一个名额，把 10 条配额吃掉三成。
            # local 有意不折叠：它的候选全部来自**已关联线程**，那条线程的每一封新邮件都是
            # 用户要的（"同线程还有 5 封新回复" 只报 1 封才是 bug）。
            folded: list[dict[str, Any]] = []
            seen_threads: set[str] = set()
            for candidate in expanded:
                thread_id = str(candidate["metadata"].get("thread_id") or "")
                if thread_id:
                    if thread_id in seen_threads:
                        continue
                    seen_threads.add(thread_id)
                folded.append(candidate)
            expanded = folded
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
            # 重命名/删除标签只改 tags_json —— 提案结构上碰不到标签，不作废任何提案。
            self._mark_stale_proposals(
                conn, matter_id, int(row.get("version") or 0) + 1, SCOPE_NOTHING
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
        expected_kind: str | tuple[str, ...],
        *,
        include_item: bool = False,
    ) -> dict[str, Any] | None:
        event = self.repository.find_event(conn, dedupe_key)
        if not event:
            return None
        expected = (
            (expected_kind,) if isinstance(expected_kind, str) else tuple(expected_kind)
        )
        if event["kind"] not in expected:
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
        # 🔴 `allow_nan=False` 是最终防线：Python 默认会把 NaN/Infinity 输出成**非标准**
        # JSON 字面量，本仓所有 *_json 列都带 `CHECK (json_valid(...))` ⇒ 写库当场失败，
        # 而此时业务更新往往已经做完 ⇒ **整笔事务回滚**，对外表现成 500 而不是参数错误。
        # 非有限浮点会从 `waiting_context` / `checklist` / 提案 change 的 `after` 这些
        # `dict[str, Any]` 口子进来（JSON 解析器默认就认这三个字面量）。
        try:
            return json.dumps(
                value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            )
        except ValueError as exc:
            raise MatterError(
                "E_INVALID_ARG", f"value is not JSON serializable: {exc}"
            ) from exc

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
