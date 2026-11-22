"""Matter resource linking, URL cache, and discovery mixin for MatterService."""

from __future__ import annotations

import re
import sqlite3
from typing import Any, Mapping, Sequence

from loguru import logger

from .event_changes import truncated_text
from .events import (
    RESOURCE_LINKED,
    RESOURCE_SUGGESTION_ACCEPTED,
    RESOURCE_SUGGESTION_REJECTED,
)
from .models import (
    MATTER_ACCESS_POLICIES,
    MATTER_RESOURCE_KINDS,
    MATTER_RESOURCE_SUBSCRIPTION_STATES,
    MATTER_RESOURCE_SUMMARY_MAX_CHARS,
    MATTER_RESOURCE_SUMMARY_SOURCES,
    MATTER_SUGGESTION_BULK_ACTIONS,
    MATTER_SUGGESTION_BULK_MAX,
    MatterResourceSummarySource,
    MatterSuggestionBulkAction,
    MatterSuggestionBulkSkipReason,
)
from .proposal_scope import scope_from_resources
from .resource_identity import (
    EMAIL_PROVIDER,
    MatterError,
    attachment_resource_key,
    email_resource_key,
    event_resource_key,
    evidence_fingerprint,
    library_resource_content,
    normalize_resource_key,
    rejection_resource_key,
    thread_resource_key,
)
from .service_common import Actor
from .url_fetch import (
    URL_CACHE_METADATA_KEY,
    URL_CACHE_TEXT_KEY,
    cached_url_text,
    content_hash,
    describe_url_cache,
)

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


class _MatterResourceMixin:
    """Resource linking, suggestion resolution, and discovery methods for MatterService."""

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

    @classmethod
    def _bulk_suggestion_result(
        cls,
        matter: dict[str, Any] | None,
        event_ids: list[int],
        action: str,
        applied: list[int],
        skipped: list[dict[str, Any]],
    ) -> dict[str, Any]:
        return cls._mutation(
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
        data = self._with_library_content(provider, kind, external_key, data)
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

    def _with_library_content(
        self, provider: str, kind: str, external_key: str, data: Mapping[str, Any]
    ) -> Mapping[str, Any]:
        """资料库文件的摘要与摘录**由服务端填**（design §9.2），不让模型编。

        - ``sum``：调用方（含跟进 run 的提案）给了就用它 —— ``sum_src='agent'`` 语义不变；
          没给才落 frontmatter 的 summary / description，再缺才取抽取文本首 300 字。
        - ``metadata.cached_excerpt``：抽取文本前 2000 字，只 ``setdefault``（调用方带了
          自己的摘录不覆盖）。填进去之后这份库文件**自然**进 ``context_snapshot`` 的资料
          投影 —— 那里已经在读 ``cached_excerpt`` 并套 ``UNTRUSTED_MATTER_EXCERPT`` 围栏，
          所以本改动零新增注入路径。

        ``access_policy='metadata_only'`` 整段跳过：那一档的语义就是不外露内容
        （``_resource_summary_fields`` 对 ``sum`` 已同判据，这里补上摘录那半边）。
        """
        if provider != EMAIL_PROVIDER or kind != "file":
            return data
        if (data.get("access_policy") or "allowed") == "metadata_only":
            return data
        default_sum, excerpt = library_resource_content(external_key)
        if default_sum is None and excerpt is None:
            return data
        values = dict(data)
        if default_sum and not str(values.get("sum") or "").strip():
            values["sum"] = default_sum
            values["sum_src"] = MatterResourceSummarySource.AGENT.value
        if excerpt:
            metadata = dict(values.get("metadata") or {})
            metadata.setdefault(URL_CACHE_TEXT_KEY, excerpt)
            values["metadata"] = metadata
        return values

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

    @classmethod
    def _validate_url_fetch_resource(
        cls,
        resource: Mapping[str, Any] | None, link: Mapping[str, Any] | None
    ) -> None:
        if resource is None or link is None:
            raise MatterError("E_CHILD_NOT_FOUND", "linked resource not found")
        if not cls._resource_tracks_versions(resource):
            raise MatterError("E_INVALID_STATE", "readable fetch is only supported for URL resources")
        if resource.get("access_policy") != "allowed":
            raise MatterError("E_INVALID_STATE", "URL resource content access is not allowed")
        if not str(resource.get("canonical_url") or "").strip():
            raise MatterError("E_INVALID_STATE", "URL resource has no canonical_url")
