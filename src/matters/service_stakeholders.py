"""Matter stakeholders, contact write-through, and relations mixin for MatterService."""

from __future__ import annotations

import json
import sqlite3
from typing import Any, Mapping, Sequence

from src.contacts.service import upsert_contact_for_email

from .event_changes import STAKEHOLDER_CHANGE_FIELDS, build_changes, truncated_text
from .events import RELATION_ADDED
from .models import (
    MATTER_RELATION_TYPES,
    MATTER_STAKEHOLDER_DEFAULT_TIER,
    MATTER_STAKEHOLDER_TIERS,
    person_key_for_email,
)
from .proposal_scope import (
    SCOPE_NOTHING,
    MatterWriteScope,
    scope_from_relations,
    scope_from_stakeholders,
)
from .resource_identity import MatterError
from .service_common import Actor


class _MatterStakeholderMixin:
    """Stakeholder directory sync and matter-relation methods for MatterService."""

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
