"""Transactional Matter aggregate service."""

from __future__ import annotations

import json
import re
import sqlite3
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Iterator, Mapping, Sequence

from loguru import logger

from src.contacts.service import upsert_contact_for_email
from src.events.publisher import safe_publish

from .models import (
    MATTER_ACTOR_KINDS,
    MATTER_HEALTH_VALUES,
    MATTER_ITEM_BUILTIN_EXECUTOR,
    MATTER_ITEM_DISPATCH_ANSWER_MAX_CHARS,
    MATTER_ITEM_DISPATCH_DEFAULT_PROFILE,
    MATTER_ITEM_DISPATCH_STATES,
    MATTER_ITEM_EXEC_PROFILES,
    MATTER_ITEM_EXECUTOR_AGENT,
    MATTER_ITEM_KINDS,
    MATTER_ITEM_STATUSES,
    MATTER_PRIORITIES,
    MATTER_PROGRESS_BODY_MAX_CHARS,
    MATTER_PROGRESS_KINDS,
    MATTER_PROGRESS_TITLE_MAX_CHARS,
    MATTER_TAG_COLORS,
    MATTER_TAG_DEFAULT_COLOR,
    MATTER_TAG_DEFAULT_SHAPE,
    MATTER_TAG_SHAPES,
    MATTER_ACCESS_POLICIES,
    MATTER_RELATION_TYPES,
    MATTER_RESOURCE_KINDS,
    MATTER_RESOURCE_SUBSCRIPTION_STATES,
    MATTER_RESOURCE_SUMMARY_MAX_CHARS,
    MATTER_RESOURCE_SUMMARY_SOURCES,
    MATTER_STATUSES,
    MATTER_STAKEHOLDER_DEFAULT_TIER,
    MATTER_STAKEHOLDER_TIERS,
    MATTER_SUGGESTION_BULK_ACTIONS,
    MATTER_SUGGESTION_BULK_MAX,
    MATTER_UPDATE_REVIEW_STATUSES,
    MatterActorKind,
    MatterItemDispatchState,
    MatterItemKind,
    MatterResourceSummarySource,
    MatterSuggestionBulkAction,
    MatterSuggestionBulkSkipReason,
    format_public_id,
    normalize_goal_checks,
    normalize_progress_refs,
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
    scope_from_payload,
    scope_from_progress,
    scope_from_relations,
    scope_from_resources,
    scope_from_stakeholders,
    scope_to_payload,
)
from .repository import MatterRepository
from .resource_identity import (
    EMAIL_PROVIDER,
    MatterError,
    attachment_resource_key,
    event_resource_key,
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
    build_narrative,
    truncated_text,
)
from .events import (
    AGENT_BINDING_CHANGED,
    ITEM_CREATED,
    ITEM_DISPATCH_ANSWERED,
    ITEM_DISPATCH_CANCELED,
    ITEM_DISPATCH_DELIVERED,
    ITEM_DISPATCH_FAILED,
    ITEM_DISPATCH_SETTLED,
    ITEM_DISPATCHED,
    MATTER_CREATED,
    MATTER_UPDATED,
    PROGRESS_ADDED,
    PROGRESS_REMOVED,
    PROGRESS_RESTORED,
    PROGRESS_UPDATED,
    RELATION_ADDED,
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
    # 执行档只对行动项有意义（只有它派得出去）。🔴 这条约束**在这里判**而不是进表级
    # CHECK：那条 CHECK 改不动（SQLite 要重建整张表），列名单只能保持原样。
    "exec_profile",
}
MANUAL_UPDATE_FIELDS = {"status", "health", "current_summary"}
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
# 进展条目的可编辑字段（task 08-25）。撤销的前像只快照这些 —— `deleted_at` 有意不在内：
# 删除 / 恢复的反向操作是另一颗按钮（operation restore / delete），不是 patch 回一个时间戳。
PROGRESS_PATCH_FIELDS = {"kind", "title", "body", "happened_at", "refs"}
# P4 绑定三键（D2）：走既有 PATCH 白名单 + 事件 agent_binding_changed；
# schedule_json P5 才有写面（本相位零消费，不进白名单）。
BINDING_PATCH_FIELDS = {
    "agent_profile_id", "agent_enabled", "matter_instructions", "schedule_json",
}
MATTER_INSTRUCTIONS_MAX_CHARS = 4000
DIRECT_PATCH_FIELDS = {
    "title",
    # v61：背景与目标是**两个独立字段**（列同名）。合存单字段靠 `## 背景` / `## 目标`
    # 小标题分段的老方案已推翻 —— 解析的异常面（读态 / 编辑态 / 保存 / 导出 / Agent 写
    # 五处得同意同一套正则）比多一列贵。
    "background",
    "goal",
    "matter_type",
    "priority",
    "tags",
    "goal_checks",
    "due_at",
    "waiting_context",
    "next_attention_at",
    "attention_reason",
}
# 「撤销事项更新」的前像要快照哪些字段（patch_matter 的 undo descriptor）。
# 🔴 **从写面派生，不再手抄**：这里曾是同一份白名单的第四份手抄，且漏了 priority 与
# goal_checks —— 于是只改优先级时前像是 `{}`，撤销发出一个空 patch：不报错、版本照 bump、
# 值一动不动，用户看到的是「撤销成功」而实际什么都没还原。前像的每个字段都会经
# `PATCH /api/matters/{id}` 原样回放（renderer 直连 REST、user actor），所以取值范围必须
# 恰好是写面本身。
# BINDING_PATCH_FIELDS **有意**不在内（维持现状，本批不扩面）：纯 binding 的 patch 只写
# agent_binding_changed 一条事件，不产生 matter_updated，「撤销事项更新」这颗按钮不代表它；
# 混合 patch 里的 binding 部分同样不进前像。要不要让撤销覆盖 agent 绑定是独立决策。
UNDOABLE_PATCH_FIELDS = DIRECT_PATCH_FIELDS | MANUAL_UPDATE_FIELDS
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
RESOURCE_DISCOVERY_MAX_CANDIDATES = 50
RESOURCE_DISCOVERY_SCAN_LIMIT = 500
# 资料候选的词表纪律（0812 dogfood「拉了一堆无关信息」批）。三个档由**文档频率**（DF）划分，
# 语料 = 本次扫描窗口那批行本身（最近 RESOURCE_DISCOVERY_SCAN_LIMIT 封）：候选就是从这批
# 行里选的，用同一批行算词频恰好是「在这个池子里算不算稀有」的正解，而且零额外 I/O ——
# 🔴 绝不为算词频再全表扫一遍。
#   · common（虚词）：活库实测最近 500 封里 `邮件` 5.0% / `时间` 6.8% / `确认` 7.2% /
#     `项目` 8.0% / `omada` 26.8%（自家公司名）。这一档一分都不加。
#   · rare / distinctive / normal：非虚词，各加一点点分（封顶 0.06）。
# 小语料保护（MIN_DOCS）不可省：测试库/新装机器只有几封邮件时，纯比例会把每个词都判成
# 全域词，加分档整个失效。
# ⚠️ task 08-25：分档曾经还决定「关键词能不能**独自**把一封邮件召回」（权重表 + 准入权重），
# 那条链随关键词命中式推荐一起退役 —— 现在分档只影响加分，入选判据只有 durable 硬锚。
RESOURCE_TERM_COMMON_DF_RATIO = 0.05
RESOURCE_TERM_COMMON_MIN_DOCS = 5
RESOURCE_TERM_RARE_DF_RATIO = 0.01
RESOURCE_TERM_RARE_MIN_DOCS = 2
RESOURCE_TERM_DISTINCTIVE_DF_RATIO = 0.002
RESOURCE_TERM_DISTINCTIVE_MIN_DOCS = 1

# 一个事项挂着 10 条待审建议时不再堆新的：用户先处理完再说（0812 修法 6）。
RESOURCE_SUGGESTION_BACKLOG_CAP = 10

# 「关联资料」弹窗附件 tab 一次列多少条。纯展示上限，不是业务语义 —— 挂了几百封邮件的事项
# 把全部附件铺出来既慢又没人翻得完，用户要具体某一份可以从那封邮件本身进。
MATTER_RESOURCE_ATTACHMENT_LIMIT = 200


@dataclass(frozen=True)
class Actor:
    kind: str = MatterActorKind.USER.value
    actor_id: str | None = None


#: 本次事务里被改动过的事项 public_id。**提交成功后**才由 `_transaction()` flush 成
#: `matter.changed` SSE —— 在事务里发等于「事件先到、DB 后提交」, 前端 refetch 会读到旧值,
#: 症状与修之前一模一样、只是更难查。
#: 用 ContextVar 而不是实例属性: 同一个 MatterService 会被并发请求共用 (serve-api 是
#: 多 worker 的), 实例属性会让两个请求互相把对方的待发集合冲掉。
_pending_changed: ContextVar[set[str] | None] = ContextVar(
    "matter_pending_changed", default=None
)


class MatterService:
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
        with self._transaction() as conn:
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
        with self._transaction() as conn:
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
        with self._transaction() as conn:
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
            event_id = self._append_event(
                conn,
                matter_id=matter["id"],
                kind=ITEM_DISPATCHED,
                actor=actor,
                source=source,
                dedupe_key=dedupe_key,
                reason=reason,
                item_id=item_id,
                payload={
                    "dispatch_id": dispatch_id,
                    "title": truncated_text(item.get("title")),
                    "executor_id": executor,
                    "exec_profile": frozen_profile,
                    "attempt": 1,
                },
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
        self._enqueue_dispatch_job(public_id, matter["id"], result["dispatch"], attempt=1)
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
        self._enqueue_dispatch_job(
            public_id, matter["id"], result["dispatch"], attempt=attempt
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

    def _enqueue_dispatch_job(
        self,
        public_id: str,
        matter_id: int,
        dispatch: Mapping[str, Any],
        *,
        attempt: int,
    ) -> None:
        dispatch_id = int(dispatch["id"])
        try:
            job_id, _ = self._jobs().enqueue(
                job_type=MATTER_ITEM_RUN_JOB_TYPE,
                target_kind="matter_item",
                target_key=f"{public_id}:{dispatch['item_id']}",
                params={
                    "matter_id": int(matter_id),
                    "item_id": int(dispatch["item_id"]),
                    "dispatch_id": dispatch_id,
                    "attempt": int(attempt),
                },
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
            safe_publish(
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

    @staticmethod
    def _require_progress_body(value: Any) -> str | None:
        body = MatterService._optional_text(value)
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

    def list_resources(self, public_id: str, **filters: Any) -> list[dict[str, Any]]:
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            return [
                self._decorate_url_resource(item)
                for item in self.repository.list_resources(conn, matter["id"], filters)
            ]

    def list_resource_versions(
        self, public_id: str, resource_id: int, *, limit: int = 50
    ) -> dict[str, Any]:
        """资料的版本轨迹（v57，H3§5.4）：**只有历史**，当前版本是 resource 行自己。

        `tracks_versions` 由服务端给而不是让前端按 kind 自己推 —— 判据单源在
        `_resource_tracks_versions`，前端手抄一份 `kind === 'url'` 就是第二处真源。
        """
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            resource = self.repository.get_resource(conn, resource_id)
            link = self.repository.get_resource_link(
                conn, matter["id"], resource_id, live_only=True
            )
            if resource is None or link is None:
                raise MatterError("E_CHILD_NOT_FOUND", "linked resource not found")
            return {
                "tracks_versions": self._resource_tracks_versions(resource),
                "items": self.repository.list_resource_versions(
                    conn, resource_id, limit=limit
                ),
            }

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
        with self._transaction() as conn:
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
            # 版本轨迹留档（v57，H3§5.4）。🔴 必须在下面那条 UPDATE **之前**，收的是
            # 被覆盖前的那份 revision/content_hash 与摘要 —— 摘要是可覆盖的单值，
            # 覆盖即永久丢失，这正是轨迹存在的理由。
            #
            # 两个不留档的情形都是「没有上一版可存」而不是「懒得存」：
            #   · content_hash 为 None —— 这份资料从没检出过，本次是**首次**，首次不是
            #     变化（留一条空壳会把"只检出过一次"谎报成"有过一版"）；
            #   · hash 未变 —— 同一份内容重抓（force / 缓存过期复验），版本没动。
            # last_checked_at 照旧无条件刷新：它是「最后确认于」，不是版本变化。
            previous_hash = current.get("content_hash")
            if previous_hash is not None and previous_hash != fetched_hash:
                self.repository.archive_resource_version(conn, current, fetched_at)
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
        with self._transaction() as conn:
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
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 新关联的 resource：提案不可能已经引用它（propose 时它还没 link）。
                scope=scope_from_resources([int(resource["id"]) for resource, _ in pending]),
            )
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
        with self._transaction() as conn:
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
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 「接受/拒绝资料建议」「置顶」「订阅」都只动这一条 link —— owner 连点 12 次
                # 接受资料建议就把待审提案作废，正是这里没收窄导致的。
                scope=scope_from_resources([resource_id]),
            )
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
        with self._transaction() as conn:
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
        with self._transaction() as conn:
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

    # `discover_resource_suggestions` 已退役（task 08-25，owner 0825）：关键词命中式的
    # 资料推荐置信度太低，产出的 unconfirmed 建议只是给 owner 添审批负担。资料关联的推荐
    # 现在只有两条**都过 LLM 判断**的路：跟进 run 的提案信封 `resource` change，与事项
    # 对话里 agent 自己检索后 `matter_resource_mutate`。
    # 🔴 候选引擎 `_email_resource_candidates`、拒绝记忆、`reject_resource_suggestion` /
    # `bulk_resolve_resource_suggestions` 一个都没动 —— 只读候选（`list_resource_candidates`）
    # 与会议结束→出席者身份匹配的提案（`propose_calendar_event_resource`）仍在用它们。

    def propose_calendar_event_resource(
        self,
        public_id: str,
        *,
        ical_uid: str,
        title: str | None,
        recurrence_id: str | None,
        occurrence_start_ms: int | None,
        occurrence_end_ms: int | None,
        matched_emails: Sequence[str],
    ) -> dict[str, Any]:
        """会议结束 → event 资料关联**提案**（L4 批次 1 #3，agenda worker 的唯一写入口）。

        零自动写：产物恒是 ``confirmed_at IS NULL`` + ``added_by_kind='agent'`` 的
        unconfirmed link，owner 在既有资料建议面确认 / 拒绝。幂等与抑制沿用资料建议家族的
        既有机制：已有 live link 跳过、拒绝记忆同 fingerprint 抑制、
        ``RESOURCE_SUGGESTION_BACKLOG_CAP`` 原样。

        🔴 task 08-25 起这是**唯一**会写 unconfirmed link 的确定性路径 —— 判据是**身份
        锚定**（与会者 email → 干系人）不是关键词命中，所以它没跟着关键词推荐一起退役。

        evidence = ``stakeholder:<email>``（命中的与会者 = 干系人邮箱，durable 锚）。
        resource_key 是**系列级**（``event_resource_key`` 不含 recurrence_id）⇒ 拒一次
        管整个系列；换一批与会者命中 = 新 fingerprint，可再提。occurrence 细节只进
        provenance。
        """
        external_key = event_resource_key(ical_uid)
        evidence = [f"stakeholder:{email}" for email in matched_emails]
        now = self.clock_ms()
        with self._transaction() as conn:
            matter = self._require_matter(conn, public_id)
            backlog = int(
                conn.execute(
                    "SELECT COUNT(*) FROM matter_resource WHERE matter_id=? "
                    "AND deleted_at IS NULL AND confirmed_at IS NULL AND added_by_kind='agent'",
                    (matter["id"],),
                ).fetchone()[0]
            )
            if backlog >= RESOURCE_SUGGESTION_BACKLOG_CAP:
                return {"status": "backlog_capped"}
            canonical_key = rejection_resource_key(EMAIL_PROVIDER, "event", external_key)
            fingerprint = evidence_fingerprint(canonical_key, evidence)
            rejection = self.repository.get_resource_rejection(
                conn, matter["id"], canonical_key
            )
            if rejection and rejection["evidence_fingerprint"] == fingerprint:
                return {"status": "suppressed", "reason": "rejected_same_evidence"}
            provenance = {
                "reason": "calendar_event_ended",
                "evidence": evidence,
                "evidence_fingerprint": fingerprint,
                "ical_uid": ical_uid,
                "recurrence_id": recurrence_id,
                "occurrence_start_ms": occurrence_start_ms,
                "occurrence_end_ms": occurrence_end_ms,
                "matched_stakeholder_emails": list(matched_emails),
            }
            resource, _ = self._upsert_resource(
                conn,
                {
                    "provider": EMAIL_PROVIDER,
                    "kind": "event",
                    "external_key": external_key,
                    "title": title,
                    "metadata": {},
                },
                now,
            )
            live = self.repository.get_resource_link(
                conn, matter["id"], resource["id"], live_only=True
            )
            if live:
                return {"status": "already_linked"}
            deleted = self.repository.get_resource_link(conn, matter["id"], resource["id"])
            if deleted:
                conn.execute(
                    "UPDATE matter_resource SET added_by_kind='agent',added_by_id=NULL,"
                    "confidence=NULL,provenance_json=?,confirmed_at=NULL,deleted_at=NULL,"
                    "updated_at=? WHERE id=?",
                    (self._dump(provenance), now, deleted["id"]),
                )
                link_id = deleted["id"]
            else:
                link_id = self.repository.insert_resource_link(
                    conn,
                    {
                        "matter_id": matter["id"], "resource_id": resource["id"],
                        "relation_type": None, "pinned": 0,
                        "added_by_kind": "agent", "added_by_id": None,
                        "confidence": None,
                        "provenance_json": self._dump(provenance),
                        "confirmed_at": None, "sub_state": "none",
                        "created_at": now, "updated_at": now,
                    },
                )
            event_key = (
                f"matter:{matter['id']}:resource_linked:{resource['id']}:{fingerprint}"
            )
            if not self.repository.find_event(conn, event_key):
                self._append_event(
                    conn, matter_id=matter["id"], kind=RESOURCE_LINKED,
                    actor=Actor(kind="agent"), source="matter_followup",
                    dedupe_key=event_key, reason="calendar_event_ended",
                    resource_id=resource["id"],
                    payload={
                        "link_id": link_id, "suggested": True,
                        "evidence_fingerprint": fingerprint,
                        "title": truncated_text(resource.get("title")),
                        "resource_kind": resource.get("kind"),
                    },
                    happened_at=now,
                )
            if not self._cas_update(
                conn, matter["id"], int(matter["version"]),
                {"updated_at": now, "last_activity_at": now},
                scope=scope_from_resources([int(resource["id"])]),
            ):
                raise self._version_conflict()
            return {"status": "proposed", "link_id": link_id, "resource_id": int(resource["id"])}

    def list_resource_candidates(
        self, public_id: str, *, limit: int = RESOURCE_DISCOVERY_MAX_CANDIDATES
    ) -> dict[str, Any]:
        """「手动关联资料」入口用的**只读**候选（G-14 tab ①「与本事项相关」那一组）。

        这里**一个字都不写**（不建 link、不发事件、不推版本、不吃 backlog 配额），
        所以打开弹窗这个动作本身没有副作用。

        🔴 有意 **不接关键词**：候选引擎结构上要求 thread / 干系人硬锚，事项文档里的词只能
        加分、不能独自把一封邮件拉进来（见 `_email_resource_candidates`）。用户在弹窗里输入
        的关键词走的是另一条路 —— 前端的全局邮件搜索（FTS5），那条路本来就是「用户明说要
        搜什么」。

        🔴 task 08-25 起这是候选引擎 `_email_resource_candidates` 的**唯一**调用面（关键词
        命中式的资料推荐整条退役）。
        """
        limit = max(1, min(int(limit), RESOURCE_DISCOVERY_MAX_CANDIDATES))
        with self.repository.connect() as conn:
            matter = self._require_matter(conn, public_id)
            candidates, local_count = self._email_resource_candidates(
                conn, matter, limit=limit
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
        with self._transaction() as conn:
            replay = self._replay(conn, dedupe_key, event_kind)
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            link = self.repository.get_resource_link(conn, matter["id"], resource_id)
            if not link or (deleted and link["deleted_at"] is not None) or (not deleted and link["deleted_at"] is None):
                raise MatterError("E_CHILD_NOT_FOUND", f"resource link {resource_id} not found")
            resource = self.repository.get_resource(conn, resource_id) or {}
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                scope=scope_from_resources([resource_id]),
            )
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
            # v60 排序：核心组在前，组内按用户拖出来的 sort_order，id 兜底保稳定。
            # 🔴 `sort_order` 是**用户自定义显示顺序**，读侧不得再 `sorted()` 覆盖
            #    （同 `SYNC_FOLDERS` 数组序那条纪律）。前端也不许自己重排。
            return [dict(row) for row in conn.execute(
                f"SELECT * FROM matter_stakeholder WHERE {' AND '.join(clauses)} "
                "ORDER BY (tier='core') DESC, sort_order, id", params
            )]

    def reorder_stakeholders(
        self, public_id: str, items: Sequence[Mapping[str, Any]], *,
        expected_version: int, idempotency_key: str, source: str,
        actor: Actor = Actor(), reason: str | None = None,
        reverses_event_id: int | None = None,
    ) -> dict[str, Any]:
        """整批重排 / 换组（v60）——**一次拖拽 = 一个事务 = 一次 CAS**。

        🔴 为什么不是逐条 PATCH：一次拖拽同时改多行（被拖的那行 + 让位的所有行）。
        逐条发请求意味着第 2 个必定撞版本冲突 —— 那正是 `matterMutation.ts` 文件头
        描述的 0812 dogfood P0 的形状（「不管点哪个都是 matter version changed」）。

        `items` 是**全量目标顺序**的一段，每项 `{id, tier?, sort_order}`。
        没被列到的干系人不动（前端只发受影响的那些也成立）。
        """
        now = self.clock_ms()
        dedupe_key = self._dedupe(idempotency_key)
        with self._transaction() as conn:
            replay = self._replay(conn, dedupe_key, "stakeholder_updated")
            if replay:
                return replay
            matter = self._require_matter(conn, public_id)
            rows = {
                int(row["id"]): dict(row)
                for row in conn.execute(
                    "SELECT * FROM matter_stakeholder WHERE matter_id=? AND deleted_at IS NULL",
                    (matter["id"],),
                )
            }
            touched: list[int] = []
            for entry in items:
                if not isinstance(entry, Mapping):
                    raise MatterError("E_INVALID_ARG", "each reorder item must be an object")
                raw_id = entry.get("id")
                if isinstance(raw_id, bool) or not isinstance(raw_id, int):
                    raise MatterError("E_INVALID_ARG", "reorder item id must be an integer")
                if raw_id not in rows:
                    # 🔴 不属于本事项 / 已软删 → 硬拒整批。放过它等于让调用方以为整批成了，
                    #    而实际顺序与它手里那份不一致 —— 下一次拖拽会基于错的基线再算一次。
                    raise MatterError(
                        "E_CHILD_NOT_FOUND", f"stakeholder {raw_id} not found in this matter"
                    )
                raw_order = entry.get("sort_order")
                if isinstance(raw_order, bool) or not isinstance(raw_order, int):
                    raise MatterError(
                        "E_INVALID_ARG", "reorder item sort_order must be an integer"
                    )
                changes: dict[str, Any] = {"sort_order": int(raw_order), "updated_at": now}
                if "tier" in entry:
                    changes["tier"] = self._require_tier(entry.get("tier"))
                assignments = ", ".join(f"{key}=?" for key in changes)
                conn.execute(
                    f"UPDATE matter_stakeholder SET {assignments} WHERE id=?",
                    (*changes.values(), raw_id),
                )
                touched.append(raw_id)
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 重排只碰这些干系人行 —— 提案结构上碰不到干系人，故不作废任何提案；
                # stale base 也只在**同一批行**被并发改过时才算真冲突（auto-rebase）。
                scope=scope_from_stakeholders(touched),
            )
            self._append_event(
                conn, matter_id=matter["id"], kind="stakeholder_updated", actor=actor,
                source=source, dedupe_key=dedupe_key,
                payload={"reordered_stakeholder_ids": touched},
                happened_at=now, reason=reason, reverses_event_id=reverses_event_id,
            )
            refreshed = self.repository.get_matter_by_id(conn, matter["id"])
            return {"matter": refreshed, "reordered": touched}

    # ---- W-C 全局干系人库（dogfood 轮 2）----------------------------------
    # 基本信息（姓名/邮箱/组织）全局一份（v54 起 = 通讯录 contact/contact_email，
    # task 08-13；身份 = 归一 email 锚点）；
    # 角色/等待/备注仍归各事项的 matter_stakeholder 行。库是**隐式维护**的：
    # 添加/编辑干系人时 upsert 写穿（写侧单源在 `src/contacts/service.py`）。
    # 读侧（池查询 `list_contacts` / 一键邮件提取 `extract_contact_candidates`）
    # 已随通讯录 WP3 退役 —— picker 直接读 `/api/contacts`。

    def _upsert_contact(
        self, conn: sqlite3.Connection, *, email: str,
        display_name: str | None = None, organization: str | None = None, now: int,
        fallback_display_name: str | None = None, fallback_organization: str | None = None,
    ) -> int:
        """按归一 email upsert 全局联系人，返回 contact_id。

        v54 起全局库 = 通讯录三表（contact / contact_email，task 08-13），写侧
        单源在 `src/contacts/service.py::upsert_contact_for_email` —— 本方法只是
        保住 matters 内既有调用点的薄包装。语义与 v52 逐语义一致：提供的非空
        姓名/组织 = 最后写者赢（全局一份：改名就是全局改名）；传 None = 不动
        既有值；`fallback_*` 只在**新建**这条联系人时顶上（目标邮箱可能已经是
        另一个人，拿本行的名字盖上去 = 悄悄把别人改名了 —— 红字原样继承）。
        升级点：按 `contact_email` 锚点找人 ⇒ 一人多邮箱下也命中同一人。"""
        return upsert_contact_for_email(
            conn, email=email, now=now,
            display_name=display_name, organization=organization,
            fallback_display_name=fallback_display_name,
            fallback_organization=fallback_organization,
        )

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
        with self._transaction() as conn:
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
                    "tier": self._require_tier(data.get("tier")),
                    # 新人排到**同组末尾**：拿本事项当前最大 sort_order + 1。跨组统一编号
                    # （不 per-tier 重置）——「拖到另一组」只需改 tier 一列，不必重排整组。
                    "sort_order": self._next_stakeholder_sort_order(conn, matter["id"]),
                    "last_contact_at": self._require_epoch_ms("last_contact_at", data.get("last_contact_at")),
                    "source_resource_id": data.get("source_resource_id"),
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
                        "SELECT display_name, organization FROM contact WHERE id=?",
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
                # 🔴 `sort_order` **有意不在**逐条白名单里：一次拖拽会同时改多行（被拖的那行
                # + 让位的所有行），逐条 PATCH 意味着一次拖拽发 N 个带 expectedVersion 的
                # 请求，第 2 个必定撞版本冲突。整批走 `reorder_stakeholders`。
                allowed = {"display_name", "organization", "role", "relationship", "is_waiting_on", "tier", "last_contact_at", "source_resource_id", "deleted_at"}
                changes = {key: value for key, value in data.items() if key in allowed}
                if "tier" in changes:
                    changes["tier"] = self._require_tier(changes["tier"])
                if "last_contact_at" in changes:
                    changes["last_contact_at"] = self._require_epoch_ms(
                        "last_contact_at", changes["last_contact_at"]
                    )
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
                    # 只改邮箱、没同时改名时用本行现有的姓名/组织兜底 —— 否则库里会凭空
                    # 多出一条裸邮箱联系人（create 路径本来就回填，两条路不该不对称）。
                    # 兜底只在**新建**那条联系人时生效，见 `_upsert_contact` 的红字。
                    contact_id = self._upsert_contact(
                        conn, email=contact_email,
                        display_name=touched_name, organization=touched_org, now=now,
                        fallback_display_name=self._optional_text(
                            (existing or {}).get("display_name")
                        ),
                        fallback_organization=self._optional_text(
                            (existing or {}).get("organization")
                        ),
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
                    # 顺带被清掉 waiting 指针的 item 也算本次写入的目标（进账本 scope）。
                    unwaited_item_ids = [
                        int(row[0])
                        for row in conn.execute(
                            "SELECT id FROM matter_item WHERE matter_id=? AND waiting_on_stakeholder_id=?",
                            (matter["id"], stakeholder_id),
                        )
                    ]
                    conn.execute(
                        "UPDATE matter_item SET waiting_on_stakeholder_id=NULL, updated_at=?, version=version+1 "
                        "WHERE matter_id=? AND waiting_on_stakeholder_id=?",
                        (now, matter["id"], stakeholder_id),
                    )
                    write_scope = MatterWriteScope(
                        item_ids=frozenset(unwaited_item_ids),
                        stakeholder_ids=frozenset({int(stakeholder_id)}),
                    )
                else:
                    write_scope = scope_from_stakeholders([stakeholder_id])
            if existing is None:
                # 新增干系人：纯追加（提案结构上碰不到干系人 —— 不作废任何提案，
                # stale base 也不构成冲突）。此前缺省 scope=None ≙ 触及一切，一次
                # 加人就把待审提案全部作废，与 create_item 的「纯追加」判据不一致。
                write_scope = SCOPE_NOTHING
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                scope=write_scope,
            )
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
        with self._transaction() as conn:
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
            self._cas_update_rebase(
                conn,
                source_matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                # 新建关系：纯追加（提案结构上碰不到关系）。
                scope=SCOPE_NOTHING,
            )
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
        with self._transaction() as conn:
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
            self._cas_update_rebase(
                conn,
                matter,
                expected_version,
                {"updated_at": now, "last_activity_at": now},
                scope=scope_from_relations([relation_id]),
            )
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
                            "change_count": len(update["changes"] or []),
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
        """拒绝提案：不应用、留档 reason、version 照 bump（REST #3）、无 undo。stale 行可拒。"""
        reason_text = self._optional_text(reason)
        if not reason_text:
            raise MatterError("E_INVALID_ARG", "reject reason is required")
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
                # A3 backstop：提案里的 due_at 同样可能是 agent 写的 epoch 秒
                #（propose 侧已 fail-closed 剔除，这里防旧存量/直连 REST）。
                direct_changes["due_at"] = self._require_epoch_ms("due_at", value)
            elif field == "waiting_context":
                direct_changes["waiting_context_json"] = (
                    self._dump(value) if value is not None else None
                )
            elif field in ("background", "goal"):
                # S3：背景与目标（v61 起两个独立字段）。owner 在评审界面看到全文 diff 后
                # 才会 accept ——「Agent 只能提案、owner 拍板」这条约束在**评审**这一步
                # 兑现，而不是靠让字段不可写。
                direct_changes[field] = str(value or "")
            elif field == "goal_checks":
                # S3：完成标志。归一走与 patch 路径**同一个**函数 —— 提案里带非法形状
                # （超 20 条 / 超 200 字 / 非对象）时在这里也必须炸，不能因为「是提案
                # 来的」就绕过护栏。propose 侧已先 drop 一轮，这里是 backstop。
                # 🔴 ValueError → MatterError 与 patch 路径同款包装：不包的话 REST 的
                # `_call` 只认 MatterError，护栏会以 500 而不是 400 的形态漏出去。
                try:
                    direct_changes["goal_checks_json"] = self._dump(
                        list(normalize_goal_checks(value))
                    )
                except ValueError as exc:
                    raise MatterError(
                        "E_INVALID_ARG", f"change {change_id}: {exc}"
                    ) from exc
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
            for ts_field in ("due_at", "completed_at"):
                if ts_field in item_patch:
                    item_patch[ts_field] = self._require_epoch_ms(
                        ts_field, item_patch[ts_field]
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
        summary = self._resource_summary_fields(conn, provider, kind, external_key, data, now)
        return self.repository.upsert_resource(conn, {
            "kind": kind, "provider": provider, "external_key": external_key,
            "canonical_url": self._optional_text(data.get("canonical_url")), "title": self._optional_text(data.get("title")),
            "metadata_json": self._dump(data.get("metadata") or {}),
            "sum": summary["sum"], "sum_src": summary["sum_src"], "sum_at": summary["sum_at"],
            "revision": data.get("revision"),
            "content_hash": data.get("content_hash"), "permission_state": data.get("permission_state"),
            "sync_state": data.get("sync_state"), "access_policy": data.get("access_policy") or "allowed",
            "last_checked_at": data.get("last_checked_at"), "created_at": now, "updated_at": now,
        })

    def _resource_summary_fields(
        self,
        conn: sqlite3.Connection,
        provider: str,
        kind: str,
        external_key: str,
        data: Mapping[str, Any],
        now: int,
    ) -> dict[str, Any]:
        """产出 upsert 值集里的 ``sum`` / ``sum_src`` / ``sum_at`` 三键（v56，H3§6 三类来源）。

        - **mailagent 的 email/thread：恒从邮件侧已有摘要带入**（``sum_src='mail'``，零模型
          调用；调用方带的 ``sum`` 一律忽略 —— 设计红线「邮件类不重新生成」在唯一身份写侧
          强制）。email 取该封的 ``ai_summary``；thread 取线程内**最新一封**带摘要邮件的
          （= 最新一次会话摘要）。``ai_summary`` 为空（LLM 未开 / 失败 / 积压）→ 三键 NULL
          走空态，**不合成、不回退主题+正文**（owner 拍板 + H3 自己的「不得编造」）。
          🔴 邮件类资料没有 excerpt（`cached_excerpt` 只有 URL 抓取路径写），所以在 H3
          「摘要只允许来自缓存摘录与元数据」的约束下，复用邮件自带摘要不是优化，是邮件
          摘要**唯一可行来源** —— 后人别试图退回「从正文生成」。
        - **其余 provider**：吃调用方显式给的 ``sum``（Agent 发现资料的落库通道；批 M6 把
          提案 schema 的 ``summary`` 接到这里）。``sum_src`` 必须在值域内、缺省 'agent'；
          ``sum_at`` 缺省取本次写入时刻。手动关联的外部文档不带 ``sum`` → 空态，等下次
          跟进 run 生成（H3§6.3）。
        - **「仅元数据」不生成**：incoming ``access_policy='metadata_only'`` → 三键 NULL
          （既有行已是 metadata_only 的情形由 repository 更新面同判据挡）。

        邮件侧推导失败只降级不阻断 —— 摘要是增强信息，绝不让关联事务因它掀掉。
        """
        empty = {"sum": None, "sum_src": None, "sum_at": None}
        if (data.get("access_policy") or "allowed") == "metadata_only":
            return empty
        if provider == EMAIL_PROVIDER and kind in ("email", "thread"):
            try:
                return self._mail_summary_fields(conn, kind, external_key, now) or empty
            except (sqlite3.OperationalError, ValueError) as exc:
                logger.warning(
                    f"[matters] mail summary lookup failed for {external_key}: {exc}"
                )
                return empty
        raw = data.get("sum")
        text = str(raw).strip()[:MATTER_RESOURCE_SUMMARY_MAX_CHARS] if raw is not None else ""
        if not text:
            return empty
        src = str(data.get("sum_src") or MatterResourceSummarySource.AGENT.value)
        self._require_value("sum_src", src, MATTER_RESOURCE_SUMMARY_SOURCES)
        sum_at = self._require_epoch_ms("sum_at", data.get("sum_at")) or now
        return {"sum": text, "sum_src": src, "sum_at": sum_at}

    def _mail_summary_fields(
        self, conn: sqlite3.Connection, kind: str, external_key: str, now: int
    ) -> dict[str, Any] | None:
        """从 ``llm_processing.labels_json.$.ai_summary`` 取邮件自带摘要（同库查询）。

        ``external_key`` 进来时已经 ``normalize_resource_key`` 归一（``email:<id>`` /
        ``thread:<tid>``），直接按前缀拆。``sum_at`` 取 llm 行的 ``updated_at``（REAL 秒
        → epoch ms，= 摘要真实生成时刻，不是关联时刻）。
        """
        identifier = external_key.partition(":")[2]
        if kind == "email":
            row = conn.execute(
                "SELECT json_extract(labels_json,'$.ai_summary') AS ai_summary, updated_at "
                "FROM llm_processing WHERE internal_id=?",
                (int(identifier),),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT json_extract(lp.labels_json,'$.ai_summary') AS ai_summary, "
                "lp.updated_at FROM email_metadata em "
                "JOIN llm_processing lp ON lp.internal_id=em.internal_id "
                "WHERE em.thread_id=? AND json_extract(lp.labels_json,'$.ai_summary') <> '' "
                "ORDER BY em.date_received DESC, em.internal_id DESC LIMIT 1",
                (identifier,),
            ).fetchone()
        summary = str(row["ai_summary"]).strip() if row and row["ai_summary"] else ""
        if not summary:
            return None
        sum_at = int(float(row["updated_at"]) * 1000) if row["updated_at"] else now
        return {
            "sum": summary[:MATTER_RESOURCE_SUMMARY_MAX_CHARS],
            "sum_src": MatterResourceSummarySource.MAIL.value,
            "sum_at": sum_at,
        }

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
        self, conn: sqlite3.Connection, matter: Mapping[str, Any], *, limit: int,
    ) -> tuple[list[dict[str, Any]], int]:
        """本事项的邮件候选：**只走 durable 硬锚**（同线程 / 干系人），事项文档里的词只加分。

        task 08-25（owner 0825「置信度非常低，反而徒增烦恼」）：关键词命中式召回与它的外扩
        通道（`query` / `expand_reason` / 权重表 / 准入权重）整条退役。资料关联的推荐现在只
        有 LLM 判断那两条路 —— 跟进 run 提案里的 `resource` change、事项对话里 agent 自己检索
        后 `matter_resource_mutate`。这里留下的是「与本事项**结构上**相连的邮件」，供 owner
        在关联弹窗里手动挑。
        """
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
        # 🔴 事项文档里的词**只加分**，永远不能独自把一封邮件拉进来（0812 修法 3）。
        # 那次的病灶是把事项散文当检索条件：事项描述里一句「未见邮件记录」，把标题带
        # 「已撤回邮件」的撤回通知拉了进来。入选判据只认 durable 硬锚（同线程 / 干系人）。
        boost_terms = self._semantic_terms(matter_text)
        rows = conn.execute(
            "SELECT internal_id,message_id,thread_id,subject,sender,sender_name,to_addr,cc_addr,"
            "date_received,snippet FROM email_metadata ORDER BY date_received DESC,internal_id DESC LIMIT ?",
            (RESOURCE_DISCOVERY_SCAN_LIMIT,),
        ).fetchall()
        # DF 语料 = 上面那批行本身，逐行的词集顺手缓存。全表扫描算词频是明令禁止的。
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

        def build_candidate(row: sqlite3.Row) -> dict[str, Any] | None:
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
            matched_terms = sorted(boost_terms & row_terms[int(row["internal_id"])])
            if matched_terms:
                evidence.extend(f"keyword:{term}" for term in matched_terms[:8])
            boost_weight = sum(
                1 for term in matched_terms if term_tier(term) != "common"
            )
            if boost_weight:
                score += min(0.06, 0.02 * boost_weight)
            # 🔴 durable 硬锚是**入选**的唯一判据：加分词再多也进不来。
            if not any(
                item.startswith(("thread:", "stakeholder:")) for item in evidence
            ):
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
                # 只剩这一档了，但字段留着：它是候选行的线上契约（前端关联弹窗按它分组），
                # 去掉等于让一个不相干的批次去改前端。
                "scope": "local",
                "reason": "；".join(reason_parts),
                "evidence": sorted(set(evidence)),
                "confidence": round(min(score, 0.98), 3),
            }

        # 扫描行本身按 date_received DESC 排，sort 稳定 ⇒ 同分内部仍是「新的在前」。
        # 🔴 有意**不按线程折叠**：候选全部来自已关联线程，那条线程的每一封新邮件都是用户
        # 要看的（「同线程还有 5 封新回复」只报 1 封才是 bug）。
        local = [candidate for row in rows if (candidate := build_candidate(row))]
        local.sort(key=lambda item: -item["confidence"])
        return local[:limit], len(local)

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
    def _resource_tracks_versions(resource: Mapping[str, Any]) -> bool:
        """这份资料**会不会**有版本轨迹（v57，H3§5.4）。

        判据 = 它是不是 URL 抓取路径够得着的那一类 —— `resource.revision` /
        `content_hash` / `last_checked_at` 全仓唯一写者就是 `fetch_url_resource`，而它
        只服务 `kind='url'`。email / thread / doc / file 那三列结构上恒 NULL。

        🔴 这是「还没有版本记录」与「这类资料压根不跟踪版本」的分界，前端据此选空态
        文案 —— 两种空态用同一句含糊的「暂无记录」，会让人以为文档类资料只是还没检出过。
        """
        return resource.get("kind") == "url"

    @staticmethod
    def _validate_url_fetch_resource(
        resource: Mapping[str, Any] | None, link: Mapping[str, Any] | None
    ) -> None:
        if resource is None or link is None:
            raise MatterError("E_CHILD_NOT_FOUND", "linked resource not found")
        if not MatterService._resource_tracks_versions(resource):
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
    def _require_tier(value: Any) -> str:
        """干系人档位校验（v60）。None / 缺省 → `normal`。

        🔴 非法值**报错**而不是静默落 `normal`：这个字段决定「折不折叠」，
        静默降档会让 owner 以为标了核心、结果那个人藏在折叠区里。
        """
        if value is None:
            return str(MATTER_STAKEHOLDER_DEFAULT_TIER)
        tier = str(value).strip()
        if tier not in MATTER_STAKEHOLDER_TIERS:
            raise MatterError(
                "E_INVALID_ARG",
                f"tier must be one of {', '.join(MATTER_STAKEHOLDER_TIERS)}",
            )
        return tier

    @staticmethod
    def _next_stakeholder_sort_order(conn: sqlite3.Connection, matter_id: int) -> int:
        """本事项当前最大 sort_order + 1（空表 → 0）。含已软删的行，避免删一个再加一个时撞号。"""
        row = conn.execute(
            "SELECT MAX(sort_order) AS top FROM matter_stakeholder WHERE matter_id=?",
            (matter_id,),
        ).fetchone()
        top = row["top"] if row and row["top"] is not None else None
        return 0 if top is None else int(top) + 1

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
