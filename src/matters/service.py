"""Transactional Matter aggregate service."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from typing import Any, Iterator, Mapping, Sequence

from loguru import logger

from src.events.publisher import safe_publish

from .event_changes import (
    MATTER_CHANGE_FIELDS,
    build_changes,
    build_narrative,
)
from .events import (
    AGENT_BINDING_CHANGED,
    MATTER_CREATED,
    MATTER_UPDATED,
)
from .models import (
    MATTER_ACTOR_KINDS,
    MATTER_HEALTH_VALUES,
    MATTER_PRIORITIES,
    MATTER_STATUSES,
    MatterActorKind,
    format_public_id,
    normalize_goal_checks,
    normalize_tags,
)
from .proposal_scope import scope_from_matter_columns
from .repository import MatterRepository
from .resource_identity import (  # noqa: F401
    MatterError,
    normalize_resource_key,
)
from .service_common import (  # noqa: F401
    ACTION_ONLY_ITEM_FIELDS,
    Actor,
    BINDING_PATCH_FIELDS,
    DIRECT_PATCH_FIELDS,
    MANUAL_UPDATE_FIELDS,
    MATTER_INSTRUCTIONS_MAX_CHARS,
    TRASH_RETENTION_MS,
    UNDOABLE_PATCH_FIELDS,
    proposal_change_count,
)
from .service_dispatch import (  # noqa: F401
    CANCELABLE_DISPATCH_STATES,
    CLOSED_ITEM_STATUSES,
    DEFAULT_LIVE_DISPATCH_STATES,
    MATTER_ITEM_RUN_JOB_TYPE,
    _MatterDispatchMixin,
)
from .service_items import _MatterItemMixin
from .service_progress import (  # noqa: F401
    PROGRESS_PATCH_FIELDS,
    _MatterProgressMixin,
)
from .service_resources import (  # noqa: F401
    MATTER_RESOURCE_ATTACHMENT_LIMIT,
    RESOURCE_DISCOVERY_MAX_CANDIDATES,
    RESOURCE_DISCOVERY_SCAN_LIMIT,
    RESOURCE_SUGGESTION_BACKLOG_CAP,
    RESOURCE_TERM_COMMON_DF_RATIO,
    RESOURCE_TERM_COMMON_MIN_DOCS,
    RESOURCE_TERM_DISTINCTIVE_DF_RATIO,
    RESOURCE_TERM_DISTINCTIVE_MIN_DOCS,
    RESOURCE_TERM_RARE_DF_RATIO,
    RESOURCE_TERM_RARE_MIN_DOCS,
    _MatterResourceMixin,
)
from .service_stakeholders import _MatterStakeholderMixin
from .service_tags import _MatterTagMixin
from .service_updates import _MatterUpdateMixin
from .url_fetch import fetch_readable_url

# D5 bounded projection: context_snapshot resource entries only pass through the
# short structured metadata keys the MailAgent write side actually produces
# (_resolve_source_resource: email -> internal_id/message_id/date_received,
# thread -> thread_id). Free-text keys (cached_excerpt / excerpt / text_excerpt /
# snippet / body ...) are the *source* of the truncated `excerpt` field and must
# never ride out untruncated through metadata — whitelist, 宁缺勿滥.
SNAPSHOT_METADATA_KEYS = ("internal_id", "message_id", "thread_id", "date_received")
#: 快照里带几条 curated 进展、每条正文截多长（task 08-25）。10 条 = 一件事最近的脉络，
#: 再多就变成让模型重读整本流水账；正文 500 字够说清一件事，要全文的走
#: `matter_get include=["progress"]`。
SNAPSHOT_PROGRESS_LIMIT = 10
SNAPSHOT_PROGRESS_BODY_CHARS = 500

#: 本次事务里被改动过的事项 public_id。**提交成功后**才由 `_transaction()` flush 成
#: `matter.changed` SSE —— 在事务里发等于「事件先到、DB 后提交」, 前端 refetch 会读到旧值,
#: 症状与修之前一模一样、只是更难查。
#: 用 ContextVar 而不是实例属性: 同一个 MatterService 会被并发请求共用 (serve-api 是
#: 多 worker 的), 实例属性会让两个请求互相把对方的待发集合冲掉。
_pending_changed: ContextVar[set[str] | None] = ContextVar(
    "matter_pending_changed", default=None
)


class MatterService(
    _MatterItemMixin,
    _MatterDispatchMixin,
    _MatterProgressMixin,
    _MatterResourceMixin,
    _MatterStakeholderMixin,
    _MatterUpdateMixin,
    _MatterTagMixin,
):
    """Facade composing domain mixins over transactional Matter persistence."""

    def __init__(
        self,
        repository: MatterRepository,
        *,
        clock_ms=None,
        url_fetcher=None,
        job_repo=None,
    ):
        self.repository = repository
        self.clock_ms = clock_ms or (lambda: int(time.time() * 1000))
        self.url_fetcher = url_fetcher or fetch_readable_url
        #: async_jobs 写面（行动项派发要 enqueue `matter_item_run`）。惰性建：绝大多数
        #: MatterService 实例一辈子不派发一次，没必要为它多开一个 repository。
        #: `MatterRunService` 在 super() 之后覆写成自己那份 —— 一个进程一个就够。
        self.job_repo = job_repo

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        """事项域**唯一**的写事务出口 —— 提交后把本次改动的事项广播成 `matter.changed`。

        🔴 `src/matters/` 里不许再直接用 `repository.transaction()`
        (闸: `tests/matters/test_transaction_gate.py`)。漏一处 = 那条写路径静默不刷新,
        而且不会有任何测试变红 —— 这正是 2026-08-18 那批 bug 的复发形态。

        嵌套安全: 只有最外层负责 flush。当前没有嵌套调用, 但 run_service 的写会调
        service 的方法, 未来出现嵌套时不会退化成「发两遍」或「内层提交就发、外层却回滚了」。
        """
        outer = _pending_changed.get()
        token = _pending_changed.set(set()) if outer is None else None
        try:
            with self.repository.transaction() as conn:
                yield conn
            if token is not None:
                self._flush_changed(_pending_changed.get() or set())
        finally:
            if token is not None:
                _pending_changed.reset(token)

    @staticmethod
    def _flush_changed(public_ids: set[str]) -> None:
        """把提交后的事项变更广播出去。绝不抛 —— 通知失败不该让已提交的写看起来失败了。

        payload 只有 `public_id`, 不带 kind 也不带业务数据:
        - 只发 public_id 是因为前端缓存键用的就是它。`matter.attention` 当年发内部数字
          `matter.id`, 前端对不上, 只能退化成「按形状全量失效」
          (`useEventBridge.ts` 那处注释就是这个妥协的墓志铭)。
        - 不带业务数据是因为这条总线是 lossy 的: 事件只能当 invalidation hint,
          真数据永远来自前端随后的 refetch。
        - 不带 kind 是因为前端拿到 kind 也只会做同一件事 (失效该事项的全部子缓存);
          带上只会诱使将来有人按 kind 做「精细失效」, 那正是漏刷的来源。

        🔴 **不传 `source=`**: 跟随 `worker.py` 发 `matter.attention` 的既有形态 (那里也没传),
        且 `src/matters/*.py` 里任何 `source="字面量"` 都会被时间线的 i18n 一致性闸
        (`frontend/tests/shared/matterTimelineModel.test.ts`) 抽走、要求配一个事件来源标签
        —— 那个闸抽的是 **matter_event 的 source**, 与 SSE 事件的 source 是两回事。
        """
        for public_id in sorted(public_ids):
            try:
                safe_publish("matter.changed", data={"public_id": public_id})
            except Exception as e:  # pragma: no cover — safe_publish 自己已经 swallow
                logger.debug(f"[matters] matter.changed publish swallowed: {e}")

    @staticmethod
    def _safe_publish(event_type: str, **kwargs: Any) -> None:
        safe_publish(event_type, **kwargs)

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
        # 完成标志（0813 轮 3 O2）：创建面开放 —— D7 的 user-only 只钉 **update** 路径
        # （patch_matter 的 actor 闸不动），create 时 agent 把「怎样算做完」一起立起来
        # 与背景 / 目标同权限同语义。
        try:
            goal_checks = normalize_goal_checks(data.get("goal_checks"))
        except ValueError as exc:
            raise MatterError("E_INVALID_ARG", str(exc)) from exc
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
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
                    "background": str(data.get("background") or ""),
                    "goal": str(data.get("goal") or ""),
                    "matter_type": self._optional_text(data.get("matter_type")),
                    "tags_json": self._dump(tags),
                    "goal_checks_json": self._dump(list(goal_checks)),
                    "status": status,
                    "health": health,
                    "priority": priority,
                    "owner_id": actor.actor_id,
                    "source": source or "desktop_ui",
                    "due_at": self._require_epoch_ms("due_at", data.get("due_at")),
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
            if "progress" in include_set:
                # curated 进展（task 08-25）。软删的不带出来 —— 它与 `items` 的
                # `include_deleted=True` 不同源：item 的删除态在清单里还要渲染成划掉的行，
                # 进展被删就是从脉络里拿掉了。
                result["progress"] = self.repository.list_progress(
                    conn, matter["id"]
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
            if "followup" in include_set:
                # task 08-14：跟进配置的**结构化**读面。此前只能从 matter 行里读到
                # `schedule_json` 的原始字符串 —— 能看但对模型不友好，也无从逐条引用 id。
                from .followup_config import followup_view

                result["followup"] = followup_view(matter)
            return result

    def mutate_followup(
        self,
        public_id: str,
        operation: str,
        payload: Mapping[str, Any],
        *,
        expected_version: int,
        idempotency_key: str,
        source: str,
        actor: Actor = Actor(),
        reason: str | None = None,
    ) -> dict[str, Any]:
        """跟进配置的**逐条**编辑（task 08-14）→ 折成 binding patch 走 `patch_matter`。

        🔴 读-改-写的原子性靠调用方给的 `expected_version`：先核对「我读到的这一版就是你看到
        的那一版」，不符直接冲突退回。少了这一步，模型基于旧快照算出的 triggers 列表会覆盖掉
        中间别人加的那条 —— 而这正是逐条口要避免的那种静默丢失。
        """
        from .followup_config import apply_followup_operation
        from .triggers import TriggerError

        with self.repository.connect() as conn:
            matter = self.repository.get_matter(conn, public_id)
            if not matter:
                raise MatterError("E_MATTER_NOT_FOUND", f"matter {public_id} not found")
        if int(matter["version"]) != int(expected_version):
            raise self._version_conflict()
        try:
            patch = apply_followup_operation(matter, operation, payload)
        except TriggerError as exc:
            raise MatterError("E_INVALID_ARG", str(exc)) from exc
        return self.patch_matter(
            public_id,
            patch,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
            source=source,
            actor=actor,
            reason=reason,
        )

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
                    for key in ("title", "background", "goal", "current_summary")
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
        task 08-25：连「本地那一趟」也没了 —— `run_spec` 起跑时**不再**做任何确定性资料扫描
        （关键词命中式推荐整条退役）。候选引擎只剩只读候选弹窗一个调用面。
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
                "background",
                "goal",
                # goal_checks（0813 轮 3 O2）：跟进 run 与事项对话必须看得见「怎样算做完」——
                # 没有它，「判断有没有实质进展」缺了唯一的完成判据。只读投影，不触碰 D7。
                "goal_checks",
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

            # curated 进展（task 08-25）：跟进 run 与事项对话共用的「这件事到哪一步了」。
            # 🔴 正文截断到 500 字：快照是有界投影，一条 4000 字的进展能把整段挤爆；要读全文
            # 的模型有 matter_get include=["progress"]。
            # 🔴 `refs`（证据链）有意不进快照：它是给人点开验证用的 UI 载荷，模型拿到一串
            # resource_id / URL 只会当成可引用的来源转手抄进提案 —— 而提案的 sources 有服务端
            # 独立校验，抄来的引用会被整条丢弃。
            progress_rows = conn.execute(
                "SELECT kind,title,body,happened_at,actor_kind FROM matter_progress "
                "WHERE matter_id=? AND deleted_at IS NULL "
                "ORDER BY happened_at DESC,id DESC LIMIT ?",
                (matter["id"], SNAPSHOT_PROGRESS_LIMIT),
            ).fetchall()
            progress = [
                {
                    **dict(row),
                    "body": (
                        str(row["body"])[:SNAPSHOT_PROGRESS_BODY_CHARS]
                        if row["body"]
                        else None
                    ),
                }
                for row in progress_rows
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
                "progress": progress,
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
        # D7：背景、目标、它们的完成标志都是**用户写的**，Agent 只能建议不能落库。
        # 「让 Agent 改写」走的是"产出建议文本 → 落进用户的编辑框待确认"，不是直接写。
        for user_only in ("background", "goal", "goal_checks"):
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
        with self._transaction() as conn:
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
                elif field in ("due_at", "next_attention_at"):
                    value = self._require_epoch_ms(field, value)
                elif field == "tags":
                    field = "tags_json"
                    value = self._dump(normalize_tags(value))
                elif field == "goal_checks":
                    # D5 完成标志。与背景 / 目标同权限（`_require_user_actor` 在下面
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
                # 改 title/tags 这类提案碰不到的字段 → 不作废任何提案；
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
                plain_changes = build_changes(
                    plain_fields, matter, after, allowed=MATTER_CHANGE_FIELDS
                )
                # 叙述正文只跟着 `current_summary` 走，判据是**它真的变了**（`changes`
                # 里有这一条）——「摘要原样重写一遍」不产出 change，也就不该在时间线上
                # 多出一段正文。
                summary_rewritten = any(
                    entry["field"] == "current_summary" for entry in plain_changes
                )
                event_id = self._append_event(
                    conn,
                    matter_id=matter["id"],
                    kind=MATTER_UPDATED,
                    actor=actor,
                    source=source,
                    dedupe_key=dedupe_key,
                    reason=reason,
                    update_id=update_id,
                    payload=self._with_narrative(
                        {"fields": plain_fields, "changes": plain_changes},
                        (after or {}).get("current_summary")
                        if summary_rewritten
                        else None,
                    ),
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
                if field in UNDOABLE_PATCH_FIELDS
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
        with self._transaction() as conn:
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
            try:
                conn.execute(
                    "DELETE FROM sync_state WHERE key=?",
                    (self._version_scope_state_key(int(matter["id"])),),
                )
            except sqlite3.OperationalError:
                pass  # 账本是可丢簿记；孤儿键无害，删除失败不阻断
            return {"deleted": True, "public_id": public_id}

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
        with self._transaction() as conn:
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

    @staticmethod
    def _with_narrative(payload: dict[str, Any], text: Any) -> dict[str, Any]:
        """给**叙述类**事件的 payload 挂上正文摘录（`narrative` 键；见 event_changes 模块）。

        写不出正文（None / 空串 / 非字符串）时原样返回 —— 键**不出现**，前端按存量老行
        的路径退化成原来的短句。三个调用点就是全部的叙述类事件，别在别处顺手调它：
        「不是所有事件都要长文」是这次改动的判据，不是省下来的工作量。
        """
        narrative = build_narrative(text)
        if narrative is not None:
            payload["narrative"] = narrative
        return payload

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
        # 登记「这个事项变了」, 由 `_transaction()` 在**提交后**广播 (S1)。
        # 判据是「真的落了一条 matter_event」而不是「调了一个写方法」—— 幂等重放
        # (`_replay`) 不落新事件 ⇒ 不发事件 ⇒ 前端不做无谓 refetch。这个语义是免费送的。
        pending = _pending_changed.get()
        if pending is not None:
            public_id = self.repository.public_id_of(conn, matter_id)
            if public_id:
                pending.add(public_id)
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
        include_progress: bool = False,
        include_dispatch: bool = False,
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
        if include_progress:
            # 🔴 进展没有 `matter_event` 上的外键列（item / resource / update 那三根是
            # P3 就定好的形状，为进展再加一列要重建整张事件表）—— 重放要还原哪一条，
            # 判据是事件 payload 里的 `progress_id`。
            progress_id = (event.get("payload") or {}).get("progress_id")
            if isinstance(progress_id, int) and not isinstance(progress_id, bool):
                extra["progress"] = self.repository.get_progress(
                    conn, event["matter_id"], progress_id
                )
        if include_dispatch:
            # 派发行同样没有 `matter_event` 上的外键列（那三根是 P3 定死的形状），
            # 重放要还原哪一次派发同样只能看 payload 里的 `dispatch_id`。
            dispatch_id = (event.get("payload") or {}).get("dispatch_id")
            if isinstance(dispatch_id, int) and not isinstance(dispatch_id, bool):
                extra["dispatch"] = self.repository.get_dispatch(
                    conn, dispatch_id, matter_id=event["matter_id"]
                )
        return self._mutation(matter, [event["id"]], **extra)

    def _require_matter(
        self, conn: sqlite3.Connection, public_id: str
    ) -> dict[str, Any]:
        matter = self.repository.get_matter(conn, public_id)
        if not matter:
            raise MatterError("E_MATTER_NOT_FOUND", f"matter {public_id} not found")
        return matter

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

    #: 时间戳字段（due_at/completed_at/last_contact_at/next_attention_at）的合法毫秒区间。
    #: 下界 10^12 ≈ 2001-09 —— 比它小的值几乎必然是 epoch **秒**（0813 A3 实证：agent 把
    #: 2026 年的截止日期写成 1786895999，被全链按毫秒解释成 1970-01-21）；上界 10^15
    #: ≈ 33658 年，挡微秒。有效期内（2001..33658）的真实日期不受影响。
    EPOCH_MS_MIN = 10**12
    EPOCH_MS_MAX = 10**15

    @classmethod
    def _require_epoch_ms(cls, field: str, value: Any) -> int | None:
        """校验并返回 epoch 毫秒时间戳；None 原样放行。单位错给出可自纠的错误信息。"""
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise MatterError(
                "E_INVALID_ARG", f"{field} must be an integer epoch-milliseconds timestamp"
            )
        try:
            number = int(value)
        except (OverflowError, ValueError) as exc:  # float('inf') / float('nan')
            raise MatterError(
                "E_INVALID_ARG", f"{field} must be an integer epoch-milliseconds timestamp"
            ) from exc
        if number != value:
            raise MatterError(
                "E_INVALID_ARG", f"{field} must be an integer epoch-milliseconds timestamp"
            )
        if not (cls.EPOCH_MS_MIN <= number < cls.EPOCH_MS_MAX):
            raise MatterError(
                "E_INVALID_ARG",
                f"{field} must be epoch MILLISECONDS (13 digits for current dates, "
                f"e.g. 1786690800000); got {number}"
                + (
                    " which looks like epoch seconds — multiply by 1000"
                    if 10**9 <= number < 10**12
                    else ""
                ),
            )
        return number

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
